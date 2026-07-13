// Auto-finalize a completed major into data/2026-season.json.
//
// Finds any event with a roster, not yet marked complete, whose endDate has
// passed, fetches its final leaderboard (R&A feed for The Open, ESPN for
// Masters/PGA), verifies the tournament is actually over (including the
// playoff tie guard), and bakes winner / winnerPickedBy / teams / snapshot /
// complete:true — the same fields the manual snapshot workflow produced.
//
// Run by .github/workflows/finalize-major.yml every Monday morning (and by
// hand via `node finalize.mjs`). Exits 0 with no changes when there is
// nothing to finalize, so the scheduled run is safe year-round.
//
// Test hooks: SEASON_PATH overrides the season file; RANDA_FEED_FILE /
// ESPN_FEED_FILE read a local JSON instead of fetching.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SEASON_PATH = process.env.SEASON_PATH || "data/2026-season.json";
const RANDA_URL = "https://scoring.theopen.com/scoring?feedType=traditional";
const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";

// Must stay in sync with index.html / season.html / functions/api/parse-draft.js
const normalize = (s) =>
  s.normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o").replace(/Ø/g, "O")
    .replace(/[.\s'-]/g, "")
    .toLowerCase();

function parseScore(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).trim();
  if (s === "" || s === "—") return null;
  if (s === "E") return 0;
  if (s.startsWith("+")) return parseInt(s.slice(1), 10);
  return parseInt(s, 10);
}

async function loadJson(url, fileEnv, headers = {}) {
  if (fileEnv && existsSync(fileEnv)) return JSON.parse(readFileSync(fileEnv, "utf8"));
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "pga-tracker-finalize/1.0", ...headers } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Source adapters — each returns { completed, winner, pars, players } where
// players is the FULL field keyed by normalized name → { name, score, madeCut }.
// completed must be false while a playoff is unresolved.

async function fetchRandA() {
  const data = await loadJson(RANDA_URL, process.env.RANDA_FEED_FILE);
  const field = data.players || [];
  if (!field.length) throw new Error("R&A feed empty");
  const active = field.filter((p) => p.status === 1);
  const leader = field.find((p) => p.position && p.position.sortValue === 1);
  const tiedLead = (leader?.position?.displayValue || "").toUpperCase().startsWith("T");
  const preTournament = field.every((p) => p.toPar == null && p.r1 == null);
  const completed = !preTournament && (data.currentRound || 0) >= 4 &&
    active.length > 0 && active.every((p) => p.r4 != null) && !tiedLead;

  let pars = Array(18).fill(4);
  const r1info = field[0]?.rounds?.[0]?.info || [];
  if (r1info.length === 18) pars = r1info.map((h) => h.holePar || 4);

  const players = {};
  for (const p of field) {
    const name = `${p.firstName || ""} ${p.lastName || ""}`.trim();
    if (!name) continue;
    const raw = typeof p.toPar === "number" ? p.toPar : parseScore(p.toPar);
    players[normalize(name)] = {
      name,
      score: raw === null ? 0 : raw,
      madeCut: p.status === 1 || p.status === undefined,
    };
  }
  const winner = completed
    ? `${leader.firstName || ""} ${leader.lastName || ""}`.trim()
    : null;
  return { completed, winner, pars, players };
}

async function fetchESPN(eventName) {
  const data = await loadJson(ESPN_URL, process.env.ESPN_FEED_FILE);
  const eventKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = { "Open Championship": ["The Open", "British Open", "154th Open"] };
  const wants = [eventName, ...(aliases[eventName] || [])].map(eventKey);
  const event = (data.events || []).find((e) => e.name && wants.some((w) => eventKey(e.name).includes(w)));
  if (!event) throw new Error(`ESPN scoreboard did not return "${eventName}"`);
  const competitors = event.competitions?.[0]?.competitors || [];
  const completed = event.status?.type?.completed === true;

  // Pars: majority vote per hole from R1 relative scores (same as index.html)
  const counts = {};
  for (const c of competitors) {
    for (const h of c.linescores?.[0]?.linescores || []) {
      const rel = h.scoreType?.displayValue;
      if (!rel || h.value == null) continue;
      const relNum = rel === "E" ? 0 : parseInt(rel, 10);
      if (isNaN(relNum)) continue;
      const par = h.value - relNum;
      if (par < 3 || par > 5) continue;
      counts[h.period] = counts[h.period] || {};
      counts[h.period][par] = (counts[h.period][par] || 0) + 1;
    }
  }
  const pars = Array.from({ length: 18 }, (_, i) => {
    const c = counts[i + 1] || {};
    const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return best ? parseInt(best[0], 10) : 4;
  });

  const players = {};
  for (const c of competitors) {
    const name = c.athlete?.fullName || c.athlete?.displayName;
    if (!name) continue;
    players[normalize(name)] = {
      name,
      score: parseScore(c.score) ?? 0,
      madeCut: (c.linescores || []).length >= 3,
    };
  }
  let winner = null;
  if (completed) {
    const finishers = Object.values(players)
      .filter((p) => p.madeCut)
      .sort((a, b) => a.score - b.score);
    if (finishers.length) winner = finishers[0].name;
  }
  return { completed, winner, pars, players };
}

// ---------------------------------------------------------------------------

function computeTeams(ev, owners, final) {
  const made = Object.values(final.players).filter((p) => p.madeCut).map((p) => p.score);
  const worstMadeCut = made.length ? Math.max(...made) : 0;
  const penalty = worstMadeCut + 2;
  const winnerNorm = final.winner ? normalize(final.winner) : null;

  const teams = Object.entries(ev.roster).map(([teamName, roster]) => {
    const ps = roster.map((rn) => final.players[normalize(rn)] || { score: null, madeCut: false });
    const sorted = ps.filter((p) => p.madeCut && p.score !== null).sort((a, b) => a.score - b.score);
    let score = 0;
    for (let i = 0; i < Math.min(3, sorted.length); i++) score += sorted[i].score;
    score += Math.max(0, 3 - sorted.length) * penalty;
    const winnerBonus = !!(winnerNorm && roster.some((rn) => normalize(rn) === winnerNorm));
    if (winnerBonus) score -= 3;
    const owner = Object.entries(owners).find(([, t]) => t === teamName)?.[0] || teamName;
    const team = { owner, teamName, score, players: roster };
    if (winnerBonus) team.winnerBonus = true;
    return team;
  });
  teams.sort((a, b) => a.score - b.score);
  return { teams, worstMadeCut };
}

function buildSnapshot(ev, final, worstMadeCut) {
  // Snapshot is roster-only (same as the manual workflow); worstMadeCut is
  // pinned separately because the pruned player set can't reproduce it.
  const players = {};
  for (const roster of Object.values(ev.roster)) {
    for (const rn of roster) {
      const p = final.players[normalize(rn)];
      players[normalize(rn)] = p
        ? { name: p.name, score: p.score, madeCut: p.madeCut }
        : { name: rn, score: null, madeCut: false };
    }
  }
  return { pars: final.pars, worstMadeCut, players };
}

const season = JSON.parse(readFileSync(SEASON_PATH, "utf8"));
const today = process.env.TODAY || new Date().toISOString().slice(0, 10);

const candidates = (season.events || []).filter(
  (e) => e.roster && !e.complete && e.endDate && e.endDate < today
);
if (!candidates.length) {
  console.log("Nothing to finalize.");
  process.exit(0);
}

let changed = false;
for (const ev of candidates) {
  console.log(`Finalizing ${ev.name}…`);
  let final;
  try {
    if (ev.name === "Open Championship") final = await fetchRandA();
    else if (ev.name === "US Open") throw new Error("US Open finalization not implemented (USGA feed needs per-player calls) — finalize manually");
    else final = await fetchESPN(ev.name);
  } catch (e) {
    console.error(`  ${ev.name}: ${e.message}`);
    continue;
  }
  if (!final.completed) {
    console.log(`  ${ev.name}: not complete yet (playoff pending or feed not final) — will retry next run.`);
    continue;
  }
  if (!final.winner) {
    console.error(`  ${ev.name}: complete but no winner resolved — skipping.`);
    continue;
  }

  const { teams, worstMadeCut } = computeTeams(ev, season.owners || {}, final);
  ev.snapshot = buildSnapshot(ev, final, worstMadeCut);
  ev.teams = teams;
  ev.winner = final.winner;
  const winnerNorm = normalize(final.winner);
  const holder = Object.entries(ev.roster).find(([, r]) => r.some((rn) => normalize(rn) === winnerNorm));
  ev.winnerPickedBy = holder
    ? Object.entries(season.owners || {}).find(([, t]) => t === holder[0])?.[0] || null
    : null;
  ev.complete = true;
  changed = true;
  console.log(`  ${ev.name}: winner ${final.winner}${ev.winnerPickedBy ? ` (picked by ${ev.winnerPickedBy})` : " (not on any roster)"}, champion team ${teams[0].teamName} at ${teams[0].score}`);
}

if (changed) {
  writeFileSync(SEASON_PATH, JSON.stringify(season, null, 2) + "\n");
  console.log(`Wrote ${SEASON_PATH}`);
} else {
  console.log("No events finalized.");
}
