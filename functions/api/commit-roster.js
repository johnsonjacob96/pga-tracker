// Cloudflare Pages Function: publish a confirmed roster into the repo.
//
// POST /api/commit-roster
//   { eventName: "Open Championship", roster: { "<teamAlias>": [5 full names], ... } }
// Header: x-draft-key must match the DRAFT_KEY secret.
//
// Writes roster + auto-generated shortNames into the named event inside
// data/2026-season.json via the GitHub contents API, which triggers both the
// GitHub Pages and Cloudflare Pages deploys. The tracker's index page flips
// to live mode on its own once the data lands.
//
// Secrets: DRAFT_KEY (same gate as parse-draft), GITHUB_TOKEN (repo scope).

const REPO = "johnsonjacob96/pga-tracker";
const FILE_PATH = "data/2026-season.json";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Display names: last name only, disambiguated with a first initial when two
// drafted players share a surname (A. Fitzpatrick / M. Fitzpatrick).
function buildShortNames(roster) {
  const all = Object.values(roster).flat();
  const lastCount = {};
  for (const name of all) {
    const last = name.split(" ").slice(1).join(" ") || name;
    lastCount[last] = (lastCount[last] || 0) + 1;
  }
  const short = {};
  for (const name of all) {
    const parts = name.split(" ");
    const first = parts[0];
    const last = parts.slice(1).join(" ") || name;
    short[name] = lastCount[last] > 1 ? `${first[0]}. ${last}` : last;
  }
  return short;
}

// UTF-8-safe base64 helpers (atob/btoa alone mangle diacritics like Åberg).
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const key = request.headers.get("x-draft-key") || "";
  if (!env.DRAFT_KEY || key !== env.DRAFT_KEY) {
    return json({ error: "Bad or missing draft key." }, 401);
  }
  if (!env.GITHUB_TOKEN) {
    return json({ error: "GITHUB_TOKEN secret not configured on the Pages project." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON with { eventName, roster }." }, 400);
  }
  const { eventName, roster } = body || {};
  if (!eventName || !roster || typeof roster !== "object") {
    return json({ error: "Missing eventName or roster." }, 400);
  }

  // Validate shape: each team exactly 5 players, no duplicates across teams.
  const seen = new Set();
  for (const [team, players] of Object.entries(roster)) {
    if (!Array.isArray(players) || players.length !== 5) {
      return json({ error: `Team ${team} must have exactly 5 players.` }, 400);
    }
    for (const p of players) {
      if (seen.has(p)) return json({ error: `${p} appears on more than one team.` }, 400);
      seen.add(p);
    }
  }

  const gh = (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "pga-tracker-draft-importer",
        ...(init.headers || {}),
      },
    });

  // Read current season.json (need content + blob sha for the update).
  const getRes = await gh(`/repos/${REPO}/contents/${FILE_PATH}`);
  if (!getRes.ok) return json({ error: `GitHub read failed: ${getRes.status}` }, 502);
  const file = await getRes.json();
  const season = JSON.parse(b64decodeUtf8(file.content));

  const ev = (season.events || []).find((e) => e.name === eventName);
  if (!ev) return json({ error: `Event "${eventName}" not found in season data.` }, 400);
  if (ev.complete) return json({ error: `Event "${eventName}" is already complete.` }, 400);

  // Roster teams must match the league's team aliases exactly.
  const validTeams = new Set(Object.values(season.owners || {}));
  for (const team of Object.keys(roster)) {
    if (!validTeams.has(team)) return json({ error: `Unknown team alias "${team}".` }, 400);
  }
  if (Object.keys(roster).length !== validTeams.size) {
    return json({ error: `Expected ${validTeams.size} teams, got ${Object.keys(roster).length}.` }, 400);
  }

  ev.roster = roster;
  ev.shortNames = buildShortNames(roster);

  const putRes = await gh(`/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `${eventName}: draft rosters via screenshot importer`,
      content: b64encodeUtf8(JSON.stringify(season, null, 2) + "\n"),
      sha: file.sha,
    }),
  });
  if (!putRes.ok) {
    const detail = await putRes.text();
    return json({ error: `GitHub write failed: ${putRes.status}`, detail: detail.slice(0, 300) }, 502);
  }
  const commit = await putRes.json();

  return json({
    ok: true,
    commit: commit.commit?.sha,
    commitUrl: commit.commit?.html_url,
    shortNames: ev.shortNames,
  });
}
