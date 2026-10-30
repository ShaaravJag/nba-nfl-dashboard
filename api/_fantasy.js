// Your fantasy matchups: Luh Speds and PSK on ESPN, Gentelman on Sleeper.
// Each platform's own scoring decides the points; ESPN's NFL scoreboard
// supplies the game every player is in. Underscore prefix keeps Vercel from
// routing this file as an endpoint.
import { fetchJson, weekUrl, normalizeScoreboard } from './_espn.js';
import { minutesRemaining } from '../public/markets.js';

// Not secret -- the ids are in every league URL. The ESPN login is: it lives in
// the ESPN_S2 / ESPN_SWID env vars and never leaves the server.
export const LEAGUES = [
  { key: 'gentelman', name: 'Gentelman', platform: 'sleeper', leagueId: '1389371871832604672', userId: '1265879797083422720' },
  { key: 'luh_speds', name: 'Luh Speds', platform: 'espn', leagueId: '582872245', teamId: 4 },
  { key: 'psk', name: 'PSK', platform: 'espn', leagueId: '86645631', teamId: 12 },
];

const SLEEPER = 'https://api.sleeper.app/v1';
const SLEEPER_STATS = 'https://api.sleeper.com';
const espnLeagueUrl = (season, id) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${id}`;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'bet-tracker (personal use)', ...headers } });
  if (!res.ok) {
    const err = new Error(`${res.status} for ${url.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// What doesn't change minute to minute (league settings, projections, the
// player map) is kept for the life of a warm function instead of refetched on
// every 5-second poll.
const memo = new Map();
function cached(key, ms, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

// --- teams, positions, slots -----------------------------------------------------

// ESPN fantasy's proTeamId is ESPN's team id. Abbreviations follow ESPN's
// scoreboard, so Sleeper's WAS is mapped to WSH.
const ESPN_TEAMS = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU',
};
const SLEEPER_TEAM_ALIAS = { WAS: 'WSH' };
const espnAbbr = (proTeamId) => ESPN_TEAMS[proTeamId] || null;
const sleeperAbbr = (abbr) => (abbr ? SLEEPER_TEAM_ALIAS[abbr] || abbr : null);

const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const ESPN_SLOTS = { 0: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 20: 'BN', 21: 'IR', 23: 'FLEX' };
// ESPN's own lineup order: QB, RB, WR, TE, flex spots, D/ST, K.
const ESPN_SLOT_ORDER = [0, 2, 3, 4, 5, 6, 23, 7, 16, 17];
const SLEEPER_SLOTS = { SUPER_FLEX: 'SF', REC_FLEX: 'W/T', WRRB_FLEX: 'W/R', IDP_FLEX: 'IDP' };

const INJURY = {
  QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'O', INJURY_RESERVE: 'IR', SUSPENSION: 'SUS',
  Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUS',
};

/** "Kenneth Walker III" -> "K. Walker III". Team defenses keep their name. */
export function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2 || /D\/ST$/.test(full)) return String(full || '');
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
// Team logos and avatars are whatever league-mates uploaded; only https gets through.
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : null);

// --- stat lines ------------------------------------------------------------------

// Both platforms' raw stats map onto one set of names, so one function writes
// the line under every player.
const ESPN_STAT_IDS = {
  0: 'att', 1: 'cmp', 3: 'passYd', 4: 'passTd', 20: 'int', 23: 'rushAtt', 24: 'rushYd', 25: 'rushTd',
  53: 'rec', 42: 'recYd', 43: 'recTd', 72: 'fumLost', 83: 'fgm', 84: 'fga', 86: 'xpm', 87: 'xpa',
  95: 'defInt', 96: 'fumRec', 99: 'sack', 120: 'ptsAllow',
};
const SLEEPER_STAT_KEYS = {
  pass_att: 'att', pass_cmp: 'cmp', pass_yd: 'passYd', pass_td: 'passTd', pass_int: 'int',
  rush_att: 'rushAtt', rush_yd: 'rushYd', rush_td: 'rushTd', rec: 'rec', rec_yd: 'recYd', rec_td: 'recTd',
  fum_lost: 'fumLost', fgm: 'fgm', fga: 'fga', xpm: 'xpm', xpa: 'xpa',
  int: 'defInt', fum_rec: 'fumRec', sack: 'sack', def_td: 'defTd', pts_allow: 'ptsAllow',
};

function unify(raw, keys) {
  const out = {};
  for (const [k, name] of Object.entries(keys)) if (raw?.[k] != null) out[name] = Number(raw[k]) || 0;
  return out;
}

/** "6 REC, 100 YDS" -- what a player has done so far, in his position's order. */
export function statLine(pos, s = {}) {
  const v = (k) => Math.round((s[k] || 0) * 10) / 10;
  if (pos === 'K') return `${v('fgm')}/${v('fga')} FG · ${v('xpm')}/${v('xpa')} XP`;
  if (pos === 'DEF') {
    return [`${v('ptsAllow')} PA`, v('sack') && `${v('sack')} SCK`, v('defInt') && `${v('defInt')} INT`,
      v('fumRec') && `${v('fumRec')} FR`, v('defTd') && `${v('defTd')} TD`].filter(Boolean).join(', ');
  }
  const td = (k) => (v(k) ? `, ${v(k)} TD` : '');
  const parts = {
    pass: v('att') ? `${v('cmp')}/${v('att')}, ${v('passYd')} YDS${td('passTd')}${v('int') ? `, ${v('int')} INT` : ''}` : '',
    rush: v('rushAtt') || v('rushYd') || v('rushTd') ? `${v('rushAtt')} CAR, ${v('rushYd')} YDS${td('rushTd')}` : '',
    rec: v('rec') || v('recYd') || v('recTd') ? `${v('rec')} REC, ${v('recYd')} YDS${td('recTd')}` : '',
  };
  // A quarterback's runs read better as a short tail on the passing line.
  if (pos === 'QB' && parts.rush) parts.rush = `${v('rushYd')} RUSH${v('rushTd') ? `, ${v('rushTd')} RUSH TD` : ''}`;
  const order = pos === 'QB' ? ['pass', 'rush', 'rec'] : pos === 'RB' ? ['rush', 'rec', 'pass'] : ['rec', 'rush', 'pass'];
  const shown = order.map((k) => parts[k]).filter(Boolean);
  if (!shown.length) shown.push(pos === 'QB' ? '0/0, 0 YDS' : pos === 'RB' ? '0 CAR, 0 YDS' : '0 REC, 0 YDS');
  if (v('fumLost')) shown.push(`${v('fumLost')} FUM`);
  return shown.join(' · ');
}

// --- games ------------------------------------------------------------------------

/** The week's games keyed by team abbreviation, trimmed to what a player cell shows. */
export function gamesByTeam(board) {
  const out = {};
  for (const g of normalizeScoreboard('nfl', board)) {
    const slim = {
      id: g.id, start: g.start, state: g.state, period: g.period, clock: g.clock, detail: g.statusDetail,
      home: { abbr: g.home.abbr, score: g.home.score }, away: { abbr: g.away.abbr, score: g.away.score },
      weather: g.weather || null,
    };
    out[g.home.abbr] = slim;
    out[g.away.abbr] = slim;
  }
  return out;
}

/** Where a player's game stands, and how much of it is left (1 before kickoff, 0 at the end). */
export function gameStatus(game) {
  if (!game) return { status: 'bye', left: 0 };
  if (game.state === 'pre') return { status: 'pre', left: 1 };
  if (game.state === 'post') return { status: 'post', left: 0 };
  const q = game.period || 1;
  const played = q > 4 ? 60 : (q - 1) * 15 + (15 - Math.min(15, minutesRemaining(game.clock)));
  return { status: 'in', left: Math.max(0, Math.min(1, 1 - played / 60)) };
}

/** Points so far plus what the projection says the rest of the game is worth. */
export function liveProjection(p) {
  if (!p) return 0;
  if (p.status === 'post') return p.pts || 0;
  if (p.status === 'bye') return 0;
  if (p.status === 'pre') return p.proj || 0;
  return (p.pts || 0) + (p.proj || 0) * p.left;
}

// Normal model on the live projections. Each player's spread is proportional to
// his projection and shrinks with the game time he has left; the 0.9 makes a
// pregame 138.6 vs 105.9 come out near the 73% Sleeper showed for it.
const SPREAD = 0.9;
function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26, plenty for a percentage.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
export function winProbability(mine, theirs) {
  const proj = (list) => list.reduce((s, p) => s + liveProjection(p), 0);
  const variance = (list) => list.reduce((s, p) => (p ? s + (SPREAD * (p.proj || 0)) ** 2 * (p.left ?? 0) : s), 0);
  const diff = proj(mine) - proj(theirs);
  const sd = Math.sqrt(variance(mine) + variance(theirs));
  if (sd < 1e-6) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / sd);
}

// --- shared team shaping ------------------------------------------------------------

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

function teamSummary(starters) {
  const live = starters.filter(Boolean);
  const yet = live.filter((p) => p.status === 'pre');
  const counts = POS_ORDER.map((pos) => [pos, yet.filter((p) => p.pos === pos).length]).filter(([, n]) => n);
  return {
    proj: round(live.reduce((s, p) => s + liveProjection(p), 0)),
    yet: yet.length,
    inPlay: live.filter((p) => p.status === 'in').length,
    yetPos: counts.map(([pos, n]) => (n > 1 ? `${n} ${pos}` : pos)).join(', '),
  };
}

const pairUp = (a = [], b = [], slot) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ slot, a: a[i] || null, b: b[i] || null }));

// --- ESPN -------------------------------------------------------------------------

const espnPhoto = (id, abbr) => (id < 0
  ? `https://a.espncdn.com/i/teamlogos/nfl/500/${(abbr || '').toLowerCase()}.png`
  : `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${id}.png&w=96&h=70&scale=crop`);
const teamUrl = (abbr) => `https://www.espn.com/nfl/team/_/name/${(abbr || '').toLowerCase()}`;
const playerPage = (espnId) => `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(espnId)}`;

function espnPlayer(entry, week, games) {
  const p = entry.playerPoolEntry?.player || {};
  const team = espnAbbr(p.proTeamId);
  const pos = ESPN_POS[p.defaultPositionId] || '?';
  const stat = (source) => (p.stats || []).find((s) => s.statSourceId === source && s.scoringPeriodId === week);
  const actual = stat(0);
  const { status, left } = gameStatus(games[team]);
  const played = status === 'in' || status === 'post';
  return {
    id: String(p.id),
    name: shortName(p.fullName),
    full: p.fullName || '',
    pos,
    team,
    inj: INJURY[p.injuryStatus] || null,
    pts: actual ? round(actual.appliedTotal) : played ? 0 : null,
    proj: round(stat(1)?.appliedTotal ?? null),
    line: played ? statLine(pos, unify(actual?.stats, ESPN_STAT_IDS)) : '',
    img: espnPhoto(p.id, team),
    url: p.id < 0 ? teamUrl(team) : playerPage(p.id),
    status,
    left,
    slotId: entry.lineupSlotId,
  };
}

function espnSide(side, ctx) {
  if (!side) return null;
  const { teams, owners, week, games } = ctx;
  const t = teams.get(side.teamId) || {};
  const players = (side.rosterForCurrentScoringPeriod?.entries || []).map((e) => espnPlayer(e, week, games));
  const rank = (p) => ESPN_SLOT_ORDER.indexOf(p.slotId);
  const starters = players.filter((p) => rank(p) >= 0).sort((a, b) => rank(a) - rank(b));
  const rec = t.record?.overall || {};
  return {
    info: {
      name: t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || 'Team',
      owner: owners.get(t.primaryOwner) || '',
      avatar: safeUrl(t.logo),
      record: `${rec.wins ?? 0}-${rec.losses ?? 0}${rec.ties ? `-${rec.ties}` : ''}`,
      score: round(side.totalPointsLive ?? side.totalPoints ?? starters.reduce((s, p) => s + (p.pts || 0), 0)),
      espnProj: side.totalProjectedPointsLive ?? null,
      winProb: side.winProbability ?? null,
    },
    starters,
    bench: players.filter((p) => p.slotId === 20),
    ir: players.filter((p) => p.slotId === 21),
  };
}

// Your slots and theirs line up by slot type, an empty slot leaving a gap
// rather than shifting everyone below it.
function espnRows(a, b) {
  const rows = [];
  for (const id of ESPN_SLOT_ORDER) {
    rows.push(...pairUp(a.filter((p) => p.slotId === id), (b || []).filter((p) => p.slotId === id), ESPN_SLOTS[id]));
  }
  return rows;
}

export function normalizeEspn(raw, league, week, games) {
  const teams = new Map((raw.teams || []).map((t) => [t.id, t]));
  // Members carry notification settings and account ids; only a name comes out.
  const owners = new Map((raw.members || []).map((m) => [m.id, `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.displayName || '']));
  const mine = (m) => m.home?.teamId === league.teamId || m.away?.teamId === league.teamId;
  const matchup = (raw.schedule || []).find((m) => mine(m) && m.matchupPeriodId === week)
    || (raw.schedule || []).find((m) => mine(m) && (m.home?.rosterForCurrentScoringPeriod || m.away?.rosterForCurrentScoringPeriod));
  if (!matchup) return { error: 'No matchup this week.' };
  const homeIsMe = matchup.home?.teamId === league.teamId;
  const ctx = { teams, owners, week, games };
  const me = espnSide(homeIsMe ? matchup.home : matchup.away, ctx);
  const opp = espnSide(homeIsMe ? matchup.away : matchup.home, ctx);
  return finish(league, me, opp, espnRows(me.starters, opp?.starters));
}

async function loadEspn(league, season, week, gamesP) {
  const s2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;
  if (!s2 || !swid) return { error: 'The ESPN login isn\'t set up on the server yet.' };
  try {
    // mRoster would add every team's full season (3-5MB); the matchup views
    // already carry this week's lineups, and the filter drops other weeks.
    const [raw, games] = await Promise.all([
      getJson(`${espnLeagueUrl(season, league.leagueId)}?view=mMatchupScore&view=mLiveScoring&view=mTeam&scoringPeriodId=${week}`, {
        cookie: `espn_s2=${s2}; SWID=${swid}`,
        'x-fantasy-filter': JSON.stringify({ schedule: { filterMatchupPeriodIds: { value: [week] } } }),
      }),
      gamesP,
    ]);
    return normalizeEspn(raw, league, week, games);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return { error: 'ESPN turned down the login. The espn_s2 cookie may have expired.' };
    return { error: 'Couldn\'t reach ESPN.' };
  }
}

// --- Sleeper ----------------------------------------------------------------------

/** Sleeper's points for a stat line: every stat times the league's value for it. */
export function sleeperPoints(stats, scoring) {
  let total = 0;
  for (const [k, v] of Object.entries(stats || {})) if (scoring[k]) total += v * scoring[k];
  return round(total);
}

const sleeperPhoto = (pid, isDef) => (isDef
  ? `https://sleepercdn.com/images/team_logos/nfl/${pid.toLowerCase()}.png`
  : `https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`);

function sleeperPlayer(pid, ctx) {
  if (!pid || pid === '0') return null;
  const { stats, projections, scoring, players, espnIds, games } = ctx;
  const row = stats.get(pid);
  const info = row?.player || projections.get(pid)?.player || players?.[pid] || {};
  const isDef = info.position === 'DEF' || /^[A-Z]{2,3}$/.test(pid);
  const team = sleeperAbbr(isDef ? pid : info.team);
  const pos = isDef ? 'DEF' : info.position || '?';
  const full = isDef ? `${info.last_name || pid} D/ST` : [info.first_name, info.last_name].filter(Boolean).join(' ') || pid;
  const { status, left } = gameStatus(games[team]);
  const played = status === 'in' || status === 'post';
  const proj = projections.get(pid)?.stats;
  const espnId = espnIds?.[pid];
  return {
    id: pid,
    name: shortName(full),
    full,
    pos,
    team,
    inj: INJURY[info.injury_status] || null,
    pts: row ? sleeperPoints(row.stats, scoring) : played ? (ctx.official?.[pid] ?? 0) : null,
    proj: proj ? sleeperPoints(proj, scoring) : null,
    line: played ? statLine(pos, unify(row?.stats, SLEEPER_STAT_KEYS)) : '',
    img: sleeperPhoto(pid, isDef),
    url: isDef ? teamUrl(team) : espnId ? playerPage(espnId) : null,
    status,
    left,
  };
}

function sleeperSide(match, ctx) {
  if (!match) return null;
  const roster = ctx.rosters.find((r) => r.roster_id === match.roster_id) || {};
  const user = ctx.users.find((u) => u.user_id === roster.owner_id) || {};
  const pctx = { ...ctx, official: match.players_points };
  const starters = (match.starters || []).map((pid) => sleeperPlayer(pid, pctx));
  const reserve = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
  const bench = (match.players || []).filter((pid) => !(match.starters || []).includes(pid) && !reserve.has(pid));
  const s = roster.settings || {};
  return {
    info: {
      name: user.metadata?.team_name || user.display_name || `Team ${match.roster_id}`,
      owner: user.display_name ? `@${user.display_name}` : '',
      avatar: safeUrl(user.metadata?.avatar) || (user.avatar ? `https://sleepercdn.com/avatars/thumbs/${encodeURIComponent(user.avatar)}` : null),
      record: `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ''}`,
      score: round(match.custom_points ?? starters.reduce((t, p) => t + (p?.pts || 0), 0)),
      espnProj: null,
      winProb: null,
    },
    starters,
    bench: bench.map((pid) => sleeperPlayer(pid, pctx)).filter(Boolean),
    ir: [...(roster.reserve || [])].map((pid) => sleeperPlayer(pid, pctx)).filter(Boolean),
  };
}

export function normalizeSleeper(src, league, games) {
  const scoring = src.league?.scoring_settings || {};
  const byId = (rows) => new Map((rows || []).map((r) => [String(r.player_id), r]));
  const ctx = {
    stats: byId(src.stats), projections: byId(src.projections), scoring, players: src.players,
    espnIds: src.espnIds, games, rosters: src.rosters || [], users: src.users || [],
  };
  const roster = ctx.rosters.find((r) => r.owner_id === league.userId || (r.co_owners || []).includes(league.userId));
  const match = (src.matchups || []).find((m) => m.roster_id === roster?.roster_id);
  if (!match) return { error: 'No matchup this week.' };
  const theirs = match.matchup_id != null
    ? src.matchups.find((m) => m.matchup_id === match.matchup_id && m.roster_id !== match.roster_id) : null;
  const me = sleeperSide(match, ctx);
  const opp = sleeperSide(theirs, ctx);
  // Sleeper lines both lineups up by roster_positions, so slot i is slot i.
  const slots = (src.league?.roster_positions || []).filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const rows = me.starters.map((a, i) => ({ slot: SLEEPER_SLOTS[slots[i]] || slots[i] || 'FLEX', a, b: opp?.starters[i] || null }));
  return finish(league, me, opp, rows);
}

// Sleeper's player map is 5MB, so it is only for ESPN ids (the links on names)
// and loads in the background: a cold start skips the links rather than wait.
function sleeperEspnIds() {
  const load = cached('sleeper:espnIds', 12 * 3600e3, async () => {
    const all = await getJson(`${SLEEPER}/players/nfl`);
    const ids = {};
    for (const [pid, p] of Object.entries(all)) if (p?.espn_id) ids[pid] = String(p.espn_id);
    return ids;
  });
  return Promise.race([load, new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
}

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position[]=${p}`).join('&');

async function loadSleeper(league, season, week, gamesP) {
  try {
    const lid = league.leagueId;
    const [lg, users, rosters, matchups, stats, projections, espnIds, games] = await Promise.all([
      cached(`sleeper:league:${lid}`, 10 * 60e3, () => getJson(`${SLEEPER}/league/${lid}`)),
      cached(`sleeper:users:${lid}`, 10 * 60e3, () => getJson(`${SLEEPER}/league/${lid}/users`)),
      cached(`sleeper:rosters:${lid}`, 5 * 60e3, () => getJson(`${SLEEPER}/league/${lid}/rosters`)),
      getJson(`${SLEEPER}/league/${lid}/matchups/${week}`),
      // Live stats are cached 4s at Sleeper's edge; the matchups' own points are
      // cached 60s, so points come from these and the league's scoring.
      getJson(`${SLEEPER_STATS}/stats/nfl/${season}/${week}?season_type=regular&${POSITIONS}`),
      cached(`sleeper:proj:${season}:${week}`, 10 * 60e3, () => getJson(`${SLEEPER_STATS}/projections/nfl/${season}/${week}?season_type=regular&${POSITIONS}`)),
      sleeperEspnIds(),
      gamesP,
    ]);
    return normalizeSleeper({ league: lg, users, rosters, matchups, stats, projections, espnIds }, league, games);
  } catch {
    return { error: 'Couldn\'t reach Sleeper.' };
  }
}

// --- both -------------------------------------------------------------------------

function finish(league, me, opp, rows) {
  const meSum = teamSummary(me.starters);
  const oppSum = opp ? teamSummary(opp.starters) : null;
  const done = [...me.starters, ...(opp?.starters || [])].every((p) => !p || p.status === 'post' || p.status === 'bye');
  let win = me.info.winProb;
  if (done && opp) win = me.info.score > opp.info.score ? 1 : me.info.score < opp.info.score ? 0 : 0.5;
  else if (win == null && opp) win = winProbability(me.starters, opp.starters);
  // ESPN's own live projection wins where it has one; Sleeper's is ours.
  const team = (side, sum) => {
    const { espnProj, winProb, ...info } = side.info;
    return { ...info, ...sum, proj: round(espnProj ?? sum.proj) };
  };
  const strip = (p) => {
    if (!p) return null;
    const { slotId, ...rest } = p;
    return rest;
  };
  return {
    me: team(me, meSum),
    opp: opp ? team(opp, oppSum) : null,
    win: win == null ? null : round(win, 3),
    final: done,
    live: [...me.starters, ...(opp?.starters || [])].some((p) => p?.status === 'in'),
    rows: rows.map((r) => ({ slot: r.slot, a: strip(r.a), b: strip(r.b) })),
    bench: pairUp(me.bench, opp?.bench, 'BN').map((r) => ({ slot: r.slot, a: strip(r.a), b: strip(r.b) })),
    ir: pairUp(me.ir, opp?.ir, 'IR').map((r) => ({ slot: r.slot, a: strip(r.a), b: strip(r.b) })),
  };
}

/** Everything the Fantasy view shows, for one week. */
export async function loadFantasy({ week } = {}) {
  const nfl = await cached('sleeper:state', 10 * 60e3, () => getJson(`${SLEEPER}/state/nfl`));
  const season = Number(nfl.season) || new Date().getFullYear();
  const current = Number(nfl.week) || 1;
  const wk = Number.isInteger(week) && week >= 1 && week <= 18 ? week : current;
  // The scoreboard and every league load side by side.
  const gamesP = fetchJson(weekUrl('nfl', wk)).then(gamesByTeam);
  gamesP.catch(() => {});
  const leagues = await Promise.all(LEAGUES.map(async (lg) => {
    const data = lg.platform === 'espn' ? await loadEspn(lg, season, wk, gamesP) : await loadSleeper(lg, season, wk, gamesP);
    return { key: lg.key, name: lg.name, platform: lg.platform, decimals: lg.platform === 'sleeper' ? 2 : 1, ...data };
  }));
  const games = await gamesP;
  return { season, week: wk, currentWeek: current, fetchedAt: Date.now(), live: leagues.some((l) => l.live), games, leagues };
}
