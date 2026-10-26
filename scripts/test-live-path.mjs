// The live path cannot be checked against a game in progress on demand, so this
// rebuilds one: take a finished game, truncate its play-by-play to a moment
// mid-game, and assert the in-progress behaviour from there.
//
// Caveat worth knowing when reading the output: ESPN serves no historical box
// score snapshots, so the per-player stats here are the FINAL numbers even at a
// rewound clock. What this verifies is the substitution replay, the live-versus-
// settled state machine, and the clock maths -- not mid-game stat values, which
// ESPN updates in real time during an actual game.
import { fetchJson, summaryUrl, normalizeGame } from '../api/_espn.js';
import { evaluateLeg, elapsedFraction } from '../public/markets.js';

const EVENT = process.argv[2] || '401909861';
const summary = await fetchJson(summaryUrl('nba', EVENT));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

// Rewind to a chosen point in the game.
function rewindTo(playIndex) {
  const play = summary.plays[playIndex];
  const clone = structuredClone(summary);
  clone.plays = clone.plays.slice(0, playIndex + 1);
  const status = clone.header.competitions[0].status;
  status.type = { state: 'in', completed: false, shortDetail: `${play.period.displayValue} - ${play.clock.displayValue}` };
  status.period = play.period.number;
  status.displayClock = play.clock.displayValue;
  return normalizeGame('nba', clone);
}

console.log('\n-- substitution replay: exactly five players per side on the floor --');
// Sample several moments across the game; a drifting set would show up here.
const marks = [60, 150, 300, 420, summary.plays.length - 40].filter((i) => i > 0 && i < summary.plays.length);
for (const idx of marks) {
  const g = rewindTo(idx);
  const onFloor = Object.values(g.players).filter((p) => p.onCourt);
  const perTeam = {};
  for (const p of onFloor) perTeam[p.teamAbbr] = (perTeam[p.teamAbbr] || 0) + 1;
  const counts = Object.entries(perTeam).sort().map(([t, n]) => `${t}:${n}`).join(' ');
  check(`${g.statusDetail.padEnd(18)} -> ${counts}`, Object.values(perTeam).sort(), [5, 5]);
}

console.log('\n-- an in-progress game must not settle --');
const mid = rewindTo(300);
const games = { [EVENT]: mid };
const leg = (over) => evaluateLeg({ eventId: EVENT, sport: 'nba', ...over }, games);

const ziaire = Object.values(mid.players).find((p) => p.name === 'Ziaire Williams');
check('big over still live mid-game',
  leg({ playerId: ziaire.id, market: 'nba.pts', line: 99.5, side: 'over' }).status, 'live');
check('under not yet won mid-game',
  leg({ playerId: ziaire.id, market: 'nba.pts', line: 99.5, side: 'under' }).status, 'live');
check('cleared over locks as hit, not won',
  leg({ playerId: ziaire.id, market: 'nba.pts', line: -0.5, side: 'over' }).status, 'hit');
check('passed under busts immediately',
  leg({ playerId: ziaire.id, market: 'nba.pts', line: -0.5, side: 'under' }).status, 'bust');
check('spread stays live until the final',
  leg({ market: 'nba.spread', teamAbbr: mid.home.abbr, line: -6.5 }).status, 'live');

console.log('\n-- clock drives the pace projection --');
const frac = elapsedFraction(mid);
check('elapsed fraction is inside the game', frac > 0 && frac < 1, true);
const paced = leg({ playerId: ziaire.id, market: 'nba.pts', line: 99.5, side: 'over' });
check('projection extrapolates from the clock', paced.projection > paced.value, true);
console.log(`        ${mid.statusDetail}: ${paced.value} pts, ${(frac * 100).toFixed(0)}% elapsed, on pace for ${paced.projection}`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
