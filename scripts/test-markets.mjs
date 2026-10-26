// Verifies settlement against a real finished game so the maths can be checked
// without waiting for tip-off.
import { loadGame } from '../api/_espn.js';
import { evaluateLeg, betStatus, payoutFor, combineOdds, formatOdds, elapsedFraction } from '../public/markets.js';

const EVENT = process.argv[2] || '401909861'; // LAL 132 @ UTAH 123, 2026-10-25
const game = await loadGame('nba', EVENT);
const games = { [EVENT]: game };

const byName = (name) => Object.values(game.players).find((p) => p.name === name);
const ziaire = byName('Ziaire Williams');
const kessler = byName('Walker Kessler');

const leg = (over) => ({ eventId: EVENT, sport: 'nba', ...over });

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

console.log(`\nGame: ${game.away.abbr} ${game.away.score} @ ${game.home.abbr} ${game.home.score} (${game.statusDetail})`);
console.log(`Ziaire Williams: ${ziaire.stats.pts}pts ${ziaire.stats.reb}reb ${ziaire.stats.ast}ast ${ziaire.stats.fg3m} threes`);
console.log(`Walker Kessler:  ${kessler.stats.pts}pts ${kessler.stats.reb}reb\n`);

const r = (l) => evaluateLeg(leg(l), games);

check('Ziaire over 9.5 pts -> won',
  (() => { const x = r({ playerId: ziaire.id, market: 'nba.pts', line: 9.5, side: 'over' }); return [x.value, x.status]; })(),
  [11, 'won']);

check('Ziaire under 9.5 pts -> lost',
  r({ playerId: ziaire.id, market: 'nba.pts', line: 9.5, side: 'under' }).status, 'lost');

check('Ziaire over 19.5 pts -> lost',
  r({ playerId: ziaire.id, market: 'nba.pts', line: 19.5, side: 'over' }).status, 'lost');

check('Ziaire over 11 pts -> push (exact line)',
  r({ playerId: ziaire.id, market: 'nba.pts', line: 11, side: 'over' }).status, 'push');

check('Kessler over 6.5 reb -> won',
  (() => { const x = r({ playerId: kessler.id, market: 'nba.reb', line: 6.5, side: 'over' }); return [x.value, x.status]; })(),
  [7, 'won']);

check('Ziaire PRA = pts+reb+ast',
  r({ playerId: ziaire.id, market: 'nba.pra', line: 0.5, side: 'over' }).value,
  ziaire.stats.pts + ziaire.stats.reb + ziaire.stats.ast);

check('Game total over 221.5 -> won',
  (() => { const x = r({ market: 'nba.game_total', line: 221.5, side: 'over' }); return [x.value, x.status]; })(),
  [game.home.score + game.away.score, 'won']);

check('Game total under 221.5 -> lost',
  r({ market: 'nba.game_total', line: 221.5, side: 'under' }).status, 'lost');

const margin = game.home.score - game.away.score;
check(`${game.home.abbr} ${formatOdds(-6.5)} spread -> ${margin > 6.5 ? 'won' : 'lost'}`,
  r({ market: 'nba.spread', teamAbbr: game.home.abbr, line: -6.5 }).status,
  margin > 6.5 ? 'won' : 'lost');

check(`${game.away.abbr} moneyline -> ${margin < 0 ? 'won' : 'lost'}`,
  r({ market: 'nba.moneyline', teamAbbr: game.away.abbr, line: 0 }).status,
  margin < 0 ? 'won' : 'lost');

check('Team total uses the right side',
  r({ market: 'nba.team_total', teamAbbr: game.home.abbr, line: 100.5, side: 'over' }).value,
  game.home.score);

const h1 = (game.home.linescores[0] + game.home.linescores[1]) + (game.away.linescores[0] + game.away.linescores[1]);
check('1st half total from linescores',
  r({ market: 'nba.h1_total', line: 0.5, side: 'over' }).value, h1);

check('Unsupported leg is manual, not dropped',
  r({ market: 'unsupported', rawLabel: 'Race to 20 points' }).status, 'unknown');

check('Unsupported leg honours a manual mark',
  r({ market: 'unsupported', rawLabel: 'x', manualStatus: 'won' }).status, 'won');

// Bet-level rollup
const won = { status: 'won' }, lost = { status: 'lost' }, live = { status: 'live' }, hit = { status: 'hit' };
check('all legs won -> won', betStatus([won, won]), 'won');
check('any leg lost -> lost', betStatus([won, lost, live]), 'lost');
check('one hit, one live -> live', betStatus([hit, live]), 'live');

// Odds
check('+650 on $10 pays 75.00', payoutFor({ stake: 10, americanOdds: 650 }), 75);
check('-110 on $10 pays 19.09', payoutFor({ stake: 10, americanOdds: -110 }), 19.09);
check('two -110 legs combine to about +264', combineOdds([-110, -110]), 264);
check('explicit payout wins over odds', payoutFor({ stake: 10, americanOdds: 650, payout: 80 }), 80);
check('leg odds priced in decimal space, no rounding loss',
  payoutFor({ stake: 10, legs: [{ americanOdds: -110 }, { americanOdds: -110 }] }), 36.45);

// --- period clock formats -------------------------------------------------
// ESPN drops the colon inside the last minute of a period, which used to send
// elapsed time negative and silently kill the pace projection.
{
  const frac = (clock, period = 1) => elapsedFraction({ sport: 'nba', state: 'in', period, clock });
  const approx = (a, b) => Math.abs(a - b) < 0.005;

  check('clock 12:00 at tip is 0 elapsed', frac('12:00'), 0);
  check('clock 6:00 in Q1 is an eighth elapsed', approx(frac('6:00'), 0.125), true);
  check('sub-minute clock counts as nearly a full period', approx(frac('56.2'), 0.2305), true);
  check('sub-minute clock beats the start of the period', frac('56.2') > frac('6:00'), true);
  check('0.4 left in Q1 is a quarter of the game', approx(frac('0.4'), 0.2497), true);
  check('Q3 sub-minute clock keeps the periods already played', approx(frac('30.0', 3), 0.7396), true);
  check('an empty clock does not go negative', frac('') >= 0, true);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
