// Market catalog + settlement. Pure functions, no DOM, so scripts/test-markets.mjs
// can exercise them directly.

const sum = (...vals) => vals.reduce((a, b) => a + (b || 0), 0);
const dblCount = (s) => [s.pts, s.reb, s.ast, s.stl, s.blk].filter((v) => (v || 0) >= 10).length;

// kind: player | game. monotonic markets can only ever increase, which lets an
// over lock in as soon as it clears (and an under bust the moment it is passed).
// Margin-based markets move both ways, so they only settle at final.
function player(sport, key, label, short, group, stat, extra = {}) {
  return { key: `${sport}.${key}`, sport, kind: 'player', label, short, group, stat, monotonic: true, ...extra };
}
function game(sport, key, label, short, group, value, extra = {}) {
  return { key: `${sport}.${key}`, sport, kind: 'game', label, short, group, value, monotonic: true, ...extra };
}

const periodTotal = (g, periods, side) => {
  const take = (arr) => periods.reduce((acc, p) => acc + (arr[p - 1] ?? 0), 0);
  const complete = g.period > Math.max(...periods) || g.state === 'post';
  if (side === 'home') return { v: take(g.home.linescores || []), complete };
  if (side === 'away') return { v: take(g.away.linescores || []), complete };
  return { v: take(g.home.linescores || []) + take(g.away.linescores || []), complete };
};

const teamOf = (g, abbr) => (g.home.abbr === abbr ? g.home : g.away);
const oppOf = (g, abbr) => (g.home.abbr === abbr ? g.away : g.home);

const LIST = [
  // ---- NBA player ----
  player('nba', 'pts', 'Points', 'PTS', 'Scoring', (s) => s.pts),
  player('nba', 'reb', 'Rebounds', 'REB', 'Scoring', (s) => s.reb),
  player('nba', 'ast', 'Assists', 'AST', 'Scoring', (s) => s.ast),
  player('nba', 'fg3m', 'Made Threes', '3PM', 'Scoring', (s) => s.fg3m),
  player('nba', 'stl', 'Steals', 'STL', 'Defense', (s) => s.stl),
  player('nba', 'blk', 'Blocks', 'BLK', 'Defense', (s) => s.blk),
  player('nba', 'to', 'Turnovers', 'TO', 'Defense', (s) => s.to),
  player('nba', 'min', 'Minutes', 'MIN', 'Other', (s) => s.min),
  player('nba', 'fgm', 'Field Goals Made', 'FGM', 'Other', (s) => s.fgm),
  player('nba', 'fga', 'Field Goals Att', 'FGA', 'Other', (s) => s.fga),
  player('nba', 'ftm', 'Free Throws Made', 'FTM', 'Other', (s) => s.ftm),
  player('nba', 'fg3a', 'Three Pt Att', '3PA', 'Other', (s) => s.fg3a),
  player('nba', 'oreb', 'Offensive Rebounds', 'OREB', 'Other', (s) => s.oreb),
  player('nba', 'dreb', 'Defensive Rebounds', 'DREB', 'Other', (s) => s.dreb),
  player('nba', 'pf', 'Personal Fouls', 'PF', 'Other', (s) => s.pf),
  player('nba', 'pm', 'Plus / Minus', '+/-', 'Other', (s) => s.pm, { monotonic: false }),
  player('nba', 'pra', 'Pts + Reb + Ast', 'PRA', 'Combos', (s) => sum(s.pts, s.reb, s.ast)),
  player('nba', 'pr', 'Pts + Reb', 'P+R', 'Combos', (s) => sum(s.pts, s.reb)),
  player('nba', 'pa', 'Pts + Ast', 'P+A', 'Combos', (s) => sum(s.pts, s.ast)),
  player('nba', 'ra', 'Reb + Ast', 'R+A', 'Combos', (s) => sum(s.reb, s.ast)),
  player('nba', 'sb', 'Stl + Blk', 'S+B', 'Combos', (s) => sum(s.stl, s.blk)),
  player('nba', 'dd', 'Double-Double', 'DD', 'Combos', dblCount, { defaultLine: 1.5, boolean: 'Double-Double' }),
  player('nba', 'td3', 'Triple-Double', 'TD', 'Combos', dblCount, { defaultLine: 2.5, boolean: 'Triple-Double' }),

  // ---- NBA game ----
  game('nba', 'game_total', 'Game Total Points', 'TOTAL', 'Game', (g) => g.home.score + g.away.score),
  game('nba', 'team_total', 'Team Total Points', 'TEAM', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score),
  game('nba', 'spread', 'Spread', 'SPREAD', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score - oppOf(g, leg.teamAbbr).score, { monotonic: false, margin: true }),
  game('nba', 'moneyline', 'Moneyline', 'ML', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score - oppOf(g, leg.teamAbbr).score, { monotonic: false, margin: true, defaultLine: 0 }),
  game('nba', 'h1_total', '1st Half Total', '1H', 'Game', (g) => periodTotal(g, [1, 2]).v, { partial: [1, 2] }),
  game('nba', 'q1_total', '1st Quarter Total', '1Q', 'Game', (g) => periodTotal(g, [1]).v, { partial: [1] }),

  // ---- NFL player ----
  player('nfl', 'passYds', 'Passing Yards', 'PASS YDS', 'Passing', (s) => s.passYds),
  player('nfl', 'passTd', 'Passing TDs', 'PASS TD', 'Passing', (s) => s.passTd),
  player('nfl', 'cmp', 'Completions', 'CMP', 'Passing', (s) => s.cmp),
  player('nfl', 'passAtt', 'Pass Attempts', 'ATT', 'Passing', (s) => s.passAtt),
  player('nfl', 'passInt', 'Interceptions Thrown', 'INT', 'Passing', (s) => s.passInt),
  player('nfl', 'rushYds', 'Rushing Yards', 'RUSH YDS', 'Rushing', (s) => s.rushYds),
  player('nfl', 'rushAtt', 'Rush Attempts', 'CAR', 'Rushing', (s) => s.rushAtt),
  player('nfl', 'rushTd', 'Rushing TDs', 'RUSH TD', 'Rushing', (s) => s.rushTd),
  player('nfl', 'rushLong', 'Longest Rush', 'LNG RU', 'Rushing', (s) => s.rushLong),
  player('nfl', 'rec', 'Receptions', 'REC', 'Receiving', (s) => s.rec),
  player('nfl', 'recYds', 'Receiving Yards', 'REC YDS', 'Receiving', (s) => s.recYds),
  player('nfl', 'recTd', 'Receiving TDs', 'REC TD', 'Receiving', (s) => s.recTd),
  player('nfl', 'tgt', 'Targets', 'TGT', 'Receiving', (s) => s.tgt),
  player('nfl', 'recLong', 'Longest Reception', 'LNG REC', 'Receiving', (s) => s.recLong),
  player('nfl', 'rushRecYds', 'Rush + Rec Yards', 'RU+RE', 'Combos', (s) => sum(s.rushYds, s.recYds)),
  player('nfl', 'passRushYds', 'Pass + Rush Yards', 'PA+RU', 'Combos', (s) => sum(s.passYds, s.rushYds)),
  player('nfl', 'anytimeTd', 'Anytime Touchdown', 'ATD', 'Combos', (s) => sum(s.rushTd, s.recTd, s.krTd, s.prTd, s.intTd, s.defTd), { defaultLine: 0.5, boolean: 'Scores a TD' }),
  player('nfl', 'tackles', 'Total Tackles', 'TKL', 'Defense', (s) => s.tackles),
  player('nfl', 'sacks', 'Sacks', 'SACK', 'Defense', (s) => s.sacks),
  player('nfl', 'intCaught', 'Interceptions Caught', 'INT', 'Defense', (s) => s.intCaught),
  player('nfl', 'kickPts', 'Kicking Points', 'KICK', 'Kicking', (s) => s.kickPts),
  player('nfl', 'fgm', 'Field Goals Made', 'FGM', 'Kicking', (s) => s.fgm),
  player('nfl', 'xpm', 'Extra Points Made', 'XPM', 'Kicking', (s) => s.xpm),
  player('nfl', 'longFg', 'Longest Field Goal', 'LNG FG', 'Kicking', (s) => s.longFg),

  // ---- NFL game ----
  game('nfl', 'game_total', 'Game Total Points', 'TOTAL', 'Game', (g) => g.home.score + g.away.score),
  game('nfl', 'team_total', 'Team Total Points', 'TEAM', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score),
  game('nfl', 'spread', 'Spread', 'SPREAD', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score - oppOf(g, leg.teamAbbr).score, { monotonic: false, margin: true }),
  game('nfl', 'moneyline', 'Moneyline', 'ML', 'Game', (g, leg) => teamOf(g, leg.teamAbbr).score - oppOf(g, leg.teamAbbr).score, { monotonic: false, margin: true, defaultLine: 0 }),
  game('nfl', 'h1_total', '1st Half Total', '1H', 'Game', (g) => periodTotal(g, [1, 2]).v, { partial: [1, 2] }),
];

export const MARKETS = Object.fromEntries(LIST.map((m) => [m.key, m]));

// Anything the importer can't map lands here and gets a manual hit/bust toggle
// instead of being silently dropped.
export const UNSUPPORTED = 'unsupported';

export function marketsFor(sport) {
  return LIST.filter((m) => m.sport === sport);
}

export function marketGroups(sport, kind) {
  const groups = new Map();
  for (const m of marketsFor(sport)) {
    if (kind && m.kind !== kind) continue;
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  return groups;
}

// Loose resolution so pasted JSON survives small naming differences.
const ALIAS = {
  points: 'pts', pts: 'pts', rebounds: 'reb', rebs: 'reb', boards: 'reb',
  assists: 'ast', threes: 'fg3m', threepointersmade: 'fg3m', '3pm': 'fg3m',
  madethrees: 'fg3m', steals: 'stl', blocks: 'blk', turnovers: 'to',
  minutes: 'min', pointsreboundsassists: 'pra', pointsrebounds: 'pr',
  pointsassists: 'pa', reboundsassists: 'ra', stealsblocks: 'sb',
  doubledouble: 'dd', tripledouble: 'td3',
  passingyards: 'passYds', passyards: 'passYds', passingtouchdowns: 'passTd',
  passingtds: 'passTd', completions: 'cmp', passattempts: 'passAtt',
  interceptionsthrown: 'passInt', rushingyards: 'rushYds', rushyards: 'rushYds',
  rushingattempts: 'rushAtt', carries: 'rushAtt', rushingtouchdowns: 'rushTd',
  receptions: 'rec', catches: 'rec', receivingyards: 'recYds', recyards: 'recYds',
  receivingtouchdowns: 'recTd', targets: 'tgt', longestreception: 'recLong',
  longestrush: 'rushLong', rushrecyards: 'rushRecYds', rushingreceivingyards: 'rushRecYds',
  anytimetouchdown: 'anytimeTd', anytimetd: 'anytimeTd', tackles: 'tackles',
  totaltackles: 'tackles', sacks: 'sacks', kickingpoints: 'kickPts',
  total: 'game_total', gametotal: 'game_total', totalpoints: 'game_total',
  teamtotal: 'team_total', spread: 'spread', moneyline: 'moneyline', ml: 'moneyline',
  firsthalftotal: 'h1_total', firstquartertotal: 'q1_total',
};

export function resolveMarket(sport, raw) {
  if (!raw) return null;
  const direct = MARKETS[raw] || MARKETS[`${sport}.${raw}`];
  if (direct) return direct;
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliased = ALIAS[slug];
  if (aliased && MARKETS[`${sport}.${aliased}`]) return MARKETS[`${sport}.${aliased}`];
  const byLabel = LIST.find(
    (m) => m.sport === sport && (m.label.toLowerCase().replace(/[^a-z0-9]/g, '') === slug || m.short.toLowerCase().replace(/[^a-z0-9]/g, '') === slug)
  );
  return byLabel || null;
}

// --- settlement ---------------------------------------------------------

const EMPTY_STATS = {};

/**
 * Minutes left in the current period. ESPN changes format inside the final
 * minute -- "9:41" for most of a period, then tenths of a second with no colon
 * at all ("56.2", "0.4") -- so splitting on ':' unconditionally reads 56.2 as
 * fifty-six minutes remaining and sends elapsed time negative. Shared with the
 * server's scoring-run maths so the quirk is handled in one place.
 */
export function minutesRemaining(clock) {
  const raw = String(clock ?? '').trim();
  if (!raw) return 0;
  if (raw.includes(':')) {
    const [mm, ss] = raw.split(':').map((n) => Number(n) || 0);
    return mm + ss / 60;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds / 60 : 0;
}

// Share of the game already played, used for the pace projection.
export function elapsedFraction(g) {
  if (!g || g.state === 'pre') return 0;
  if (g.state === 'post') return 1;
  const regulation = 4;
  const minutes = g.sport === 'nba' ? 12 : 15;
  const remainingInPeriod = minutesRemaining(g.clock);
  const period = Math.max(1, g.period || 1);
  const played = (period - 1) * minutes + (minutes - remainingInPeriod);
  return Math.max(0, Math.min(1, played / (regulation * minutes)));
}

/**
 * Why a player prop is void, or null. Books void a prop when the player never
 * plays, and the leg drops out of the parlay. Only decided once it's certain:
 * ruled out with the game under way, or -- NBA only -- no minutes at the
 * final. An NBA box lists everyone who dressed, so a missing row means he sat;
 * an NFL box omits anyone without a stat, so there only the injury report counts.
 */
function sitsOut(leg, g, player) {
  if (g.state === 'pre' || (player && !player.dnp)) return null;
  const injury = g.injuries?.[leg.playerId] || g.injuries?.[player?.id];
  if (/^out$/i.test(injury?.status || '')) return 'ruled out';
  if (leg.sport === 'nba' && g.state === 'post' && (player || Object.keys(g.players || {}).length)) return 'did not play';
  return null;
}

/**
 * Resolve one leg against the live game.
 * status: pending | live | hit | bust | won | lost | push | void | unknown
 */
export function evaluateLeg(leg, gamesById) {
  if (leg.market === UNSUPPORTED || leg.manualStatus) {
    const manual = leg.manualStatus || null;
    return {
      value: null, status: manual || 'unknown', progress: 0, manual: true,
      text: leg.rawLabel || leg.label || 'Manual leg',
    };
  }

  const market = MARKETS[leg.market] || resolveMarket(leg.sport, leg.market);
  const g = gamesById[leg.eventId];
  if (!market) return { value: null, status: 'unknown', progress: 0, text: 'Unknown market' };
  if (!g) return { value: null, status: 'pending', progress: 0, text: 'Waiting for game data' };

  const line = Number(leg.line ?? market.defaultLine ?? 0);
  const side = leg.side === 'under' ? 'under' : 'over';

  let value;
  if (market.kind === 'player') {
    const p = g.players?.[leg.playerId] || Object.values(g.players || {}).find((x) => x.name === leg.playerName);
    const sat = sitsOut(leg, g, p);
    if (sat) return { value: null, line, side, market, status: 'void', progress: 0, voidReason: sat, text: `Void — ${sat}` };
    value = market.stat(p?.stats || EMPTY_STATS);
  } else {
    value = market.value(g, leg);
  }
  value = Number(value) || 0;

  const final = g.state === 'post';
  // A period market is decided once that period is done, not at the final whistle.
  const decidedEarly = market.partial ? (g.period || 0) > Math.max(...market.partial) : false;
  const settled = final || decidedEarly;

  let status;
  if (market.margin) {
    // Spread/moneyline: margin + line > 0 covers. Swings both ways, so only the
    // final (or completed period) settles it.
    const covered = value + line > 0;
    const push = value + line === 0;
    if (!settled) status = g.state === 'pre' ? 'pending' : 'live';
    else if (push) status = 'push';
    else status = covered ? 'won' : 'lost';
    return {
      value, line, side, market, status, progress: 0, margin: true,
      text: `${leg.teamAbbr} ${line > 0 ? '+' : ''}${line}`,
      detail: `${value > 0 ? '+' : ''}${value}`,
    };
  }

  const target = Math.floor(line) + 1; // what an over actually needs
  if (side === 'over') {
    if (value > line) status = settled ? 'won' : 'hit';
    else if (settled) status = value === line ? 'push' : 'lost';
    else status = g.state === 'pre' ? 'pending' : 'live';
  } else {
    if (value > line) status = settled ? 'lost' : 'bust';
    else if (settled) status = value === line ? 'push' : 'won';
    else status = g.state === 'pre' ? 'pending' : 'live';
  }

  const scale = side === 'over' ? target : Math.max(line, value, 1);
  const frac = elapsedFraction(g);
  return {
    value,
    line,
    side,
    market,
    status,
    progress: Math.max(0, Math.min(1, value / (scale || 1))),
    target,
    needed: side === 'over' ? Math.max(0, target - value) : null,
    projection: frac > 0.08 && !settled ? Math.round((value / frac) * 10) / 10 : null,
  };
}

const LOST_STATES = new Set(['lost', 'bust']);
const WON_STATES = new Set(['won', 'hit', 'push']);
// Legs that drop out of a parlay rather than win or lose it.
const DROPPED = new Set(['void', 'push']);

/** Roll leg results up into one status for the whole bet. */
export function betStatus(results) {
  if (!results.length) return 'pending';
  if (results.some((r) => LOST_STATES.has(r.status))) return 'lost';
  // Void and pushed legs drop out; with nothing left, the stake comes back.
  const kept = results.filter((r) => !DROPPED.has(r.status));
  if (!kept.length) return results.some((r) => r.status === 'push') ? 'push' : 'void';
  if (kept.every((r) => r.status === 'won')) return 'won';
  if (kept.some((r) => r.status === 'unknown')) return 'live';
  return kept.some((r) => r.status === 'live' || r.status === 'hit') ? 'live' : 'pending';
}

// --- alerts + sweat line -------------------------------------------------

const SEVERITY = { bad: 0, warn: 1, info: 2 };
const DECIDED = new Set(['hit', 'won', 'lost', 'bust', 'push']);

// "Jaren Jackson Jr." -> "Jackson": the name you'd shout at the TV.
function lastName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  while (parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || '';
}

/**
 * Heads-ups on a player leg beyond its number: foul trouble, a blowout that
 * could sit the starters, a player ruled out. Informational only -- settlement
 * never reads these. Returns [{ level: 'bad' | 'warn' | 'info', text, void? }],
 * worst first; `void` marks a leg the book will probably cancel. Foul trouble
 * helps an under, so it reads as neutral there.
 */
export function legAlerts(leg, game, res) {
  const out = [];
  const market = MARKETS[leg.market] || resolveMarket(leg.sport, leg.market);
  if (!game || !market || market.kind !== 'player' || res?.status === 'void') return out;

  const player = game.players?.[leg.playerId] || Object.values(game.players || {}).find((p) => p.name === leg.playerName);
  const status = String(game.injuries?.[leg.playerId]?.status || '');
  const over = leg.side !== 'under';
  const decided = DECIDED.has(res?.status);
  const period = Math.max(1, game.period || 1);

  if (/^out$/i.test(status)) out.push({ level: 'bad', text: 'OUT — leg likely void', void: true });
  else if (status && game.state === 'pre') out.push({ level: 'warn', text: status });

  // An NBA player can still check in until the final (by then a DNP is a void
  // leg, not an alert). NFL boxes only list players who recorded a stat, so
  // absence proves nothing there and NFL relies on the injury report alone.
  if (leg.sport === 'nba' && game.state === 'in' && period >= 3 && !/^out$/i.test(status)) {
    const sat = player ? player.dnp : Object.keys(game.players || {}).length > 0;
    if (sat) out.push({ level: 'warn', text: "Hasn't played" });
  }

  if (game.state === 'in' && !decided) {
    if (leg.sport === 'nba' && player) {
      const fouls = player.stats?.pf || 0;
      // Coaches sit a player at 2 fouls in the 1st, 3 in the 2nd, 4 in the 3rd, 5 late.
      if (player.ejected) out.push({ level: over ? 'bad' : 'info', text: 'Ejected' });
      else if (fouls >= 6) out.push({ level: over ? 'bad' : 'info', text: 'Fouled out' });
      else if (fouls >= Math.min(period, 4) + 1) out.push({ level: over ? 'warn' : 'info', text: `${fouls} fouls` });
    }
    const margin = Math.abs((game.home?.score || 0) - (game.away?.score || 0));
    const blowout = leg.sport === 'nba'
      ? (period === 3 && margin >= 25) || (period >= 4 && margin >= 20)
      : period >= 4 && margin >= 21;
    if (blowout && over) out.push({ level: 'warn', text: 'Blowout — starters may sit' });
  }

  return out.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}

// What one unfinished leg still needs, in the fewest words.
function legNeed(leg, res) {
  const market = MARKETS[leg.market] || resolveMarket(leg.sport, leg.market);
  if (res.manual || !market) return `${leg.rawLabel || 'manual leg'} (manual)`;
  const who = market.kind === 'player'
    ? lastName(leg.playerName)
    : market.key.endsWith('team_total') ? leg.teamAbbr : market.label.replace(' Points', '');
  if (LOST_STATES.has(res.status)) return `${who} busted`;
  if (res.status === 'pending') return `${who} yet to start`;
  if (market.margin) {
    const line = market.key.endsWith('moneyline') ? 'ML' : `${leg.line > 0 ? '+' : ''}${leg.line}`;
    return `${leg.teamAbbr} ${line} · margin ${res.detail}`;
  }
  if (market.boolean) return `${who} needs ${market.key.endsWith('anytimeTd') ? 'a TD' : `a ${market.boolean.toLowerCase()}`}`;
  const stat = market.kind === 'player' ? ` ${market.short.toLowerCase()}` : '';
  return res.side === 'under'
    ? `${who} under ${res.line}${stat} (at ${res.value})`
    : `${who} needs ${res.needed} more${stat}`;
}

/**
 * The one line on a parlay you actually read mid-game: how many legs are in
 * and what the rest still need -- "3 of 4 hit · Davis needs 8 more reb". Void
 * and pushed legs have dropped out, so they're counted separately.
 */
export function sweatLine(bet, results) {
  const legs = bet.legs || [];
  if (!legs.length) return '';
  const voids = results.filter((r) => r.status === 'void').length;
  const pushes = results.filter((r) => r.status === 'push').length;
  const kept = legs.map((leg, i) => ({ leg, res: results[i] })).filter(({ res }) => !DROPPED.has(res.status));
  if (!kept.length) {
    return `${voids === legs.length ? 'Every leg void' : pushes === legs.length ? 'Every leg pushed' : 'No legs left'} — stake back`;
  }
  if (kept.every(({ res }) => res.status === 'pending')) {
    const games = new Set(kept.map(({ leg }) => leg.eventId).filter(Boolean)).size || kept.length;
    return `Waiting on ${games} game${games === 1 ? '' : 's'}`;
  }
  const tag = [voids && `${voids} void`, pushes && `${pushes} push${pushes > 1 ? 'es' : ''}`]
    .filter(Boolean).map((t) => ` · ${t}`).join('');
  const open = kept.filter(({ res }) => !WON_STATES.has(res.status));
  if (!open.length) return `${kept.length === 1 ? 'Hit' : `All ${kept.length} legs hit`}${tag}`;
  const need = open.length === 1 ? legNeed(open[0].leg, open[0].res) : `${open.length} to go`;
  return kept.length === 1 && !tag ? need : `${kept.length - open.length} of ${kept.length} hit${tag} · ${need}`;
}

// --- odds ---------------------------------------------------------------

export function americanToDecimal(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return 1;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

export function decimalToAmerican(dec) {
  if (!Number.isFinite(dec) || dec <= 1) return 0;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

/** Multiply leg prices together in decimal space. Null if no leg is priced. */
export function combineDecimal(legOdds) {
  const valid = (legOdds || []).filter((o) => Number.isFinite(Number(o)) && Number(o) !== 0);
  if (!valid.length) return null;
  return valid.reduce((acc, o) => acc * americanToDecimal(o), 1);
}

/** Parlay odds from leg odds, used when a bet has per-leg prices but no total. */
export function combineOdds(legOdds) {
  const dec = combineDecimal(legOdds);
  return dec == null ? null : decimalToAmerican(dec);
}

const round2 = (n) => Math.round(n * 100) / 100;
const allPriced = (legs) => legs.every((l) => Number.isFinite(Number(l.americanOdds)) && Number(l.americanOdds) !== 0);

// The whole bet's price as a decimal: the slip's own "to pay", else its odds,
// else its legs multiplied together.
function betDecimal(bet) {
  const stake = Number(bet.stake) || 0;
  if (Number(bet.payout) > 0 && stake > 0) return Number(bet.payout) / stake;
  if (Number.isFinite(Number(bet.americanOdds)) && Number(bet.americanOdds) !== 0) return americanToDecimal(bet.americanOdds);
  return combineDecimal((bet.legs || []).map((l) => l.americanOdds));
}

/**
 * What a bet pays given how its legs stand -- total return, stake included,
 * the way a book shows "to pay". A void or pushed leg drops out of a parlay and
 * the rest is re-priced, as books settle it: at the remaining legs' own odds
 * when every one is known, otherwise by dividing the dropped legs back out of
 * the parlay's price. Every leg dropped means the stake comes back.
 * Returns { payout, odds, repriced }; payout is null when the legs involved
 * have no odds to work from.
 */
export function priceBet(bet, results = []) {
  const stake = Number(bet.stake) || 0;
  const legs = bet.legs || [];
  const dropped = legs.filter((_, i) => DROPPED.has(results[i]?.status));

  if (!dropped.length) {
    // The slip's own "to pay" wins: it already includes any boost.
    if (Number(bet.payout) > 0) return { payout: Number(bet.payout), odds: Number(bet.americanOdds) || null, repriced: false };
    // Stay in decimal space -- round-tripping through American odds loses cents.
    const dec = betDecimal(bet);
    return { payout: dec ? round2(stake * dec) : null, odds: dec ? decimalToAmerican(dec) : null, repriced: false };
  }
  if (dropped.length === legs.length) return { payout: stake, odds: null, repriced: true };

  const kept = legs.filter((_, i) => !DROPPED.has(results[i]?.status));
  const full = betDecimal(bet);
  let dec = null;
  if (allPriced(kept)) dec = combineDecimal(kept.map((l) => l.americanOdds));
  else if (full && allPriced(dropped)) dec = full / combineDecimal(dropped.map((l) => l.americanOdds));
  if (!(dec >= 1)) return { payout: null, odds: null, repriced: true };
  return { payout: round2(stake * dec), odds: decimalToAmerican(dec), repriced: true };
}

/** Total return (stake included). Pass leg results to account for void legs. */
export function payoutFor(bet, results) {
  return priceBet(bet, results).payout;
}

/** Profit if it wins, i.e. payout minus stake. */
export function profitFor(bet, results) {
  const payout = payoutFor(bet, results);
  return payout == null ? null : round2(payout - (Number(bet.stake) || 0));
}

export function formatOdds(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? `+${n}` : `${n}`;
}
