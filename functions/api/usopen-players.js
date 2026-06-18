// Cloudflare Pages Function: batch-fetch per-player scorecards from USGA.
// The leaderboard.json endpoint carries round totals only; hole-by-hole lives at
// ace-api.usga.org/scoring/v1/player/{id}.json. Our 9 teams cap at ~45 unique
// roster players, so a single batched proxy round-trip is cheap.
//
// Route:   /api/usopen-players?year=2026&ids=27644,55893,...
// Returns: { fetchedAt, source, players: { "27644": <usga player payload>, ... }, errors: {...} }

const PLAYER_URL = (id, year, champ) =>
  `https://ace-api.usga.org/scoring/v1/player/${encodeURIComponent(id)}.json?championship=${encodeURIComponent(champ)}&championship-year=${encodeURIComponent(year)}`;

const CACHE_SECONDS = 30;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const year = url.searchParams.get("year") || new Date().getUTCFullYear().toString();
  const championship = url.searchParams.get("championship") || "uso";
  const idsRaw = (url.searchParams.get("ids") || "").trim();
  const ids = idsRaw
    .split(",")
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .slice(0, 80); // safety cap

  if (ids.length === 0) {
    return json({ error: "no valid ids provided" }, 400);
  }

  const headers = {
    accept: "application/json",
    "user-agent": "pga-tracker/1.0 (+github.com/johnsonjacob96/pga-tracker)",
    // USGA's ace-api is fronted by Azure API Management. The same public
    // subscription key is embedded in usopen.com's bundle; without it the
    // origin returns 401 for most player IDs, even though some flow through
    // an upstream cache.
    "ocp-apim-subscription-key": "0f679e1117d348d6b586d4888ea13559",
  };

  const fetchOne = async (id) => {
    try {
      const r = await fetch(PLAYER_URL(id, year, championship), {
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
        headers,
      });
      if (!r.ok) return { id, error: `upstream ${r.status}` };
      return { id, payload: await r.json() };
    } catch (e) {
      return { id, error: String(e?.message || e) };
    }
  };

  const results = await Promise.all(ids.map(fetchOne));

  const players = {};
  const errors = {};
  for (const r of results) {
    if (r.payload) players[r.id] = r.payload;
    else if (r.error) errors[r.id] = r.error;
  }

  return json(
    {
      fetchedAt: new Date().toISOString(),
      source: "usga:ace-api/player batch",
      requested: ids.length,
      delivered: Object.keys(players).length,
      players,
      errors: Object.keys(errors).length ? errors : undefined,
    },
    200,
  );
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
