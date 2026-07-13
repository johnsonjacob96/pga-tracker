// Cloudflare Pages Function: parse a draft screenshot into rosters.
//
// POST /api/parse-draft   { image: <base64, no data: prefix>, mediaType: "image/jpeg" }
// Header: x-draft-key must match the DRAFT_KEY secret.
//
// Flow: Claude (vision + structured output) reads the screenshot → owner/team
// identifiers + 5 golfer names each → server validates every name against the
// live 156-man field from the R&A feed and maps identifiers to the league's
// owner/team-alias pairs from data/2026-season.json. The client gets back a
// fully-resolved grid plus the field list for manual fixes.
//
// Secrets (wrangler pages secret put <NAME> --project-name=locksoftheday):
//   DRAFT_KEY          shared passphrase gating this endpoint
//   ANTHROPIC_API_KEY  Claude API key for the vision call

const RANDA_FEED = "https://scoring.theopen.com/scoring?feedType=traditional";

const norm = (s) =>
  s.normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o").replace(/Ø/g, "O")
    .replace(/[.\s'-]/g, "")
    .toLowerCase();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const key = request.headers.get("x-draft-key") || "";
  if (!env.DRAFT_KEY || key !== env.DRAFT_KEY) {
    return json({ error: "Bad or missing draft key." }, 401);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY secret not configured on the Pages project." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON with { image, mediaType }." }, 400);
  }
  const { image, mediaType } = body || {};
  if (!image || !mediaType) {
    return json({ error: "Missing image or mediaType." }, 400);
  }

  // 1. Live field from the R&A (authoritative player-name list).
  const feedRes = await fetch(RANDA_FEED, {
    cf: { cacheTtl: 300, cacheEverything: true },
    headers: { accept: "application/json", "user-agent": "pga-tracker/1.0" },
  });
  if (!feedRes.ok) return json({ error: `R&A feed returned ${feedRes.status}` }, 502);
  const feed = await feedRes.json();
  const field = (feed.players || [])
    .map((p) => `${p.firstName || ""} ${p.lastName || ""}`.trim())
    .filter(Boolean);

  // 2. Owner ↔ team-alias map from the deployed season data.
  const seasonRes = await env.ASSETS.fetch(new URL("/data/2026-season.json", request.url));
  const season = await seasonRes.json();
  const owners = season.owners || {};   // owner → team alias

  // 3. Claude vision call — structured output pinned to a strict schema.
  const schema = {
    type: "object",
    properties: {
      rosters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            identifier: {
              type: "string",
              description: "The owner or team name exactly as written in the image",
            },
            players: {
              type: "array",
              items: { type: "string" },
              description: "The golfers drafted by this owner, in draft order, full names",
            },
          },
          required: ["identifier", "players"],
          additionalProperties: false,
        },
      },
      notes: {
        type: "string",
        description: "Anything ambiguous or unreadable in the image; empty string if none",
      },
    },
    required: ["rosters", "notes"],
    additionalProperties: false,
  };

  const prompt = `This image shows a fantasy golf draft for The Open Championship (a group text, spreadsheet, whiteboard, or notes screenshot). Nine friends each drafted exactly 5 golfers.

The owners and their team aliases are:
${Object.entries(owners).map(([o, t]) => `- ${o} (team "${t}")`).join("\n")}

The tournament field (the only valid golfer names — map any nickname, misspelling, or shorthand in the image to the closest of these):
${field.join(", ")}

Extract every owner/team and their 5 drafted golfers. Use the identifier exactly as written in the image; write golfer names as full names from the field list above. If a golfer in the image is not in the field list, output the name as written so it can be flagged. Note anything unreadable in "notes".`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return json({ error: `Claude API ${anthropicRes.status}`, detail: errText.slice(0, 500) }, 502);
  }
  const message = await anthropicRes.json();
  if (message.stop_reason === "refusal") {
    return json({ error: "Claude declined to read this image." }, 502);
  }
  const textBlock = (message.content || []).find((b) => b.type === "text");
  if (!textBlock) return json({ error: "No text in Claude response." }, 502);

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return json({ error: "Claude response was not valid JSON.", raw: textBlock.text.slice(0, 500) }, 502);
  }

  // 4. Server-side resolution: identifiers → owner/alias, players → field names.
  const fieldByNorm = {};
  const fieldByLast = {};
  for (const name of field) {
    fieldByNorm[norm(name)] = name;
    const last = norm(name.split(" ").slice(1).join(" ") || name);
    (fieldByLast[last] = fieldByLast[last] || []).push(name);
  }

  const identByNorm = {};
  for (const [owner, team] of Object.entries(owners)) {
    identByNorm[norm(owner)] = { owner, team };
    identByNorm[norm(team)] = { owner, team };
  }

  const rosters = (parsed.rosters || []).map((r) => {
    const ident = identByNorm[norm(r.identifier || "")] || null;
    const players = (r.players || []).map((name) => {
      const n = norm(name);
      if (fieldByNorm[n]) return { input: name, matched: fieldByNorm[n], status: "exact" };
      // last-name-only fallback, unique matches only
      const lastCandidates = fieldByLast[n] || [];
      if (lastCandidates.length === 1) {
        return { input: name, matched: lastCandidates[0], status: "fuzzy" };
      }
      // substring fallback (e.g. "Rory" → unique first-name hit)
      const subs = field.filter((f) => norm(f).includes(n) && n.length >= 4);
      if (subs.length === 1) return { input: name, matched: subs[0], status: "fuzzy" };
      return { input: name, matched: null, status: "unmatched" };
    });
    return {
      identifier: r.identifier,
      owner: ident?.owner || null,
      teamName: ident?.team || null,
      players,
    };
  });

  return json({
    rosters,
    notes: parsed.notes || "",
    field,
    owners,
  });
}
