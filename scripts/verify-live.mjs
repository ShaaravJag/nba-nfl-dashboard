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

// Two samples taken a fixed gap apart is not enough to prove movement: the gap
// can land inside the endpoint's own stale-while-revalidate window and return
// the very same cached copy, and an NBA clock legitimately sits still through a
// timeout or free throws. So poll at the app's real cadence instead and watch
// for the first genuine change, whatever moves first.
const WINDOW_MS = 90000;
console.log(`\n-- polling every 3s for up to ${WINDOW_MS / 1000}s, watching for movement --`);

const deadline = Date.now() + WINDOW_MS;
let last = g1;
let moved = null;
let polls = 1;

while (Date.now() < deadline && !moved) {
  await new Promise((r) => setTimeout(r, 3000));
  const next = (await sample()).game;
  polls++;
  if (!next) continue;

  if (next.clock !== last.clock || next.period !== last.period) {
    moved = `clock ${last.clock} -> ${next.clock}`;
  } else if (next.home.score !== last.home.score || next.away.score !== last.away.score) {
    moved = `score ${last.away.score}-${last.home.score} -> ${next.away.score}-${next.home.score}`;
  } else {
    for (const p of Object.values(next.players)) {
      const before = last.players[p.id];
      if (!before) continue;
      if (JSON.stringify(before.stats) !== JSON.stringify(p.stats)) { moved = `${p.name}'s stat line changed`; break; }
      if (before.onCourt !== p.onCourt) { moved = `${p.name} went ${p.onCourt ? 'on' : 'off'} the floor`; break; }
    }
  }
  last = next;
}

console.log(`        now: ${last.away.abbr} ${last.away.score} @ ${last.home.abbr} ${last.home.score} -- ${last.statusDetail}`);
check('live data moved on its own', !!moved,
  moved || `nothing changed across ${polls} polls -- if the game is stopped this is inconclusive, not a failure`);

// The endpoint is only as fresh as its source, so compare the two directly
// rather than trusting the endpoint on its own. It sits behind a 5s edge cache,
// so being one tick behind is the design, not a fault -- give it a second look
// before calling a mismatch a failure.
const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport === 'nba' ? 'basketball/nba' : 'football/nfl'}/summary?event=${eventId}`;

const compare = async () => {
  const [upstream, ours] = await Promise.all([
    fetch(espnUrl, { cache: 'no-store' }).then((r) => r.json()),
    sample().then((s) => s.game),
  ]);
  const uc = upstream.header.competitions[0];
  const upScore = Object.fromEntries(uc.competitors.map((c) => [c.team.abbreviation, String(c.score)]));
  return {
    agrees: ours.clock === uc.status.displayClock
      && String(ours.home.score) === upScore[ours.home.abbr]
      && String(ours.away.score) === upScore[ours.away.abbr],
    detail: `espn P${uc.status.period} ${uc.status.displayClock} ${JSON.stringify(upScore)}  |  ours P${ours.period} ${ours.clock} ${ours.away.abbr}:${ours.away.score} ${ours.home.abbr}:${ours.home.score}`,
  };
};

let agreement = await compare();
if (!agreement.agrees) {
  await new Promise((r) => setTimeout(r, 6000));
  agreement = await compare();
}
check('endpoint agrees with ESPN within one cache window', agreement.agrees, agreement.detail);

console.log(`\n${failures === 0 ? 'Live updating confirmed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
