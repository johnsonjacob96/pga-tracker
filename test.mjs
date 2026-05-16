// Test the live scoring logic against current ESPN data
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

const normalize = (s) =>
  s.normalize("NFD")
   .replace(/[̀-ͯ]/g, "")
   .replace(/ø/g, "o").replace(/Ø/g, "O")
   .replace(/[.\s'-]/g, "")
   .toLowerCase();

const fmtScore = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
};

function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).trim();
  if (s === "" || s === "—") return null;
  if (s === "E") return 0;
  if (s.startsWith("+")) return parseInt(s.slice(1), 10);
  return parseInt(s, 10);
}

const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
const data = await res.json();
const event = (data.events || []).find(e => /PGA Championship/i.test(e.name)) || data.events?.[0];
console.log(`Event: ${event.name}`);
console.log(`Status: ${event.status?.type?.description}`);

const competition = event.competitions[0];
const players = {};
for (const comp of competition.competitors) {
  const name = comp.athlete?.fullName || comp.athlete?.displayName;
  if (!name) continue;
  const score = parseScore(comp.score);
  const linescores = comp.linescores || [];
  const statusName = comp.status?.type?.name || "";
  const madeCut = linescores.length >= 3 || statusName === "STATUS_ACTIVE";
  players[normalize(name)] = { name, score, madeCut, linescoresLen: linescores.length, statusName };
}

// Check all roster players matched
console.log("\n=== ROSTER MATCH CHECK ===");
let missing = 0;
for (const [team, roster] of Object.entries(TEAMS)) {
  for (const p of roster) {
    if (!players[normalize(p)]) {
      console.log(`  MISSING: ${team} → ${p}`);
      missing++;
    }
  }
}
if (missing === 0) console.log("All 45 players matched ✓");

// Worst made-cut
const madeCutScores = Object.values(players).filter(p => p.madeCut && p.score !== null).map(p => p.score);
const worstMadeCut = madeCutScores.length ? Math.max(...madeCutScores) : 0;
const penalty = worstMadeCut + 2;
console.log(`\nWorst made-cut score: ${fmtScore(worstMadeCut)} → penalty: ${fmtScore(penalty)}`);

// Standings
const teams = Object.entries(TEAMS).map(([teamName, roster]) => {
  const teamPlayers = roster.map(rn => {
    const f = players[normalize(rn)];
    if (!f) return { name: rn, score: null, madeCut: false };
    return { name: rn, score: f.score, madeCut: f.madeCut, linescoresLen: f.linescoresLen };
  });
  const sortedMadeCut = teamPlayers.filter(p => p.madeCut && p.score !== null).sort((a, b) => a.score - b.score);
  let total = 0;
  const counting = [];
  for (let i = 0; i < Math.min(3, sortedMadeCut.length); i++) {
    counting.push(sortedMadeCut[i]);
    total += sortedMadeCut[i].score;
  }
  const penaltyCount = 3 - counting.length;
  total += penaltyCount * penalty;
  return { teamName, players: teamPlayers, total, counting, penaltyCount };
});
teams.sort((a, b) => a.total - b.total);

console.log("\n=== STANDINGS ===");
teams.forEach((t, i) => {
  const counts = t.counting.map(c => `${c.name.split(" ").slice(-1)[0]} ${fmtScore(c.score)}`).join(", ");
  const pen = t.penaltyCount > 0 ? ` +${t.penaltyCount}×penalty(${fmtScore(penalty)})` : "";
  console.log(`${i + 1}. ${t.teamName.padEnd(6)} ${fmtScore(t.total).padStart(4)}  [${counts}]${pen}`);
});

console.log("\n=== FULL ROSTER DETAIL ===");
teams.forEach(t => {
  console.log(`\n${t.teamName}:`);
  t.players.forEach(p => {
    const tag = p.madeCut ? (t.counting.includes(p) ? "●" : " ") : "✗";
    console.log(`  ${tag} ${p.name.padEnd(22)} ${String(fmtScore(p.score)).padStart(4)}  (linescores: ${p.linescoresLen ?? "?"})`);
  });
});
