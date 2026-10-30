// Shared ESPN fetching + normalization. Underscore prefix keeps Vercel from
// routing this file as an endpoint.
import { minutesRemaining } from '../public/markets.js';
import { buildFeed } from './_feed.js';

export const SPORTS = {
  nba: { path: 'basketball/nba', periods: 4, periodName: 'Q', label: 'NBA' },
  nfl: { path: 'football/nfl', periods: 4, periodName: 'Q', label: 'NFL' },
};

const UA = 'bet-tracker (personal use)';

export async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return res.json();
}

const base = (sport) => `https://site.api.espn.com/apis/site/v2/sports/${SPORTS[sport].path}`;

export const summaryUrl = (sport, eventId) => `${base(sport)}/summary?event=${encodeURIComponent(eventId)}`;
export const scoreboardUrl = (sport, date) => `${base(sport)}/scoreboard${date ? `?dates=${date}&limit=100` : '?limit=100'}`;
export const weekUrl = (sport, week, seasonType = 2) => `${base(sport)}/scoreboard?seasontype=${seasonType}&week=${week}&limit=100`;
export const rosterUrl = (sport, teamId) => `${base(sport)}/teams/${teamId}/roster`;

// The sports day rolls over at 6am Eastern, so a 1am box score still belongs to
// the previous night's slate.
export function sportsDay(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getHours() < 6) et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
}

// --- stat normalization -------------------------------------------------

// ESPN returns stats as a positional array alongside a `keys` array. These maps
// turn that into named fields. A key holding two values ("3-9", "19/30") maps to
// a pair of names.
const NBA_KEYS = {
  minutes: 'min',
  points: 'pts',
  rebounds: 'reb',
  assists: 'ast',
  turnovers: 'to',
  steals: 'stl',
  blocks: 'blk',
  offensiveRebounds: 'oreb',
  defensiveRebounds: 'dreb',
  fouls: 'pf',
  plusMinus: 'pm',
  'fieldGoalsMade-fieldGoalsAttempted': ['fgm', 'fga'],
  'threePointFieldGoalsMade-threePointFieldGoalsAttempted': ['fg3m', 'fg3a'],
  'freeThrowsMade-freeThrowsAttempted': ['ftm', 'fta'],
};

// NFL stats are grouped, and the same key means different things in different
// groups ("interceptions" is thrown in passing, caught in interceptions).
const NFL_GROUPS = {
  passing: {
    'completions/passingAttempts': ['cmp', 'passAtt'],
    passingYards: 'passYds',
    passingTouchdowns: 'passTd',
    interceptions: 'passInt',
    'sacks-sackYardsLost': ['sacked', 'sackYdsLost'],
  },
  rushing: {
    rushingAttempts: 'rushAtt',
    rushingYards: 'rushYds',
    rushingTouchdowns: 'rushTd',
    longRushing: 'rushLong',
  },
  receiving: {
    receptions: 'rec',
    receivingYards: 'recYds',
    receivingTouchdowns: 'recTd',
    receivingTargets: 'tgt',
    longReception: 'recLong',
  },
  fumbles: { fumbles: 'fum', fumblesLost: 'fumLost' },
  defensive: {
    totalTackles: 'tackles',
    soloTackles: 'soloTackles',
    sacks: 'sacks',
    tacklesForLoss: 'tfl',
    passesDefended: 'pd',
    QBHits: 'qbHits',
    defensiveTouchdowns: 'defTd',
  },
  interceptions: {
    interceptions: 'intCaught',
    interceptionYards: 'intYds',
    interceptionTouchdowns: 'intTd',
  },
  kicking: {
    'fieldGoalsMade/fieldGoalAttempts': ['fgm', 'fga'],
    longFieldGoalMade: 'longFg',
    'extraPointsMade/extraPointAttempts': ['xpm', 'xpa'],
    totalKickingPoints: 'kickPts',
  },
  kickReturns: { kickReturns: 'kr', kickReturnYards: 'krYds', longKickReturn: 'krLong', kickReturnTouchdowns: 'krTd' },
  puntReturns: { puntReturns: 'pr', puntReturnYards: 'prYds', longPuntReturn: 'prLong', puntReturnTouchdowns: 'prTd' },
};

function toNum(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s || s === '--' || s === '-') return 0;
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
}

function assign(out, mapping, key, raw) {
  const target = mapping[key];
  if (!target) return;
  if (Array.isArray(target)) {
    const parts = String(raw ?? '').split(key.includes('/') ? '/' : '-');
    target.forEach((name, i) => { out[name] = toNum(parts[i]); });
  } else {
    out[target] = toNum(raw);
  }
}

function statsFromGroup(mapping, keys, values) {
  const out = {};
  (keys || []).forEach((key, i) => assign(out, mapping, key, values[i]));
  return out;
}

// --- game normalization -------------------------------------------------

function pickLogo(team) {
  if (team.logo) return team.logo;
  if (Array.isArray(team.logos) && team.logos.length) return team.logos[0].href;
  return null;
}

// The scoreboard calls it `records`, the game summary `record`; either way the
// season record is the "total" entry.
function recordOf(competitor) {
  const list = competitor.records || competitor.record || [];
  const total = list.find((r) => r.type === 'total' || r.name === 'overall') || list[0];
  return total?.summary || total?.displayValue || '';
}

// REAL shows one network per game: the national feed if there is one, else the
// home team's local channel, else the visitors'. League Pass carries every game
// and says nothing, so it never wins. Handles both ESPN shapes: the
// scoreboard's { market: 'home', names: [...] } and the summary's
// { market: { type: 'Home' }, media: { shortName } }.
function pickBroadcast(list) {
  const entries = (list || []).map((b) => ({
    market: String(b.market?.type || b.market || '').toLowerCase(),
    names: b.names || [b.media?.shortName].filter(Boolean),
  }));
  for (const market of ['national', 'home', 'away']) {
    for (const entry of entries) {
      if (entry.market !== market) continue;
      const name = entry.names.find((n) => n && !/league pass/i.test(n));
      if (name) return name;
    }
  }
  return null;
}

function sideOf(competitor) {
  const team = competitor.team || {};
  return {
    id: String(team.id ?? ''),
    abbr: team.abbreviation || team.shortDisplayName || '',
    name: team.displayName || team.name || '',
    short: team.shortDisplayName || team.name || '',
    score: toNum(competitor.score),
    record: recordOf(competitor),
    winner: !!competitor.winner,
    color: team.color ? `#${team.color}` : null,
    logo: pickLogo(team),
    linescores: (competitor.linescores || []).map((l) => toNum(l.displayValue ?? l.value)),
  };
}

// Replays substitution plays from the starting five so we know who is on the
// floor right now. ESPN tags subs with type id 584; participants[0] enters,
// participants[1] leaves.
function onCourtIds(summary, players) {
  const live = new Set();
  for (const p of Object.values(players)) if (p.starter) live.add(p.id);
  for (const play of summary.plays || []) {
    if (String(play?.type?.id) !== '584') continue;
    const [entering, exiting] = play.participants || [];
    const inId = entering?.athlete?.id && String(entering.athlete.id);
    const outId = exiting?.athlete?.id && String(exiting.athlete.id);
    if (inId) live.add(inId);
    if (outId) live.delete(outId);
  }
  return live;
}

export function normalizeGame(sport, summary) {
  const comp = summary?.header?.competitions?.[0] || {};
  const status = comp.status || {};
  const type = status.type || {};
  const competitors = comp.competitors || [];
  const home = sideOf(competitors.find((c) => c.homeAway === 'home') || competitors[0] || {});
  const away = sideOf(competitors.find((c) => c.homeAway === 'away') || competitors[1] || {});

  const players = {};
  for (const teamBlock of summary?.boxscore?.players || []) {
    const abbr = teamBlock.team?.abbreviation || '';
    const teamId = String(teamBlock.team?.id ?? '');
    for (const group of teamBlock.statistics || []) {
      const mapping = sport === 'nba' ? NBA_KEYS : NFL_GROUPS[group.name] || {};
      for (const entry of group.athletes || []) {
        const athlete = entry.athlete || {};
        const id = String(athlete.id ?? '');
        if (!id) continue;
        const player = players[id] || (players[id] = {
          id,
          name: athlete.displayName || athlete.shortName || '',
          short: athlete.shortName || '',
          teamAbbr: abbr,
          teamId,
          pos: athlete.position?.abbreviation || entry.position || '',
          starter: !!entry.starter,
          dnp: !!entry.didNotPlay,
          ejected: !!entry.ejected,
          stats: {},
        });
        if (entry.starter) player.starter = true;
        if (entry.ejected) player.ejected = true;
        if (!entry.didNotPlay) player.dnp = false;
        Object.assign(player.stats, statsFromGroup(mapping, group.keys, entry.stats || []));
      }
    }
  }

  const state = type.state || 'pre';
  if (sport === 'nba' && state === 'in') {
    const live = onCourtIds(summary, players);
    for (const player of Object.values(players)) player.onCourt = live.has(player.id);
  }

  // NFL: who has the ball right now.
  const possessionId = comp.situation?.possession ?? summary?.drives?.current?.team?.id ?? null;

  return {
    id: String(summary?.header?.id ?? comp.id ?? ''),
    sport,
    state,
    completed: !!type.completed,
    statusDetail: type.shortDetail || type.detail || type.description || '',
    period: toNum(status.period),
    clock: status.displayClock || '',
    home,
    away,
    possession: possessionId ? String(possessionId) : null,
    players,
    injuries: Object.fromEntries(injuryEntries(summary).map(({ id, status, detail }) => [id, { status, detail }])),
  };
}

export async function loadGame(sport, eventId) {
  return normalizeGame(sport, await fetchJson(summaryUrl(sport, eventId)));
}

// --- scoreboard ---------------------------------------------------------

export function normalizeScoreboard(sport, board) {
  return (board?.events || []).map((event) => {
    const comp = event.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const home = sideOf(competitors.find((c) => c.homeAway === 'home') || competitors[0] || {});
    const away = sideOf(competitors.find((c) => c.homeAway === 'away') || competitors[1] || {});
    const status = event.status || comp.status || {};
    const type = status.type || {};
    const state = type.state || 'pre';
    const live = state === 'in';
    const situation = comp.situation || {};
    const odds = comp.odds?.[0];
    const tile = (side) => ({
      id: side.id, abbr: side.abbr, name: side.name, short: side.short,
      score: side.score, logo: side.logo, record: side.record, winner: side.winner,
    });
    return {
      id: String(event.id),
      sport,
      name: event.shortName || event.name || '',
      start: event.date,
      state,
      completed: !!type.completed,
      statusDetail: type.shortDetail || '',
      period: toNum(status.period),
      clock: status.displayClock || '',
      broadcast: pickBroadcast(comp.broadcasts),
      odds: state === 'pre' && odds ? { spread: odds.details || null, total: odds.overUnder ?? null } : null,
      possession: sport === 'nfl' && live && situation.possession ? String(situation.possession) : null,
      redZone: sport === 'nfl' && live && !!situation.isRedZone,
      downDistance: sport === 'nfl' && live ? situation.shortDownDistanceText || situation.downDistanceText || null : null,
      // Forecast for outdoor games that haven't started; domes have none.
      weather: state === 'pre' && event.weather ? { temp: event.weather.temperature ?? null, text: event.weather.displayValue || '' } : null,
      home: tile(home),
      away: tile(away),
    };
  });
}

// NFL boards come back a week at a time; the league calendar names the week
// and its dates, and bounds the arrows on the Games tab.
export function weekInfo(board) {
  const type = String(board?.season?.type ?? 2);
  const number = toNum(board?.week?.number);
  const section = (board?.leagues?.[0]?.calendar || []).find((c) => String(c.value) === type);
  const entries = section?.entries || [];
  const entry = entries.find((e) => String(e.value) === String(number));
  return {
    number,
    seasonType: Number(type),
    label: entry?.label || (number ? `Week ${number}` : ''),
    detail: entry?.detail || '',
    first: entries.length ? toNum(entries[0].value) : 1,
    last: entries.length ? toNum(entries[entries.length - 1].value) : 18,
  };
}

// --- injuries -----------------------------------------------------------

function injuryEntries(summary) {
  const out = [];
  for (const block of summary?.injuries || []) {
    const teamAbbr = block.team?.abbreviation || '';
    for (const item of block.injuries || []) {
      const id = item.athlete?.id;
      if (!id) continue;
      out.push({
        teamAbbr,
        id: String(id),
        name: item.athlete.displayName || item.athlete.shortName || '',
        status: item.status || item.type?.description || '',
        detail: item.details?.detail || item.details?.type || '',
      });
    }
  }
  return out;
}

// --- box score ----------------------------------------------------------

// The "45% 13% 63%" line under an NBA team total: made over attempted for the
// three shooting columns, worked out from ESPN's own "19-42" totals.
function shootingPercents(labels, totals) {
  return labels.map((label, i) => {
    if (!['FG', '3PT', 'FT'].includes(label)) return '';
    const [made, att] = String(totals[i] || '').split('-').map(Number);
    return att > 0 ? `${Math.round((made / att) * 100)}%` : '';
  });
}

// One ESPN stat table, kept as ESPN's own labels and display strings so NBA
// and NFL draw through the same renderer.
function boxGroup(sport, group, onCourt) {
  const rows = (group.athletes || []).map((entry) => {
    const a = entry.athlete || {};
    const id = String(a.id ?? '');
    const stats = (entry.stats || []).map((v) => String(v ?? ''));
    return {
      id,
      name: a.displayName || a.shortName || '',
      short: a.shortName || a.displayName || '',
      jersey: a.jersey || '',
      pos: a.position?.abbreviation || '',
      starter: !!entry.starter,
      dnp: !!entry.didNotPlay || !stats.length,
      reason: entry.reason || '',
      ejected: !!entry.ejected,
      onCourt: onCourt ? onCourt.has(id) : false,
      stats,
    };
  });
  // NFL sends every category even when nobody recorded one (no fumbles, no
  // interceptions), so drop the empty tables rather than draw blank ones.
  if (!rows.length) return null;
  const labels = group.labels || [];
  const totals = (group.totals || []).map((v) => String(v ?? ''));
  return {
    name: group.name || 'players',
    title: group.text || '',
    labels,
    totals,
    percents: sport === 'nba' ? shootingPercents(labels, totals) : null,
    rows,
  };
}

// Game time in minutes, counting NBA overtime as five-minute periods.
function nbaGameMinute(period, clock) {
  const left = minutesRemaining(clock);
  if (period <= 4) return (period - 1) * 12 + (12 - left);
  return 48 + (period - 5) * 5 + (5 - left);
}

const RUN_WINDOW_MIN = 6;
const RUN_MIN_POINTS = 8;
const RUN_MIN_MARGIN = 6;

/**
 * REAL's "13-2 run" line. Looks back from the latest basket, within the last
 * six minutes of game time, for the stretch in which one team outscored the
 * other by the most -- counting only stretches where the other side managed a
 * third as many points or fewer. Without that, a long back-and-forth 19-9
 * stretch outranks a genuine 13-2 burst, and nobody calls 19-9 a run. Each
 * scoring play carries the running score, so every window is a subtraction.
 */
export function scoringRun(summary, home, away) {
  const scoring = (summary?.plays || []).filter((p) => p.scoringPlay);
  if (!scoring.length) return null;
  const status = summary?.header?.competitions?.[0]?.status || {};
  const now = nbaGameMinute(toNum(status.period) || 1, status.displayClock);
  const last = scoring[scoring.length - 1];
  const endAway = toNum(last.awayScore);
  const endHome = toNum(last.homeScore);

  let best = null;
  for (let i = scoring.length - 1; i >= 0; i--) {
    const started = nbaGameMinute(toNum(scoring[i].period?.number) || 1, scoring[i].clock?.displayValue);
    if (now - started > RUN_WINDOW_MIN) break;
    const before = scoring[i - 1];
    const awayPts = endAway - toNum(before?.awayScore);
    const homePts = endHome - toNum(before?.homeScore);
    const scored = Math.max(awayPts, homePts);
    const allowed = Math.min(awayPts, homePts);
    if (scored < RUN_MIN_POINTS || scored - allowed < RUN_MIN_MARGIN || allowed * 3 > scored) continue;
    if (!best || scored - allowed > best.scored - best.allowed) best = { awayPts, homePts, scored, allowed, started };
  }
  if (!best) return null;

  const { scored, allowed } = best;
  const seconds = Math.max(0, Math.round((now - best.started) * 60));
  return {
    teamAbbr: best.awayPts > best.homePts ? away.abbr : home.abbr,
    for: scored,
    against: allowed,
    span: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  };
}

export function normalizeBox(sport, summary, feedLimit = 80) {
  const comp = summary?.header?.competitions?.[0] || {};
  const status = comp.status || {};
  const type = status.type || {};
  const state = type.state || 'pre';
  const competitors = comp.competitors || [];
  const home = sideOf(competitors.find((c) => c.homeAway === 'home') || competitors[0] || {});
  const away = sideOf(competitors.find((c) => c.homeAway === 'away') || competitors[1] || {});

  // Who is on the floor comes from the same substitution replay as /api/live.
  let onCourt = null;
  if (sport === 'nba' && state === 'in') {
    const roster = {};
    for (const block of summary?.boxscore?.players || []) {
      for (const group of block.statistics || []) {
        for (const entry of group.athletes || []) {
          const id = String(entry.athlete?.id ?? '');
          if (id) roster[id] = { id, starter: !!entry.starter || !!roster[id]?.starter };
        }
      }
    }
    onCourt = onCourtIds(summary, roster);
  }

  const teams = [away, home].map((side) => {
    const block = (summary?.boxscore?.players || []).find((b) => String(b.team?.id) === side.id);
    const stats = (summary?.boxscore?.teams || []).find((t) => String(t.team?.id) === side.id);
    return {
      id: side.id,
      abbr: side.abbr,
      groups: (block?.statistics || []).map((g) => boxGroup(sport, g, onCourt)).filter(Boolean),
      // Before tip-off ESPN fills these with season averages, which would read
      // as tonight's numbers, so team stats only appear once the game starts.
      teamStats: state === 'pre' ? [] : (stats?.statistics || []).map((st) => ({
        label: st.label || st.name || '',
        value: String(st.displayValue ?? ''),
      })),
    };
  });

  const pick = summary?.pickcenter?.[0];
  const header = (side) => ({
    id: side.id, abbr: side.abbr, name: side.name, short: side.short, logo: side.logo, color: side.color,
    score: side.score, record: side.record, winner: side.winner, linescores: side.linescores,
  });
  return {
    id: String(summary?.header?.id ?? comp.id ?? ''),
    sport,
    state,
    completed: !!type.completed,
    statusDetail: type.shortDetail || type.detail || '',
    period: toNum(status.period),
    clock: status.displayClock || '',
    start: comp.date || null,
    broadcast: pickBroadcast(comp.broadcasts),
    venue: summary?.gameInfo?.venue?.fullName || '',
    away: header(away),
    home: header(home),
    teams,
    injuries: injuryEntries(summary),
    odds: state === 'pre' && pick ? { spread: pick.details || null, total: pick.overUnder ?? null } : null,
    run: sport === 'nba' && state === 'in' ? scoringRun(summary, home, away) : null,
    // The play-by-play rides along: every layout of the game view shows some of it.
    feed: buildFeed(sport, summary, feedLimit),
  };
}

// NFL rosters come in position groups; the practice squad and suspended list
// aren't playing, so they're left out.
const ROSTER_GROUPS = { offense: 'Offense', defense: 'Defense', specialTeam: 'Special teams', injuredReserveOrOut: 'Injured reserve' };

function normalizeRoster(data) {
  const out = [];
  for (const entry of data?.athletes || []) {
    const group = Array.isArray(entry?.items) ? entry.position : null;
    if (group && !ROSTER_GROUPS[group]) continue;
    for (const a of group ? entry.items : [entry]) {
      if (!a?.id) continue;
      out.push({
        id: String(a.id), name: a.displayName || '', short: a.shortName || a.displayName || '',
        jersey: a.jersey || '', pos: a.position?.abbreviation || '', ht: a.displayHeight || '', wt: a.displayWeight || '',
        age: a.age ?? '', exp: a.experience?.years ?? '', college: a.college?.name || a.college?.shortName || '',
        group: group ? ROSTER_GROUPS[group] : null,
      });
    }
  }
  return out;
}

export async function loadBox(sport, eventId, feedLimit = 80) {
  const box = normalizeBox(sport, await fetchJson(summaryUrl(sport, eventId)), feedLimit);
  // Before tip-off there's no box score to show, so the rosters stand in.
  if (box.state === 'pre') {
    const rosters = await Promise.allSettled([box.away, box.home].map((s) => fetchJson(rosterUrl(sport, s.id))));
    box.rosters = rosters.map((r) => (r.status === 'fulfilled' ? normalizeRoster(r.value) : []));
  }
  return box;
}
