// Cloudflare Pages Function: proxy the R&A's live scoring feed for The Open.
// scoring.theopen.com serves no CORS headers, so the browser can't hit it
// directly — the Worker fetches it server-side and re-serves with CORS open.
// This is the same feed theopen.com's own leaderboard polls every 20 seconds.
//
// Route: /api/open-scoreboard            → feedType=traditional (full field)
//        /api/open-scoreboard?feed=coursepars → hole pars / course metadata
// Returns: { fetchedAt, source, upstream, payload }  payload = raw R&A shape:
//   { cutRound, cutLine, cutScore, currentRound, currentRoundStatus,
//     players: [{ id, firstName, lastName, position, toPar, today, hole,
//                 r1..r4, total, status, rounds: [{ id, teeTime,
//                 info: [{ holeId, holePar, playerStrokes }] }] }] }
// status enum (from theopen.com bundle): 1=ACTIVE 2=CUT 3=WD 4=DQ 5=NR 6=RTD

const RANDA_BASE = "https://scoring.theopen.com/scoring";
const CACHE_SECONDS = 30;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const feed = url.searchParams.get("feed") || "traditional";

  const upstream = `${RANDA_BASE}?feedType=${encodeURIComponent(feed)}`;

  let payload = null;
  let upstreamStatus = 0;
  let upstreamError = null;
  try {
    const res = await fetch(upstream, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      headers: {
        accept: "application/json",
        "user-agent": "pga-tracker/1.0 (+github.com/johnsonjacob96/pga-tracker)",
      },
    });
    upstreamStatus = res.status;
    if (res.ok && res.status !== 204) {
      payload = await res.json();
    } else {
      upstreamError = `upstream ${res.status}`;
    }
  } catch (e) {
    upstreamError = String(e?.message || e);
  }

  const body = {
    fetchedAt: new Date().toISOString(),
    source: "randa:scoring.theopen.com",
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
