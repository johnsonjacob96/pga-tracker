// One-off: fetch the final 2026 PGA Championship from ESPN's dated archive
// and emit a JSON block (season.json `teams` array + winner + winnerPickedBy).
// Run: node snapshot-pgac.mjs

const TEAMS = {
  Fern:  ["Scottie Scheffler", "Chris Gotterup", "Tyrrell Hatton", "Keegan Bradley", "Sungjae Im"],
  Troop: ["Cameron Young", "Rickie Fowler", "J.J. Spaun", "Harris English", "Ben Griffin"],
  Ram:   ["Jon Rahm", "Min Woo Lee", "Adam Scott", "Alex Fitzpatrick", "Maverick McNealy"],
  Bean:  ["Rory McIlroy", "Russell Henley", "Viktor Hovland", "Shane Lowry", "Austin Smotherman"],
  Money: ["Xander Schauffele", "Patrick Cantlay", "Jordan Spieth", "Sam Burns", "Hideki Matsuyama"],
  Gary:  ["Bryson DeChambeau", "Justin Thomas", "Patrick Reed", "Sam Stevens", "Max Homa"],
  Taco:  ["Ludvig Aberg", "Justin Rose", "Robert MacIntyre", "Sepp Straka", "Matt McCarty"],
  Cyc:   ["Brooks Koepka", "Collin Morikawa", "Si Woo Kim", "Akshay Bhatia", "Gary Woodland"],
  Mags:  ["Matt Fitzpatrick", "Tommy Fleetwood", "Nicolai Hojgaard", "Kristoffer Reitan", "Jason Day"]
};

const OWNERS = {
  Fern: "Emery", Troop: "Austin", Ram: "Miles", Bean: "Jacob",
  Money: "Kellen", Gary: "Garrett", Taco: "Jared", Cyc: "Dylan", Mags: "Alex"
};

const normalize = (s) =>
  s.normalize("NFD")
   .replace(/[̀-ͯ]/g, "")
   .replace(/ø/g, "o").replace(/Ø/g, "O")
   .replace(/[.\s'-]/g, "")
   .toLowerCase();

function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).trim();
  if (s === "" || s === "—") return null;
  if (s === "E") return 0;
  if (s.startsWith("+")) return parseInt(s.slice(1), 10);
  return parseInt(s, 10);
}

const fmtScore = (n) => n === 0 ? "E" : (n > 0 ? `+${n}` : `${n}`);

const url = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=20260518";
const res = await fetch(url);
if (!res.ok) { console.error(`ESPN ${res.status}`); process.exit(1); }
const data = await res.json();
const event = (data.events || []).find(e => /PGA Championship/i.test(e.name));
if (!event) { console.error("No PGA Championship in archive response"); process.exit(1); }

const competition = event.competitions?.[0];
const competitors = competition?.competitors || [];

const players = {};
const playersFull = {};   // For embedding in season.json (no linescores, just summary)
for (const comp of competitors) {
  const name = comp.athlete?.fullName || comp.athlete?.displayName;
  if (!name) continue;
  const linescores = comp.linescores || [];
  const madeCut = linescores.length >= 3;
  const score = parseScore(comp.score);
  const key = normalize(name);
  players[key] = { name, score, madeCut, rounds: linescores.length };
  // For JSON snapshot: keep only roster players to keep file small
  playersFull[key] = { name, score, madeCut };
}

// Derive pars from round-1 linescores across the field (same heuristic as index.html derivePars)
function derivePars(comps) {
  const counts = {};
  for (const c of comps) {
    const r1 = c.linescores?.[0]?.linescores || [];
    for (const h of r1) {
      const rel = h.scoreType?.displayValue;
      if (!rel) continue;
      const relNum = rel === "E" ? 0 : parseInt(rel, 10);
      if (isNaN(relNum) || h.value == null) continue;
      const par = h.value - relNum;
      if (par < 3 || par > 5) continue;
      counts[h.period] = counts[h.period] || {};
      counts[h.period][par] = (counts[h.period][par] || 0) + 1;
    }
  }
  const pars = [];
  for (let i = 1; i <= 18; i++) {
    const c = counts[i] || {};
    const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    pars.push(best ? parseInt(best[0], 10) : 4);
  }
  return pars;
}
const pars = derivePars(competitors);

// Winner = competitor who played 4 rounds with the lowest score
const finishers = competitors
  .filter(c => (c.linescores || []).length === 4)
  .map(c => ({ name: c.athlete?.fullName || c.athlete?.displayName, score: parseScore(c.score) }))
  .filter(c => c.name && c.score !== null)
  .sort((a, b) => a.score - b.score);
const winner = finishers[0]?.name || null;
const winnerNorm = winner ? normalize(winner) : null;

console.error(`Event: ${event.name} | Status: ${event.status?.type?.description} | Winner: ${winner} (${fmtScore(finishers[0]?.score)})`);

// Roster match check (warn-only)
const missing = [];
for (const [team, roster] of Object.entries(TEAMS)) {
  for (const p of roster) if (!players[normalize(p)]) missing.push(`${team} → ${p}`);
}
if (missing.length) {
  console.error(`\nWARNING: ${missing.length} roster players not in ESPN response:`);
  missing.forEach(m => console.error("  " + m));
} else {
  console.error("\nAll 45 roster players matched ✓");
}

// Compute penalty and team scores
const madeCutScores = Object.values(players).filter(p => p.madeCut && p.score !== null).map(p => p.score);
const worstMadeCut = madeCutScores.length ? Math.max(...madeCutScores) : 0;
const penalty = worstMadeCut + 2;
console.error(`Worst made-cut: ${fmtScore(worstMadeCut)} → penalty slot: ${fmtScore(penalty)}`);

let winnerPickedBy = null;
const teams = Object.entries(TEAMS).map(([teamName, roster]) => {
  const ps = roster.map(rn => {
    const f = players[normalize(rn)];
    return { name: rn, score: f?.score ?? null, madeCut: f?.madeCut ?? false };
  });
  const sortedMC = ps.filter(p => p.madeCut && p.score !== null).slice().sort((a, b) => a.score - b.score);
  let total = 0;
  for (let i = 0; i < Math.min(3, sortedMC.length); i++) total += sortedMC[i].score;
  total += Math.max(0, 3 - sortedMC.length) * penalty;
  let winnerBonus = false;
  if (winnerNorm && roster.some(rn => normalize(rn) === winnerNorm)) {
    total -= 3;
    winnerBonus = true;
    winnerPickedBy = OWNERS[teamName];
  }
  return {
    owner: OWNERS[teamName],
    teamName,
    score: total,
    ...(winnerBonus ? { winnerBonus: true } : {}),
    players: roster
  };
});
teams.sort((a, b) => a.score - b.score);

// Human-readable summary to stderr
console.error("\n=== FINAL STANDINGS ===");
teams.forEach((t, i) => {
  const tag = t.winnerBonus ? " *** winner -3" : "";
  console.error(`${i + 1}. ${t.teamName.padEnd(6)} (${t.owner.padEnd(7)}) ${String(fmtScore(t.score)).padStart(4)}${tag}`);
});

// Filter playersFull to only roster players (keep JSON lean — ~45 vs ~150)
const allRosterKeys = new Set(Object.values(TEAMS).flat().map(normalize));
const playersSnapshot = {};
for (const [key, p] of Object.entries(playersFull)) {
  if (allRosterKeys.has(key)) playersSnapshot[key] = p;
}

// JSON snapshot to stdout
const snapshot = {
  winner,
  winnerPickedBy,
  pars,
  players: playersSnapshot,
  teams
};
console.log(JSON.stringify(snapshot, null, 2));
