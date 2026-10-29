// Verifies the box score and scoreboard normalizers against real finished games
// (stable numbers) plus a synthetic stretch of plays for the scoring-run maths.
import { loadBox, scoringRun, fetchJson, scoreboardUrl, normalizeScoreboard, weekInfo } from '../api/_espn.js';
import { boxScoreHtml, sortGames, otherGamesHtml } from '../public/scores.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

// --- NBA: LAL 132 @ UTAH 123, 2026-10-25 ----------------------------------
const nba = await loadBox('nba', '401909861');
const [lal, utah] = nba.teams;
const table = (team) => team.groups[0];
const col = (team, label) => table(team).labels.indexOf(label);
const row = (team, name) => table(team).rows.find((r) => r.name === name);

console.log(`\n${nba.away.abbr} ${nba.away.score} @ ${nba.home.abbr} ${nba.home.score} (${nba.statusDetail})\n`);
check('NBA columns are exactly ESPN\'s', table(lal).labels, ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-']);
check('away team listed first', [lal.abbr, utah.abbr], ['LAL', 'UTAH']);
check('five starters per side', nba.teams.map((t) => table(t).rows.filter((r) => r.starter).length), [5, 5]);
check('Ziaire Williams scored 11', row(lal, 'Ziaire Williams')?.stats[col(lal, 'PTS')], '11');
check('Walker Kessler pulled 7 boards', row(lal, 'Walker Kessler')?.stats[col(lal, 'REB')], '7');
check('every DNP row carries a reason', table(lal).rows.filter((r) => r.dnp).every((r) => r.reason), true);
check('DNP rows have no stat line', table(lal).rows.filter((r) => r.dnp).every((r) => r.stats.length === 0), true);
check('PTS total equals the final score', nba.teams.map((t) => Number(table(t).totals[col(t, 'PTS')])), [nba.away.score, nba.home.score]);
check('FG% under a 40-82 total is 49%', [table(lal).totals[col(lal, 'FG')], table(lal).percents[col(lal, 'FG')]], ['40-82', '49%']);
check('percent row only fills the shooting columns', table(lal).percents.filter(Boolean).length, 3);
check('team stats present for both sides', nba.teams.map((t) => t.teamStats.length > 20), [true, true]);
check('linescores add up to the score', [nba.away, nba.home].map((s) => s.linescores.reduce((a, b) => a + b, 0) === s.score), [true, true]);
check('records come through', [nba.away.record, nba.home.record].every(Boolean), true);
check('no run reported once final', nba.run, null);
check('box payload, feed aside, stays under 15KB', JSON.stringify({ ...nba, feed: undefined }).length < 15000, true);

// --- NFL: NE @ CHI, 2026-10-25 ----------------------------------------------
const nfl = await loadBox('nfl', '401873010');
const ne = nfl.teams[0];
const passing = ne.groups.find((g) => g.name === 'passing');
console.log(`\n${nfl.away.abbr} ${nfl.away.score} @ ${nfl.home.abbr} ${nfl.home.score} (${nfl.statusDetail})\n`);
check('NFL keeps ESPN\'s passing columns', passing?.labels, ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG']);
check('NFL passing total is 24/31', passing?.totals[0], '24/31');
check('empty NFL groups are dropped', ['fumbles', 'interceptions'].some((n) => ne.groups.some((g) => g.name === n)), false);
check('NFL keeps the groups that have rows', ['passing', 'rushing', 'receiving', 'defensive'].every((n) => ne.groups.some((g) => g.name === n)), true);
check('NFL tables carry ESPN titles', passing?.title, 'New England Passing');
check('no shooting percents for NFL', passing?.percents, null);

// --- scoring runs: a synthetic second quarter -------------------------------
// Away goes on a 13-2 burst from 8:30 to 5:00, then the clock reads 3:00.
const play = (period, clock, away, home) => ({ scoringPlay: true, period: { number: period }, clock: { displayValue: clock }, awayScore: away, homeScore: home });
const plays = [
  play(2, '11:00', 30, 28),
  play(2, '9:00', 30, 30),
  play(2, '8:30', 33, 30),
  play(2, '8:00', 35, 30),
  play(2, '7:15', 35, 32),
  play(2, '6:40', 38, 32),
  play(2, '6:00', 40, 32),
  play(2, '5:00', 43, 32),
];
const at = (clock) => ({ header: { competitions: [{ status: { period: 2, displayClock: clock } }] }, plays });
const sides = [{ abbr: 'HOM' }, { abbr: 'AWY' }];
console.log('');
check('finds the 13-2 run and how long it has lasted', scoringRun(at('3:00'), ...sides), { teamAbbr: 'AWY', for: 13, against: 2, span: '5:30' });
check('sub-minute clock keeps the window right (8-0 since 6:40)', scoringRun(at('56.2'), ...sides), { teamAbbr: 'AWY', for: 8, against: 0, span: '5:44' });
// Away outscores home 19-9 over six minutes, but home keeps answering -- a
// long back-and-forth, not a run, so nothing should be reported.
let a = 0; let h = 0;
const steady = [['a', 3], ['a', 2], ['h', 3], ['a', 3], ['a', 2], ['h', 2], ['a', 3], ['a', 2], ['h', 2], ['a', 2], ['a', 2], ['h', 2]]
  .map(([team, pts], i) => { if (team === 'a') a += pts; else h += pts; return play(2, `${9 - Math.floor(i / 2)}:${i % 2 ? '00' : '30'}`, a, h); });
check('19-9 with the other side answering is not a run', scoringRun({ header: at('3:00').header, plays: steady }, ...sides), null);
const seesaw = [play(2, '6:00', 2, 0), play(2, '5:30', 2, 2), play(2, '5:00', 4, 2), play(2, '4:30', 4, 4)];
check('trading baskets is not a run', scoringRun({ header: at('4:00').header, plays: seesaw }, ...sides), null);

// --- scoreboard + NFL week --------------------------------------------------
const board = normalizeScoreboard('nba', await fetchJson(scoreboardUrl('nba', '20261025')));
const tile = board[0];
console.log('');
check('scoreboard tile has what a REAL tile shows', ['period', 'clock', 'broadcast', 'odds', 'statusDetail'].every((k) => k in tile) && ['short', 'record', 'logo', 'winner'].every((k) => k in tile.home), true);
check('a finished day reports every game final', board.every((g) => g.state === 'post'), true);
check('each final has exactly one winner', board.every((g) => g.home.winner !== g.away.winner), true);
check('League Pass never wins the broadcast pick', board.some((g) => /league pass/i.test(g.broadcast || '')), false);
const week = weekInfo(await fetchJson(scoreboardUrl('nfl')));
check('NFL week has a label, dates and bounds', [Boolean(week.label), Boolean(week.detail), week.first, week.last], [true, true, 1, 18]);

// --- box score layout: On court while live, Starters otherwise ---------------
{
  // Split the team table into sections: title, players in order, and which
  // players carry the starter dot.
  const sections = (html) => {
    const table = html.slice(html.indexOf('<table class="box">'), html.indexOf('</table>', html.indexOf('<table class="box">')));
    return table.split('<tr class="sec">').slice(1).map((part) => ({
      title: (part.match(/<th class="name">([^<]*)<\/th>/) || [])[1],
      players: [...part.matchAll(/class="pn"[^>]*>([^<]*)</g)].map((m) => m[1]),
      dotted: [...part.matchAll(/<span class="starter-dot"[^>]*><\/span><a class="pn"[^>]*>([^<]*)</g)].map((m) => m[1]),
      links: [...part.matchAll(/<a class="pn" href="([^"]*)"/g)].map((m) => m[1]),
    }));
  };
  const render = (box) => boxScoreHtml(box, { side: 'away', tracked: new Map(), error: null, from: 'games' });
  const names = (rows) => rows.map((r) => r.short);

  const final = render(nba);
  console.log('');
  check('final: ESPN\'s Starters and Bench', sections(final).map((x) => x.title), ['Starters', 'Bench']);
  check('final: no starter dots, the heading says it', final.includes('starter-dot'), false);

  // The same box mid-game, with three starters and two subs on the floor.
  const live = structuredClone(nba);
  live.state = 'in';
  const rows = live.teams[0].groups[0].rows;
  const starters = rows.filter((r) => r.starter);
  const subs = rows.filter((r) => !r.starter && !r.dnp);
  const floor = [...starters.slice(0, 3), ...subs.slice(0, 2)];
  for (const r of rows) r.onCourt = floor.includes(r);
  const html = render(live);
  const [court, bench] = sections(html);
  check('live: the first section is On court', court?.title, 'On court');
  check('live: On court holds exactly the five on the floor', court?.players, names(rows.filter((r) => r.onCourt)));
  check('live: starters who are sitting lead the Bench', bench?.players.slice(0, 2), names(starters.slice(3)));
  check('live: the dot marks every starter, wherever he is', [...court.dotted, ...bench.dotted].sort(), names(starters).sort());
  check('live: subs on the floor carry no dot', court.dotted.filter((n) => names(subs.slice(0, 2)).includes(n)), []);
  check('live: a legend says what the dot means', html.includes('Started the game'), true);
  check('player names link to their ESPN page', court.links[0], `https://www.espn.com/nba/player/_/id/${rows.find((r) => r.onCourt).id}`);

  const unknown = structuredClone(live);
  for (const r of unknown.teams[0].groups[0].rows) r.onCourt = false;
  check('live with no lineup falls back to Starters', sections(render(unknown)).map((x) => x.title), ['Starters', 'Bench']);
}

// --- Games tab order: pins, then your bets, then the rest ----------------------
{
  const g = (id, state, start) => ({ id, sport: 'nba', state, start });
  const games = [g('final', 'post', '1'), g('pinnedFinal', 'post', '2'), g('liveBet', 'in', '4'), g('liveLate', 'in', '3'),
    g('liveEarly', 'in', '2'), g('later', 'pre', '6'), g('soonBet', 'pre', '7'), g('soon', 'pre', '5'), g('finishedBet', 'post', '0')];
  const ctx = { pins: { 'nba:pinnedFinal': 1 }, legCounts: new Map([['liveBet', 2], ['finishedBet', 1], ['soonBet', 1]]) };
  console.log('');
  check('pinned, live with bets, live, upcoming (bets first), finals -- each earliest first', sortGames(games, ctx).map((x) => x.id),
    ['pinnedFinal', 'liveBet', 'liveEarly', 'liveLate', 'soonBet', 'soon', 'later', 'finishedBet', 'final']);
  check('nothing pinned or bet on: live, upcoming, finals', sortGames(games).map((x) => x.id),
    ['liveEarly', 'liveLate', 'liveBet', 'soon', 'later', 'soonBet', 'finishedBet', 'final', 'pinnedFinal']);
}

// --- strip of other games above a box score -----------------------------------
{
  const side = (abbr, score, winner, record) => ({ abbr, score, winner, record, logo: '' });
  const g = (id, state, start, extra = {}) => ({ id, sport: 'nba', state, start, statusDetail: state === 'post' ? 'Final' : state === 'in' ? '3:33 - 3rd' : '', away: side('AWY', 101, true, '3-1'), home: side('HOM', 99, false, '1-2'), ...extra });
  const games = [g('a', 'post', '2026-10-28T23:00Z'), g('b', 'in', '2026-10-29T00:00Z'), g('c', 'pre', '2026-10-29T02:30Z')];
  const html = otherGamesHtml(games, 'a');
  const chips = [...html.matchAll(/class="gs-chip ([^"]*)" data-open-game="nba:(\w+)"/g)].map((m) => [m[2], m[1].trim()]);
  console.log('');
  check('the strip follows the Games tab order', chips.map((c) => c[0]), ['b', 'c', 'a']);
  check('the open game is marked', chips.find((c) => c[0] === 'a')[1], 'on');
  check('a final shows Final and the score', /Final<\/span><span class="gs-score">.*101.*99/s.test(html.slice(html.indexOf('nba:a'))), true);
  check('an upcoming game shows records, not a score', /3-1.*1-2/s.test(html.slice(html.indexOf('nba:c'), html.indexOf('nba:a'))), true);
}

// --- before tip-off: roster first, injury report last ---------------------------
{
  const pre = { ...structuredClone(nba), state: 'pre', odds: null, venue: '', teams: [],
    injuries: [{ teamAbbr: nba.home.abbr, id: 'p2', name: 'Hurt Guy', status: 'Out', detail: 'Knee' }],
    rosters: [[{ id: 'p1', short: 'A. Away', jersey: '1', pos: 'G', ht: "6' 3\"", wt: '190 lbs', age: 25, exp: 0, college: 'Duke', group: null }],
      [{ id: 'p2', short: 'H. Home', jersey: '2', pos: 'F', ht: "6' 8\"", wt: '220 lbs', age: 30, exp: 8, college: '', group: null }]] };
  const html = (side) => boxScoreHtml(pre, { side, tracked: new Map(), from: 'games' });
  console.log('');
  check('pre-game shows the away roster by default', html('feed').includes('A. Away') && !html('feed').includes('H. Home'), true);
  check('the home tab shows the home roster, injured player flagged', /H\. Home.*ros-inj out/s.test(html('home')), true);
  check('a rookie reads R for experience', html('away').includes('<td>R</td>'), true);
  check('the injury report comes after the roster', html('home').indexOf('Injury report') > html('home').indexOf('roster'), true);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
