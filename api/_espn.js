// Shared ESPN fetching + normalization. Underscore prefix keeps Vercel from
// routing this file as an endpoint.

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
export const rosterUrl = (sport, teamId) => `${base(sport)}/teams/${teamId}/roster`;

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

function sideOf(competitor) {
  const team = competitor.team || {};
  return {
    id: String(team.id ?? ''),
    abbr: team.abbreviation || team.shortDisplayName || '',
    name: team.displayName || team.name || '',
    score: toNum(competitor.score),
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
          stats: {},
        });
        if (entry.starter) player.starter = true;
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
    const type = event.status?.type || {};
    return {
      id: String(event.id),
      sport,
      name: event.shortName || event.name || '',
      start: event.date,
      state: type.state || 'pre',
      statusDetail: type.shortDetail || '',
      home: { id: home.id, abbr: home.abbr, name: home.name, score: home.score, logo: home.logo },
      away: { id: away.id, abbr: away.abbr, name: away.name, score: away.score, logo: away.logo },
    };
  });
}
