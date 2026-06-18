// Cloudflare Pages Function: proxy USGA leaderboard.json for the live U.S. Open
// scoring page. The browser cannot hit ace-api.usga.org directly (no CORS, and
// they Akamai-fingerprint browser-shaped requests), but a Worker can — it sends
// a clean server request that the endpoint accepts.
//
// Route: /api/usopen-scoreboard?year=2026
// Returns: { fetchedAt, source, payload }   where payload is the raw USGA shape

const USGA_BASE = "https://ace-api.usga.org/scoring/v1/leaderboard.json";
const CACHE_SECONDS = 30;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const year = url.searchParams.get("year") || new Date().getUTCFullYear().toString();
  const championship = url.searchParams.get("championship") || "uso";

  const upstream = `${USGA_BASE}?championship=${encodeURIComponent(championship)}&championship-year=${encodeURIComponent(year)}`;

  let payload = null;
  let upstreamStatus = 0;
  let upstreamError = null;
  try {
    const res = await fetch(upstream, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      headers: {
        accept: "application/json",
        // Akamai bot rules at ace-api.usga.org reject browser-shaped UAs.
        // A generic non-browser UA mirrors what `curl` sends and clears the
        // gate; spoofing Safari/Chrome here triggers a 403.
        "user-agent": "pga-tracker/1.0 (+github.com/johnsonjacob96/pga-tracker)",
      },
    });
    upstreamStatus = res.status;
    if (res.ok) {
      payload = await res.json();
    } else {
      upstreamError = `upstream ${res.status}`;
    }
  } catch (e) {
    upstreamError = String(e?.message || e);
  }

  const body = {
    fetchedAt: new Date().toISOString(),
    source: "usga:ace-api/leaderboard",
    upstream: { url: upstream, status: upstreamStatus, error: upstreamError },
    payload,
  };

  return new Response(JSON.stringify(body), {
    status: payload ? 200 : 502,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
