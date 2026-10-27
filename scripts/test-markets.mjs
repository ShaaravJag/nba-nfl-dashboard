// Verifies settlement against a real finished game so the maths can be checked
// without waiting for tip-off.
import { loadGame } from '../api/_espn.js';
import { evaluateLeg, betStatus, payoutFor, profitFor, priceBet, combineOdds, formatOdds, elapsedFraction, legAlerts, sweatLine } from '../public/markets.js';

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

// --- leg alerts -------------------------------------------------------------
{
  const mk = (o = {}) => ({ sport: 'nba', state: 'in', period: 2, clock: '6:00', home: { abbr: 'HOM', score: 50 }, away: { abbr: 'AWY', score: 48 }, players: {}, injuries: {}, ...o });
  const davis = (stats = {}, extra = {}) => ({ p1: { id: 'p1', name: 'Anthony Davis', stats: { pts: 10, ...stats }, dnp: false, ...extra } });
  const pleg = (o = {}) => ({ id: 'l', sport: 'nba', market: 'nba.pts', line: 20.5, side: 'over', playerId: 'p1', playerName: 'Anthony Davis', eventId: 'e1', ...o });
  const alerts = (leg, g) => legAlerts(leg, g, evaluateLeg(leg, { e1: g })).map((a) => `${a.level}:${a.text}`);
  const fouls = (pf, period) => alerts(pleg(), mk({ period, players: davis({ pf }) }));

  check('2 fouls in the 1st is foul trouble', fouls(2, 1), ['warn:2 fouls']);
  check('2 fouls in the 2nd is not', fouls(2, 2), []);
  check('3 fouls in the 2nd is', fouls(3, 2), ['warn:3 fouls']);
  check('4 fouls in the 3rd is', fouls(4, 3), ['warn:4 fouls']);
  check('4 fouls in the 4th is not', fouls(4, 4), []);
  check('5 fouls in overtime is', fouls(5, 5), ['warn:5 fouls']);
  check('6 fouls is fouled out', fouls(6, 4), ['bad:Fouled out']);
  check('ejection is flagged', alerts(pleg(), mk({ players: davis({}, { ejected: true }) })), ['bad:Ejected']);
  check('foul trouble on an under is neutral', alerts(pleg({ side: 'under' }), mk({ period: 4, players: davis({ pf: 5 }) })), ['info:5 fouls']);
  check('no foul alert once an over has hit', alerts(pleg({ line: 5.5 }), mk({ period: 4, players: davis({ pf: 5 }) })), []);

  const blow = (sport, period, margin, side = 'over') => alerts(pleg({ sport, market: sport === 'nba' ? 'nba.pts' : 'nfl.rushYds', side }),
    mk({ sport, period, home: { abbr: 'HOM', score: 60 + margin }, away: { abbr: 'AWY', score: 60 }, players: davis({ pf: 0 }) }));
  check('NBA up 25 in the 3rd is a blowout', blow('nba', 3, 25), ['warn:Blowout — starters may sit']);
  check('NBA up 24 in the 3rd is not', blow('nba', 3, 24), []);
  check('NBA up 20 in the 4th is', blow('nba', 4, 20), ['warn:Blowout — starters may sit']);
  check('NBA up 30 in the 2nd is not yet', blow('nba', 2, 30), []);
  check('a blowout never worries an under', blow('nba', 4, 30, 'under'), []);
  check('NFL up 21 in the 4th is a blowout', blow('nfl', 4, 21), ['warn:Blowout — starters may sit']);
  check('NFL up 28 in the 3rd is not yet', blow('nfl', 3, 28), []);

  const injured = (status, state) => alerts(pleg(), mk({ state, period: state === 'pre' ? 0 : 2, players: state === 'pre' ? {} : davis(), injuries: { p1: { status, detail: 'Ankle' } } }));
  check('ruled out reads as likely void', injured('Out', 'pre'), ['bad:OUT — leg likely void']);
  check('questionable shows before tip-off', injured('Questionable', 'pre'), ['warn:Questionable']);
  check('questionable drops once he is playing', injured('Questionable', 'in'), []);

  const sat = (state, period) => alerts(pleg(), mk({ state, period, players: davis({ pts: 0 }, { dnp: true }) }));
  check('NBA DNP at the final is void, not an alert', sat('post', 4), []);
  check('NBA DNP early on is no alarm yet', sat('in', 2), []);
  check("NBA DNP from the 3rd on hasn't played", sat('in', 3), ["warn:Hasn't played"]);
  const nflLeg = pleg({ sport: 'nfl', market: 'nfl.recYds', line: 40.5 });
  check('NFL absence from the box is not a DNP', alerts(nflLeg, mk({ sport: 'nfl', state: 'post', period: 4, players: { other: { id: 'other', name: 'Someone', stats: {} } } })), []);
  check('game lines get no player alerts', alerts({ id: 'g', sport: 'nba', market: 'nba.game_total', line: 220.5, side: 'over', eventId: 'e1' }, mk({ period: 4, home: { abbr: 'HOM', score: 90 }, away: { abbr: 'AWY', score: 60 } })), []);
}

// --- sweat line ---------------------------------------------------------------
{
  const g = (o = {}) => ({ sport: 'nba', state: 'in', period: 3, clock: '6:00', home: { abbr: 'WSH', score: 70 }, away: { abbr: 'CHA', score: 68 }, players: {
    d: { id: 'd', name: 'Anthony Davis', stats: { pts: 30, reb: 2 } },
    j: { id: 'j', name: 'Jaren Jackson Jr.', stats: { pts: 25, reb: 9 } },
  }, ...o });
  const leg = (o) => ({ eventId: 'e1', sport: 'nba', side: 'over', ...o });
  const line = (legs, game = g()) => sweatLine({ legs }, legs.map((l) => evaluateLeg(l, { e1: game })));
  const hitA = leg({ market: 'nba.pts', line: 20.5, playerId: 'd', playerName: 'Anthony Davis' });
  const hitB = leg({ market: 'nba.pts', line: 20.5, playerId: 'j', playerName: 'Jaren Jackson Jr.' });
  const needReb = leg({ market: 'nba.reb', line: 9.5, playerId: 'd', playerName: 'Anthony Davis' });
  const needJJ = leg({ market: 'nba.reb', line: 12.5, playerId: 'j', playerName: 'Jaren Jackson Jr.' });

  check('one leg left names what it needs', line([hitA, hitB, needReb]), '2 of 3 hit · Davis needs 8 more reb');
  check('suffixes are dropped from the name', line([hitA, needJJ]), '1 of 2 hit · Jackson needs 4 more reb');
  check('several left just counts them', line([hitA, needReb, needJJ]), '1 of 3 hit · 2 to go');
  check('a straight under shows where it stands', line([leg({ market: 'nba.reb', line: 9.5, side: 'under', playerId: 'd', playerName: 'Anthony Davis' })]), 'Davis under 9.5 reb (at 2)');
  check('a game total says how far off it is', line([hitA, leg({ market: 'nba.game_total', line: 150.5 })]), '1 of 2 hit · Game Total needs 13 more');
  check('a spread shows the margin', line([hitA, leg({ market: 'nba.spread', line: -4.5, teamAbbr: 'WSH' })]), '1 of 2 hit · WSH -4.5 · margin +2');
  check('nothing started yet waits on the games', line([needReb, { ...needJJ, eventId: 'e2' }], g({ state: 'pre' })), 'Waiting on 2 games');
  check('every leg in', line([hitA, hitB]), 'All 2 legs hit');
  const outGame = g({ injuries: { z: { status: 'Out' } } });
  const ruledOut = leg({ market: 'nba.pts', line: 10.5, playerId: 'z', playerName: 'Nic Claxton' });
  check('a void leg drops out of the count', line([hitA, ruledOut, needReb], outGame), '1 of 2 hit · 1 void · Davis needs 8 more reb');
  check('every leg void means the stake comes back', line([ruledOut], outGame), 'Every leg void — stake back');
}

// --- void legs + re-pricing ---------------------------------------------------
{
  const game = (o = {}) => ({ sport: 'nba', state: 'post', period: 4, clock: '0.0', home: { abbr: 'HOM', score: 110 }, away: { abbr: 'AWY', score: 100 }, injuries: {}, players: {
    a: { id: 'a', name: 'Played Guy', stats: { pts: 30, reb: 8 }, dnp: false },
    d: { id: 'd', name: 'Bench Guy', stats: {}, dnp: true },
  }, ...o });
  const leg = (o) => ({ id: o.playerId || 'x', eventId: 'e1', sport: 'nba', market: 'nba.pts', line: 10.5, side: 'over', ...o });
  const status = (l, g = game()) => evaluateLeg(l, { e1: g }).status;
  const live = { state: 'in', period: 3, clock: '5:00' };

  check('NBA DNP at the final is void', status(leg({ playerId: 'd', playerName: 'Bench Guy' })), 'void');
  check('an under on a DNP is void too, not a win', status(leg({ playerId: 'd', playerName: 'Bench Guy', side: 'under' })), 'void');
  check('NBA player missing from a final box is void', status(leg({ playerId: 'zz', playerName: 'Inactive Guy' })), 'void');
  check('NBA DNP mid-game is still live -- he can check in', status(leg({ playerId: 'd', playerName: 'Bench Guy' }), game(live)), 'live');
  check('ruled out goes void once the game starts', status(leg({ playerId: 'zz', playerName: 'Hurt Guy' }), game({ ...live, period: 1, injuries: { zz: { status: 'Out' } } })), 'void');
  check('ruled out but not started yet stays pending', status(leg({ playerId: 'zz', playerName: 'Hurt Guy' }), game({ state: 'pre', period: 0, players: {}, injuries: { zz: { status: 'Out' } } })), 'pending');
  check('listed out but actually played is not void', status(leg({ playerId: 'a', playerName: 'Played Guy' }), game({ injuries: { a: { status: 'Out' } } })), 'won');
  const nflLeg = (o) => leg({ sport: 'nfl', market: 'nfl.recYds', line: 40.5, ...o });
  check('NFL ruled out goes void', status(nflLeg({ playerId: 'zz', playerName: 'Hurt WR' }), game({ sport: 'nfl', injuries: { zz: { status: 'Out' } } })), 'void');
  check('NFL missing from the box with no injury is a normal loss', status(nflLeg({ playerId: 'zz', playerName: 'Quiet WR' }), game({ sport: 'nfl' })), 'lost');
  check('a void leg says why', evaluateLeg(leg({ playerId: 'd', playerName: 'Bench Guy' }), { e1: game() }).voidReason, 'did not play');

  check('won + void rolls up to won', betStatus([{ status: 'won' }, { status: 'void' }]), 'won');
  check('lost + void is still lost', betStatus([{ status: 'lost' }, { status: 'void' }]), 'lost');
  check('live + void is live', betStatus([{ status: 'live' }, { status: 'void' }]), 'live');
  check('every leg void is void', betStatus([{ status: 'void' }, { status: 'void' }]), 'void');
  check('every leg pushed is a push', betStatus([{ status: 'push' }, { status: 'push' }]), 'push');

  // $10 at -110, +140, +120: 1.9091 x 2.4 x 2.2 = 10.08 decimal.
  const parlay = { stake: 10, legs: [{ americanOdds: -110 }, { americanOdds: 140 }, { americanOdds: 120 }] };
  const st = (...xs) => xs.map((s) => ({ status: s }));
  check('no void: the legs multiply out', payoutFor(parlay, st('won', 'won', 'won')), 100.8);
  check('void the +140: re-priced on the other two', payoutFor(parlay, st('won', 'void', 'won')), 42);
  check('a pushed leg drops out the same way', payoutFor(parlay, st('won', 'push', 'won')), 42);
  check('re-pricing reports the new odds', priceBet(parlay, st('won', 'void', 'won')).odds, 320);
  check('every leg void: stake back', payoutFor(parlay, st('void', 'void', 'void')), 10);
  check('profit follows the re-priced payout', profitFor(parlay, st('won', 'void', 'won')), 32);
  // Only the parlay price and the void leg's odds known: divide it back out.
  check('divides the void leg out of the parlay odds', payoutFor({ stake: 10, americanOdds: 650, legs: [{}, { americanOdds: -200 }, {}] }, st('won', 'void', 'won')), 50);
  check('or out of the slip\'s "to pay"', payoutFor({ stake: 10, payout: 75, legs: [{}, { americanOdds: -200 }, {}] }, st('won', 'void', 'won')), 50);
  check('no odds to work from: unknown, not guessed', payoutFor({ stake: 10, americanOdds: 650, legs: [{}, {}, {}] }, st('won', 'void', 'won')), null);
  check('no results passed: the original price', payoutFor({ stake: 10, americanOdds: 650, legs: [{}, {}] }), 75);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
