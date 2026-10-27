// Verifies the play-by-play feed: the replay must reproduce ESPN's final box
// score exactly, titles and notes must read right on known plays, and the bet
// markers must land on the play that decided the leg.
import { fetchJson, summaryUrl, loadBox } from '../api/_espn.js';
import { nbaFeed, nflFeed, buildFeed } from '../api/_feed.js';
import { SNAP_KEYS, legMarkers, feedHtml } from '../public/feed.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const summaryOf = (sport, id) => fetchJson(summaryUrl(sport, id));
const boxTotals = (summary) => {
  const out = {};
  const split = (v) => String(v).split('-').map(Number);
  for (const block of summary.boxscore.players) {
    const g = block.statistics[0];
    for (const a of g.athletes) {
      if (!a.stats?.length) continue;
      const o = Object.fromEntries(g.keys.map((k, i) => [k, a.stats[i]]));
      const [fgm, fga] = split(o['fieldGoalsMade-fieldGoalsAttempted']);
      const [fg3m, fg3a] = split(o['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
      const [ftm, fta] = split(o['freeThrowsMade-freeThrowsAttempted']);
      out[a.athlete.id] = { pts: +o.points, reb: +o.rebounds, ast: +o.assists, fg3m, stl: +o.steals, blk: +o.blocks,
        to: +o.turnovers, fgm, fga, ftm, fta, fg3a, oreb: +o.offensiveRebounds, dreb: +o.defensiveRebounds, pf: +o.fouls };
    }
  }
  return out;
};

// --- the replay reproduces the box score ----------------------------------
console.log('\nReplay vs ESPN box score');
for (const id of ['401909861', '401909868', '401909854', '401909857', '401909858']) {
  const summary = await summaryOf('nba', id);
  const want = boxTotals(summary);
  const { items, totals } = nbaFeed(summary);
  const wrong = Object.entries(want).flatMap(([pid, w]) => SNAP_KEYS.filter((k) => (totals[pid]?.[k] ?? 0) !== w[k]).map((k) => `${pid}.${k}`));
  // Each player's last snapshot in the feed must agree with the totals too.
  const last = {};
  for (const it of items) for (const [pid, arr] of Object.entries(it.snap || {})) last[pid] = arr;
  const stale = Object.entries(want).filter(([pid]) => last[pid] && SNAP_KEYS.some((k, i) => last[pid][i] !== totals[pid][k]));
  check(`${id}: ${Object.keys(want).length} players x ${SNAP_KEYS.length} stats match ESPN`, wrong, []);
  check(`${id}: every player's last snapshot equals his final line`, stale.length, 0);
}

// --- known plays in LAL @ UTAH ----------------------------------------------
console.log('\nKnown plays, LAL @ UTAH');
const lal = await summaryOf('nba', '401909861');
const { items, players } = nbaFeed(lal);
const idOf = (name) => Object.entries(players).find(([, p]) => p.name === name)?.[0];
const block = items.find((it) => it.a?.id === idOf('L. Doncic') && it.b?.role === 'blk');
check('a blocked shot reads as blocked, with distance and type', block?.title, "Blocked 25' pull-up three");
check('the blocker gets his running block count', /^\d+ blk$/.test(block?.b?.line || ''), true);
check('the shooter keeps his FG line', /^\d+\/\d+ FG · \d+\/\d+ 3PT$/.test(block?.a?.line || ''), true);
check('a 22-foot sideline three is a corner three', items.some((it) => it.a?.id === idOf('M. Thybulle') && it.title === "Missed 22' corner three"), true);
const heave = items.find((it) => it.a?.id === idOf('K. George') && /heave/.test(it.title));
check('a missed heave shows in the feed', !!heave, true);
const georgeBefore = [...items].slice(0, items.indexOf(heave)).reverse().find((it) => it.snap?.[idOf('K. George')]);
check('...but does not count as an attempt', heave?.snap[idOf('K. George')][SNAP_KEYS.indexOf('fga')], georgeBefore?.snap[idOf('K. George')][SNAP_KEYS.indexOf('fga')]);
check('a made shot shows points and the shot line', items.some((it) => it.kind === 'shot' && it.made && /^\d+ pts · \d+\/\d+ (FG|3PT)$/.test(it.a.line)), true);
check('a five-man swap at one clock is a single row', items.some((it) => it.kind === 'sub' && it.subs.length >= 3), true);
check('team rebounds are left out', items.filter((it) => it.kind === 'reb').every((it) => it.a?.id), true);
check('no card carries more than two notes', items.every((it) => (it.notes || []).length <= 2), true);

// Swings from dropped or merged plays carry forward, so nothing is lost. ESPN's
// win-probability list isn't in play order, so the reference walks the plays.
const wpById = new Map(lal.winprobability.map((w) => [String(w.playId), w.homeWinPercentage * 100]));
const inOrder = lal.plays.map((p) => wpById.get(String(p.id))).filter((v) => v != null);
const swingSum = items.reduce((s, it) => s + (it.swing || 0), 0);
check('swings add up to the game\'s change in win probability', Math.abs(swingSum - (inOrder[inOrder.length - 1] - inOrder[0])) < 1, true);
const fed = buildFeed('nba', lal, 80);
check('the bar shows the win probability after the latest play', fed.winProb, Math.round(inOrder[inOrder.length - 1] * 10) / 10);
check('...which for a final is the winner at 100%', [0, 100].includes(Math.round(fed.winProb)), true);

// --- notes on a made-up game, at their thresholds and not before -------------
console.log('\nNotes on synthetic plays');
let seq = 0;
const play = (o) => ({ id: String(++seq), period: { number: o.q || 1 }, clock: { displayValue: o.clock || '10:00' }, awayScore: o.a ?? 0, homeScore: o.h ?? 0, team: { id: o.team || '1' }, ...o });
const shot = (pid, made, o = {}) => play({ type: { text: 'Jump Shot' }, text: `${made ? 'makes' : 'misses'} 18-foot jumper`, shootingPlay: true, scoringPlay: made, scoreValue: made ? 2 : 0, pointsAttempted: 2, participants: [{ athlete: { id: pid } }], ...o });
const foul = (pid, team) => play({ type: { text: 'Personal Foul' }, text: 'personal foul', team: { id: team }, participants: [{ athlete: { id: pid } }] });
const game = (plays) => ({
  header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'HOM' } }, { homeAway: 'away', team: { id: '2', abbreviation: 'AWY' } }] }] },
  boxscore: { players: [{ team: { abbreviation: 'HOM' }, statistics: [{ athletes: [{ athlete: { id: 'p', shortName: 'P. Shooter' } }, { athlete: { id: 'f', shortName: 'F. Fouler' } }] }] }] },
  plays,
});
const notesOf = (plays) => nbaFeed(game(plays)).items.map((it) => it.notes);

const misses = notesOf([1, 2, 3, 4].map(() => shot('p', false)));
check('three straight misses: no note yet', misses[2], []);
check('the fourth miss is a streak', misses[3], ['4-straight missed FG']);
let h = 0;
const scoring = notesOf([1, 2, 3, 4, 5].map(() => shot('p', true, { h: (h += 2) })));
check('8 points: nothing yet', scoring[3].includes('Reaches 10 pts'), false);
check('reaching 10 points is noted on that basket', scoring[4].includes('Reaches 10 pts'), true);
check('...as is the unanswered run behind it', scoring[3].includes('HOM on a 8-0 run'), true);
check('at most two notes, milestone first', scoring[4], ['Reaches 10 pts', '5 straight makes']);
const fouls = notesOf([1, 2, 3, 4, 5].map(() => foul('f', '1')));
check('a team\'s fifth foul puts the other side in the bonus', fouls[4].includes('AWY in the bonus'), true);
check('...and is that player\'s fifth', fouls[4].includes('5th foul'), true);
check('four fouls: neither yet', fouls[3], []);

// --- NFL --------------------------------------------------------------------
console.log('\nNFL drives');
const nfl = buildFeed('nfl', await summaryOf('nfl', '401873010'), 1000);
check('drives come newest first', nfl.drives[0].plays[0].text.toUpperCase().includes('END GAME'), true);
check('every drive has a result and a description', nfl.drives.every((d) => d.desc && (d.result || d.current)), true);
check('plays carry their text', nfl.drives.flatMap((d) => d.plays).every((p) => typeof p.text === 'string'), true);
check('some plays carry down and distance', nfl.drives.flatMap((d) => d.plays).some((p) => /^\d(st|nd|rd|th) & /.test(p.down)), true);
check('all of the game\'s plays are there', nfl.total, nfl.drives.reduce((n, d) => n + d.plays.length, 0));
const mnf = await summaryOf('nfl', '401873009');
if (mnf.header.competitions[0].status.type.state === 'in') {
  check('a live game leads with its current drive', buildFeed('nfl', mnf, 80).drives[0].current, true);
} else console.log('SKIP  live-drive check (no NFL game in progress)');

// --- size -------------------------------------------------------------------
const box = await loadBox('nba', '401909861', 80);
check('box score plus an 80-play feed stays under 60KB', JSON.stringify(box).length < 60000, true);
check('feed renders', feedHtml(box).includes('fd-card'), true);

// --- bet markers ------------------------------------------------------------
console.log('\nBet markers');
const whole = buildFeed('nba', lal, 1000);
const doncic = idOf('L. Doncic');
const leg = (market, line, side = 'over') => ({ sport: 'nba', market, line, side, playerId: doncic, playerName: 'Luka Doncic', eventId: '401909861' });
const marks = legMarkers(whole.items, [leg('nba.pts', 49.5), leg('nba.pra', 60.5), leg('nba.ast', 8.5, 'under')], true);
const at = (text) => whole.items.find((it) => (marks.get(it.id) || []).some((m) => m.text.includes(text)));
const value = (it, f) => { const a = it.snap[doncic]; return f(Object.fromEntries(SNAP_KEYS.map((k, i) => [k, a[i]]))); };
const prevSnap = (it) => whole.items.slice(whole.items.indexOf(it) + 1).find((x) => x.snap?.[doncic]);
const pts = at('o49.5 PTS');
check('an over is marked on the play that cleared it', [value(prevSnap(pts), (s) => s.pts) <= 49, value(pts, (s) => s.pts) >= 50], [true, true]);
const pra = at('o60.5 PRA');
check('a PRA leg uses the combined stat', [value(prevSnap(pra), (s) => s.pts + s.reb + s.ast) <= 60, value(pra, (s) => s.pts + s.reb + s.ast) >= 61], [true, true]);
check('a busted under says so', (marks.get(at('u8.5 AST')?.id) || [])[0]?.text, '✗ Doncic u8.5 AST busted');
const short = buildFeed('nba', lal, 20);
check('a leg decided before the loaded plays is not mis-marked', legMarkers(short.items, [leg('nba.pts', 10.5)], false).size, 0);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
