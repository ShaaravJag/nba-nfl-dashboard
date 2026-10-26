// Verifies the deployed app against a game that is actually in progress.
// Takes two samples a few seconds apart and checks that live data really moves.
//
//   node scripts/verify-live.mjs <eventId> [sport] [--host https://...]
import { evaluateLeg } from '../public/markets.js';

const args = process.argv.slice(2);
const eventId = args[0];
const sport = args[1] && !args[1].startsWith('--') ? args[1] : 'nba';
const hostArg = args.indexOf('--host');
const HOST = hostArg > -1 ? args[hostArg + 1] : 'https://bet-tracker-six-tau.vercel.app';

if (!eventId) {
  console.error('usage: node scripts/verify-live.mjs <eventId> [nba|nfl]');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const sample = async () => {
  const started = Date.now();
  const res = await fetch(`${HOST}/api/live?${sport}=${eventId}`);
  const body = await res.json();
  return { game: body.games[eventId], ms: Date.now() - started, cache: res.headers.get('x-vercel-cache') };
};

const first = await sample();
const g1 = first.game;
if (!g1) { console.error('No game data returned.'); process.exit(2); }

console.log(`\n${g1.away.abbr} ${g1.away.score} @ ${g1.home.abbr} ${g1.home.score}  --  ${g1.statusDetail}`);
console.log(`state=${g1.state}  period=${g1.period}  clock=${g1.clock}  (${first.ms}ms, cache ${first.cache})\n`);

check('game reports itself in progress', g1.state === 'in', `state=${g1.state}`);

const onCourt1 = Object.values(g1.players).filter((p) => p.onCourt);
if (sport === 'nba') {
  const perTeam = {};
  for (const p of onCourt1) perTeam[p.teamAbbr] = (perTeam[p.teamAbbr] || 0) + 1;
  check('five players per side on the floor',
    JSON.stringify(Object.values(perTeam).sort()) === JSON.stringify([5, 5]),
    Object.entries(perTeam).map(([t, n]) => `${t}:${n}`).join('  '));
  console.log(`        on court: ${onCourt1.map((p) => p.name).join(', ')}`);
}

const scorers = Object.values(g1.players).filter((p) => (p.stats.pts || p.stats.passYds || p.stats.rushYds || 0) > 0);
check('player stats are populating', scorers.length > 0, `${scorers.length} players with stats`);

// A leg on the leading scorer should read as live, with a real progress value.
const top = scorers.sort((a, b) => (b.stats.pts || b.stats.passYds || 0) - (a.stats.pts || a.stats.passYds || 0))[0];
if (top) {
  const market = sport === 'nba' ? 'nba.pts' : 'nfl.passYds';
  const value = sport === 'nba' ? top.stats.pts : top.stats.passYds;
  const res = evaluateLeg(
    { eventId, sport, market, line: value + 10.5, side: 'over', playerId: top.id, playerName: top.name },
    { [eventId]: g1 }
  );
  check('an unmet over reads as live, not settled', res.status === 'live',
    `${top.name}: ${res.value} vs ${res.line} -> ${res.status}, bar ${(res.progress * 100).toFixed(0)}%, pace ${res.projection}`);
  const hit = evaluateLeg(
    { eventId, sport, market, line: Math.max(0, value - 1.5), side: 'over', playerId: top.id, playerName: top.name },
    { [eventId]: g1 }
  );
  check('a cleared over locks in as hit', hit.status === 'hit', `${top.name} over ${hit.line} -> ${hit.status}`);
}

console.log('\n-- waiting 25s for the game to move --');
await new Promise((r) => setTimeout(r, 25000));

const second = await sample();
const g2 = second.game;
const clockMoved = g2.clock !== g1.clock || g2.period !== g1.period;
const scoreMoved = g2.home.score !== g1.home.score || g2.away.score !== g1.away.score;
const statsMoved = Object.values(g2.players).some((p) => {
  const before = g1.players[p.id];
  return before && JSON.stringify(before.stats) !== JSON.stringify(p.stats);
});

console.log(`        now: ${g2.away.abbr} ${g2.away.score} @ ${g2.home.abbr} ${g2.home.score} -- ${g2.statusDetail}`);
check('the clock advanced between polls', clockMoved, `${g1.clock} -> ${g2.clock}`);
check('score or player stats changed', scoreMoved || statsMoved,
  `score moved: ${scoreMoved}, stats moved: ${statsMoved}`);

console.log(`\n${failures === 0 ? 'Live updating confirmed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
