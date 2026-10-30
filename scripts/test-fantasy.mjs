// Verifies the Fantasy view's data: Sleeper points computed from raw stats must
// equal Sleeper's own, ESPN stat lines must agree with ESPN's box scores, and
// lineups, game lines, win probability and the key check must read right.
//
// The ESPN checks need the league login: they run with ESPN_S2 / ESPN_SWID in
// the environment (or saved league JSON in FANTASY_FIXTURES), and skip otherwise.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEAGUES, sleeperPoints, normalizeSleeper, normalizeEspn, gamesByTeam, gameStatus, statLine,
  winProbability, shortName, loadFantasy,
} from '../api/_fantasy.js';
import { fetchJson, weekUrl, loadBox } from '../api/_espn.js';
import handler from '../api/fantasy.js';
import { gameLine, fantasyHtml } from '../public/fantasy.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const WEEK = 7;   // a finished week
const SEASON = 2026;
const gentelman = LEAGUES.find((l) => l.platform === 'sleeper');
const S = 'https://api.sleeper.app/v1';
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position[]=${p}`).join('&');
const games7 = gamesByTeam(await fetchJson(weekUrl('nfl', WEEK)));

// --- Sleeper: our points are Sleeper's points --------------------------------------
console.log('\nSleeper scoring');
const lid = gentelman.leagueId;
const [league, users, rosters, matchups, stats, projections] = await Promise.all([
  fetchJson(`${S}/league/${lid}`), fetchJson(`${S}/league/${lid}/users`), fetchJson(`${S}/league/${lid}/rosters`),
  fetchJson(`${S}/league/${lid}/matchups/${WEEK}`),
  fetchJson(`https://api.sleeper.com/stats/nfl/${SEASON}/${WEEK}?season_type=regular&${POS}`),
  fetchJson(`https://api.sleeper.com/projections/nfl/${SEASON}/${WEEK}?season_type=regular&${POS}`),
]);
const statsById = new Map(stats.map((r) => [String(r.player_id), r.stats]));
const off = [];
let compared = 0;
for (const m of matchups) {
  for (const [pid, official] of Object.entries(m.players_points || {})) {
    if (!statsById.has(pid)) continue;
    compared++;
    const ours = sleeperPoints(statsById.get(pid), league.scoring_settings);
    if (Math.abs(ours - official) > 0.011) off.push(`${pid}: ours ${ours}, Sleeper ${official}`);
  }
}
check(`every rostered player's points match Sleeper's own (${compared} players)`, off, []);
check('...which covers the whole league', compared > 100, true);

const gent = normalizeSleeper({ league, users, rosters, matchups, stats, projections }, gentelman, games7);
const myMatch = matchups.find((m) => m.roster_id === rosters.find((r) => r.owner_id === gentelman.userId).roster_id);
check('your team score equals Sleeper\'s matchup total', gent.me.score, Math.round(myMatch.points * 100) / 100);
check('Sleeper lineups follow the league\'s roster positions', gent.rows.map((r) => r.slot),
  league.roster_positions.filter((s) => s !== 'BN' && s !== 'IR'));
check('a finished week is final, with the winner at 100%', [gent.final, gent.win], [true, gent.me.score > gent.opp.score ? 1 : 0]);
const kick = gent.rows.find((r) => r.slot === 'K').a;
const kickProj = projections.find((r) => String(r.player_id) === kick.id);
check('a kicker\'s projection uses the league\'s 0.1/yard scoring, not generic PPR',
  kick.proj, sleeperPoints(kickProj.stats, league.scoring_settings));

// --- ESPN: stat lines agree with the box score ---------------------------------------
console.log('\nESPN leagues');
async function espnRaw(lg, week) {
  const dir = process.env.FANTASY_FIXTURES;
  const file = dir && join(dir, `espn_${lg.key}_wk${week}.json`);
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (!process.env.ESPN_S2 || !process.env.ESPN_SWID) return null;
  const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${lg.leagueId}`
    + `?view=mMatchupScore&view=mLiveScoring&view=mTeam&scoringPeriodId=${week}`, {
    headers: {
      cookie: `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`,
      'x-fantasy-filter': JSON.stringify({ schedule: { filterMatchupPeriodIds: { value: [week] } } }),
    },
  });
  return res.ok ? res.json() : null;
}

// The box score's line for a player, written by the same function.
function boxLine(box, id, pos) {
  const s = {};
  for (const team of box.teams) {
    for (const g of team.groups) {
      const row = g.rows.find((r) => r.id === id);
      if (!row) continue;
      const col = (label) => row.stats[g.labels.indexOf(label)];
      const pair = (label) => String(col(label) || '0/0').split('/').map(Number);
      if (g.name === 'passing') { [s.cmp, s.att] = pair('C/ATT'); s.passYd = +col('YDS'); s.passTd = +col('TD'); s.int = +col('INT'); }
      if (g.name === 'rushing') { s.rushAtt = +col('CAR'); s.rushYd = +col('YDS'); s.rushTd = +col('TD'); }
      if (g.name === 'receiving') { s.rec = +col('REC'); s.recYd = +col('YDS'); s.recTd = +col('TD'); }
      if (g.name === 'fumbles') s.fumLost = +col('LOST');
      if (g.name === 'kicking') { [s.fgm, s.fga] = pair('FG'); [s.xpm, s.xpa] = pair('XP'); }
    }
  }
  return statLine(pos, s);
}

for (const lg of LEAGUES.filter((l) => l.platform === 'espn')) {
  const raw = await espnRaw(lg, WEEK);
  if (!raw) { console.log(`SKIP  ${lg.name} (no ESPN login or fixture)`); continue; }
  const l = normalizeEspn(raw, lg, WEEK, games7);
  check(`${lg.name}: lineup order is ESPN's`, l.rows.map((r) => r.slot), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K']);
  const sum = (side) => Math.round(l.rows.reduce((t, r) => t + (r[side]?.pts || 0), 0) * 100) / 100;
  check(`${lg.name}: both scores are the sum of the starters`, [l.me.score, l.opp.score], [sum('a'), sum('b')]);
  check(`${lg.name}: members come out as names only`, JSON.stringify(l).includes('notificationSettings'), false);
  const boxes = new Map();
  const wrong = [];
  let lines = 0;
  for (const p of l.rows.flatMap((r) => [r.a, r.b]).filter((p) => p && p.pos !== 'DEF' && p.status === 'post')) {
    const gid = games7[p.team].id;
    if (!boxes.has(gid)) boxes.set(gid, await loadBox('nfl', gid, 1));
    const want = boxLine(boxes.get(gid), p.id, p.pos);
    lines++;
    // ESPN's box score drops a player with no stats at all.
    if (p.line !== want && !(p.pts === 0 && /^0/.test(p.line))) wrong.push(`${p.name}: "${p.line}" vs box "${want}"`);
  }
  check(`${lg.name}: ${lines} stat lines match ESPN's box scores`, wrong, []);
}

// --- shaping -------------------------------------------------------------------------
console.log('\nGames, lines and lineups');
const g = (state, extra = {}) => ({ id: '1', start: '2026-11-01T18:00:00Z', state, period: 3, clock: '7:30', detail: '', home: { abbr: 'BUF', score: 14 }, away: { abbr: 'BAL', score: 17 }, ...extra });
check('before kickoff the whole game is left', gameStatus(g('pre')), { status: 'pre', left: 1 });
check('7:30 into the 3rd, 37.5% is left', gameStatus(g('in')), { status: 'in', left: 0.375 });
check('at halftime, half', gameStatus(g('in', { period: 2, clock: '0:00' })).left, 0.5);
check('in overtime, nothing', gameStatus(g('in', { period: 5, clock: '8:00' })).left, 0);
check('no game is a bye', gameStatus(undefined), { status: 'bye', left: 0 });
const games = { BAL: g('in'), BUF: g('in') };
check('a live game reads team score first', gameLine({ team: 'BAL' }, games), 'BAL 17-14 BUF · 7:30 3rd');
check('...from either side', gameLine({ team: 'BUF' }, games), 'BUF 14-17 BAL · 7:30 3rd');
check('halftime says so', gameLine({ team: 'BAL' }, { BAL: g('in', { detail: 'Halftime', period: 2, clock: '0:00' }) }), 'BAL 17-14 BUF · Half');
check('a final', gameLine({ team: 'BUF' }, { BUF: g('post') }), 'Final · BUF 14-17 BAL');
check('an upcoming game: day, time, opponent, forecast', /^Sun \d{1,2}:00 [AP]M vs BAL · 65°$/.test(gameLine({ team: 'BUF' }, { BUF: g('pre', { weather: { temp: 65 } }) })), true);
check('a bye', gameLine({ team: 'NO' }, games), 'Bye');
check('a receiver\'s line', statLine('WR', { rec: 6, recYd: 100 }), '6 REC, 100 YDS');
check('a quarterback\'s runs trail his passing', statLine('QB', { cmp: 19, att: 30, passYd: 212, passTd: 2, rushAtt: 5, rushYd: 31 }), '19/30, 212 YDS, 2 TD · 31 RUSH');
check('a back with catches', statLine('RB', { rushAtt: 12, rushYd: 58, rec: 2, recYd: 14, fumLost: 1 }), '12 CAR, 58 YDS · 2 REC, 14 YDS · 1 FUM');
check('a kicker', statLine('K', { fgm: 2, fga: 3, xpm: 3, xpa: 3 }), '2/3 FG · 3/3 XP');
check('a defense', statLine('DEF', { ptsAllow: 10, sack: 4, defInt: 1 }), '10 PA, 4 SCK, 1 INT');
check('names shorten, suffixes stay', [shortName('Kenneth Walker III'), shortName('Amon-Ra St. Brown'), shortName('Vikings D/ST')], ['K. Walker III', 'A. St. Brown', 'Vikings D/ST']);

// --- win probability -------------------------------------------------------------------
console.log('\nWin probability');
const pre = (projs) => projs.map((proj) => ({ status: proj ? 'pre' : 'bye', proj, pts: null, left: proj ? 1 : 0 }));
// Your week 8 Gentelman matchup before kickoff, which Sleeper put at 73%.
const mine = pre([20.38, 12.04, 10.58, 22.44, 18.36, 11.44, 13.72, 11.16, 10.86, 8.05]);
const theirs = pre([16.76, 20.66, 9.84, 0, 12.32, 10.17, 10.09, 9.98, 10.22, 6.34]);
const p = winProbability(mine, theirs);
check(`Sleeper's 73% pregame example comes out close (${(p * 100).toFixed(1)}%)`, p > 0.68 && p < 0.78, true);
check('equal projections are a coin flip', Math.abs(winProbability(pre([15, 15]), pre([15, 15])) - 0.5) < 1e-6, true);
check('the other side of it', Math.abs(winProbability(theirs, mine) - (1 - p)) < 1e-9, true);
const late = mine.map((x) => ({ ...x, status: 'in', pts: x.proj, left: 0.1 }));
check('the same lead late in the games is surer', winProbability(late, theirs.map((x) => ({ ...x, status: x.proj ? 'in' : 'bye', pts: x.proj, left: x.proj ? 0.1 : 0 }))) > p, true);

// --- the view renders without overlap-prone markup -----------------------------------------
const view = fantasyHtml({ data: { week: 7, currentWeek: 8, games: games7, leagues: [{ key: 'gentelman', name: 'Gentelman', decimals: 2, ...gent }] } }, { league: 'gentelman' });
check('the matchup renders a row per starter', (view.match(/class="fx-row"/g) || []).length, gent.rows.length);
check('a final shows who won', /Final · You (won|lost) by/.test(view), true);

// --- the key ------------------------------------------------------------------------------
console.log('\nThe key');
function call(headers = {}) {
  const res = { headers: {}, code: 200, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
  return handler({ url: `/api/fantasy?week=${WEEK}`, headers: { host: 'test', ...headers } }, res).then(() => res);
}
const saved = process.env.FANTASY_KEY;
delete process.env.FANTASY_KEY;
check('with no key configured, the server refuses', (await call({ 'x-fantasy-key': 'x' })).code, 503);
process.env.FANTASY_KEY = 'test-key-for-checks';
const none = await call();
check('no key: 401 and no league data', [none.code, none.body.leagues], [401, undefined]);
check('a wrong key: 401', (await call({ 'x-fantasy-key': 'nope' })).code, 401);
const ok = await call({ 'x-fantasy-key': 'test-key-for-checks' });
check('the right key: all three leagues', [ok.code, ok.body.leagues?.map((l) => l.key)], [200, ['gentelman', 'luh_speds', 'psk']]);
check('...never cached at the edge', ok.headers['cache-control'], 'private, no-store');
if (saved) process.env.FANTASY_KEY = saved; else delete process.env.FANTASY_KEY;

// --- size --------------------------------------------------------------------------------------
const all = await loadFantasy({ week: WEEK });
check(`the whole payload stays small (${Math.round(JSON.stringify(all).length / 1024)}KB)`, JSON.stringify(all).length < 80000, true);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
