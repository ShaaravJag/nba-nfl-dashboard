// HTML builders for the Games tab and the box score. Pure functions of the data
// they are handed -- app.js owns fetching, polling and state, the same split
// markets.js has for settlement.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Which box-score cells a bet rides on, so the view can outline them. NBA
// columns are ESPN's labels; NFL columns are "group:LABEL" because the same
// label (YDS, TD) appears in several tables.
export const MARKET_COLUMNS = {
  'nba.pts': ['PTS'], 'nba.reb': ['REB'], 'nba.ast': ['AST'], 'nba.fg3m': ['3PT'], 'nba.stl': ['STL'],
  'nba.blk': ['BLK'], 'nba.to': ['TO'], 'nba.min': ['MIN'], 'nba.fgm': ['FG'], 'nba.fga': ['FG'],
  'nba.ftm': ['FT'], 'nba.fg3a': ['3PT'], 'nba.oreb': ['OREB'], 'nba.dreb': ['DREB'], 'nba.pf': ['PF'],
  'nba.pm': ['+/-'], 'nba.pra': ['PTS', 'REB', 'AST'], 'nba.pr': ['PTS', 'REB'], 'nba.pa': ['PTS', 'AST'],
  'nba.ra': ['REB', 'AST'], 'nba.sb': ['STL', 'BLK'], 'nba.dd': ['PTS', 'REB', 'AST'], 'nba.td3': ['PTS', 'REB', 'AST'],
  'nfl.passYds': ['passing:YDS'], 'nfl.passTd': ['passing:TD'], 'nfl.cmp': ['passing:C/ATT'],
  'nfl.passAtt': ['passing:C/ATT'], 'nfl.passInt': ['passing:INT'], 'nfl.rushYds': ['rushing:YDS'],
  'nfl.rushAtt': ['rushing:CAR'], 'nfl.rushTd': ['rushing:TD'], 'nfl.rushLong': ['rushing:LONG'],
  'nfl.rec': ['receiving:REC'], 'nfl.recYds': ['receiving:YDS'], 'nfl.recTd': ['receiving:TD'],
  'nfl.tgt': ['receiving:TGTS'], 'nfl.recLong': ['receiving:LONG'],
  'nfl.rushRecYds': ['rushing:YDS', 'receiving:YDS'], 'nfl.passRushYds': ['passing:YDS', 'rushing:YDS'],
  'nfl.anytimeTd': ['rushing:TD', 'receiving:TD'], 'nfl.tackles': ['defensive:TOT'],
  'nfl.sacks': ['defensive:SACKS'], 'nfl.intCaught': ['interceptions:INT'], 'nfl.kickPts': ['kicking:PTS'],
  'nfl.fgm': ['kicking:FG'], 'nfl.xpm': ['kicking:XP'], 'nfl.longFg': ['kicking:LONG'],
};

const NFL_TITLES = {
  passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving', fumbles: 'Fumbles',
  defensive: 'Defense', interceptions: 'Interceptions', kickReturns: 'Kick Returns',
  puntReturns: 'Punt Returns', kicking: 'Kicking', punting: 'Punting',
};

// --- shared bits ------------------------------------------------------------

function startTime(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

// ESPN writes "5:49 - 2nd"; REAL writes "5:49 2nd". Halftime, end-of-quarter
// and overtime labels pass straight through.
function statusText(g) {
  if (g.state === 'pre') return startTime(g.start) || g.statusDetail || '';
  if (g.state === 'post') return g.statusDetail || 'Final';
  return String(g.statusDetail || '').replace(' - ', ' ');
}

// "COACH'S DECISION" -> "Coach's Decision" (a plain \b capitalises the S).
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap, c) => gap + c.toUpperCase());

const oddsText = (odds) => [odds?.spread, odds?.total != null ? `O/U ${odds.total}` : null].filter(Boolean);

// --- Games tab --------------------------------------------------------------

const ORDER = { in: 0, pre: 1, post: 2 };
const sortGames = (games) => [...games].sort((a, b) =>
  (ORDER[a.state] ?? 1) - (ORDER[b.state] ?? 1) || String(a.start).localeCompare(String(b.start)));

// The clock sits alone in the top-right corner, beside the first score, so
// both team names get the tile's full width (a status column down the side
// cut "Timberwolves" to "Timber…" on a phone). Network, odds and your legs go
// in a footer.
function tileHtml(g, legs) {
  const pre = g.state === 'pre';
  const final = g.state === 'post';
  const side = (s) => {
    const ball = g.possession && g.possession === s.id ? '<span class="ball" title="Has the ball"></span>' : '';
    const num = pre ? `<span class="gt-rec">${esc(s.record)}</span>` : `<span class="gt-score">${s.score}</span>`;
    const logo = s.logo ? `<img src="${esc(s.logo)}" alt="" loading="lazy">` : '<span class="gt-logo"></span>';
    return `<div class="gt-side${final && !s.winner ? ' lose' : ''}">${logo}
      <div class="gt-num">${num}${ball}<div class="gt-name">${esc(s.short || s.abbr)}</div></div></div>`;
  };
  const foot = [];
  if (g.broadcast) foot.push(`<span class="gt-net">${esc(g.broadcast)}</span>`);
  if (g.downDistance) foot.push(`<span class="gt-net">${esc(g.downDistance)}</span>`);
  if (pre && oddsText(g.odds).length) foot.push(`<span class="gt-odds">${oddsText(g.odds).map(esc).join(' &middot; ')}</span>`);
  if (legs) foot.push(`<span class="gt-bets">${legs} leg${legs === 1 ? '' : 's'}</span>`);
  const clock = g.state === 'in' ? `<span class="live-dot"></span>${esc(statusText(g))}` : esc(statusText(g));
  return `<button class="gtile ${esc(g.state)}${legs ? ' tracked' : ''}${g.redZone ? ' redzone' : ''}" data-open-game="${esc(g.sport)}:${esc(g.id)}">
    <div class="gt-clock">${clock}</div>
    ${side(g.away)}${side(g.home)}
    ${foot.length ? `<div class="gt-foot">${foot.join('')}</div>` : ''}
  </button>`;
}

const gridHtml = (games, legCounts) =>
  `<div class="games-grid">${sortGames(games).map((g) => tileHtml(g, legCounts.get(g.id))).join('')}</div>`;

// Seven days around the server's sports day (Eastern, rolling over at 6am), not
// the phone's clock, so the strip and the slate always agree.
function dayStripHtml(today, selected) {
  if (!/^\d{8}$/.test(today || '')) return '';
  const base = Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8), 12);
  const days = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(base + i * 86400000);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const dow = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    days.push(`<button class="day${key === selected ? ' on' : ''}${i === 0 ? ' today' : ''}" data-day="${key}"><span>${md}</span><b>${dow}</b></button>`);
  }
  return `<div class="day-strip">${days.join('')}</div>`;
}

function weekNavHtml(number, meta) {
  if (!number) return '';
  const known = meta && meta.number === number;
  const first = meta?.first ?? 1;
  const last = meta?.last ?? 18;
  const arrow = (to, glyph, label) => (to >= first && to <= last
    ? `<button class="icon-btn" data-week="${to}" aria-label="${label}">${glyph}</button>`
    : '<span class="icon-btn" style="visibility:hidden"></span>');
  return `<div class="week-nav">${arrow(number - 1, '&#8249;', 'Previous week')}
    <div class="wk"><b>${esc(known ? meta.label : `Week ${number}`)}</b><span>${esc(known ? meta.detail : '')}</span></div>
    ${arrow(number + 1, '&#8250;', 'Next week')}</div>`;
}

// NFL weeks read best split by day: Thursday night, Sunday, Monday night.
function byDay(games) {
  const days = new Map();
  for (const g of [...games].sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
    const label = new Date(g.start).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (!days.has(label)) days.set(label, []);
    days.get(label).push(g);
  }
  return [...days];
}

export function scoreboardHtml(scores, { legCounts }) {
  const { sport, data } = scores;
  const sportSeg = `<div class="seg">${['nba', 'nfl'].map((s) =>
    `<button class="${s === sport ? 'on' : ''}" data-sport="${s}">${s.toUpperCase()}</button>`).join('')}</div>`;
  const nav = sport === 'nfl' ? weekNavHtml(scores.week, scores.weekMeta) : dayStripHtml(scores.today, scores.date);

  let body;
  if (!data) {
    body = scores.error
      ? `<div class="empty"><div>Couldn't load scores.</div><div class="note">${esc(scores.error)}</div></div>`
      : '<div class="empty"><div class="note">Loading games…</div></div>';
  } else if (!data.games.length) {
    body = `<div class="empty"><div>No ${sport.toUpperCase()} games ${sport === 'nfl' ? 'this week' : 'on this day'}.</div></div>`;
  } else if (sport === 'nfl') {
    body = byDay(data.games).map(([day, games]) => `<div class="day-head">${esc(day)}</div>${gridHtml(games, legCounts)}`).join('');
  } else {
    body = gridHtml(data.games, legCounts);
  }
  return `<div class="games-top">${sportSeg}${nav}</div>${body}`;
}

// --- box score --------------------------------------------------------------

function boxHeaderHtml(b) {
  const final = b.state === 'post';
  const team = (s) => `<div class="bh-team${final && !s.winner ? ' lose' : ''}">
      ${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ''}
      <div class="bh-abbr">${esc(s.abbr)}</div><div class="bh-rec">${esc(s.record)}</div></div>`;
  const score = (s) => `<div class="bh-score${final && !s.winner ? ' lose' : ''}">${b.state === 'pre' ? '' : s.score}</div>`;
  const live = b.state === 'in';
  return `<div class="box-head">
    ${team(b.away)}${score(b.away)}
    <div class="bh-mid"><div class="bh-status${live ? ' live' : ''}">${live ? '<span class="live-dot"></span>' : ''}${esc(statusText(b))}</div>
      ${b.broadcast ? `<div class="bh-net">${esc(b.broadcast)}</div>` : ''}</div>
    ${score(b.home)}${team(b.home)}
  </div>`;
}

function linescoreHtml(b) {
  const played = Math.max(b.away.linescores.length, b.home.linescores.length);
  if (!played) return '';
  const n = Math.max(4, played);   // regulation always shows, future quarters blank
  const label = (i) => (i < 4 ? String(i + 1) : i === 4 ? 'OT' : `${i - 3}OT`);
  const cells = (s) => Array.from({ length: n }, (_, i) => `<td>${s.linescores[i] ?? ''}</td>`).join('');
  return `<table class="linescore"><thead><tr><th></th>${Array.from({ length: n }, (_, i) => `<th>${label(i)}</th>`).join('')}<th>T</th></tr></thead>
    <tbody>${[b.away, b.home].map((s) => `<tr><td class="ls-team">${esc(s.abbr)}</td>${cells(s)}<td class="ls-t">${s.score}</td></tr>`).join('')}</tbody></table>`;
}

function playerRowHtml(r, labels, colKey, tracked, state) {
  const marks = tracked.get(r.id);
  const name = `<td class="name">${r.onCourt ? '<span class="oncourt"></span>' : ''}<span class="pn">${esc(r.short)}</span>`
    + `${r.jersey ? `<span class="jn">#${esc(r.jersey)}</span>` : ''}${r.ejected ? '<span class="ej">EJ</span>' : ''}</td>`;
  if (r.dnp) {
    // ESPN flags unused players DNP mid-game too; its site only calls it a DNP
    // once the game is over.
    const note = state === 'post' ? `DNP — ${titleCase(r.reason || "Coach's decision")}` : 'Has not entered game';
    return `<tr class="dnp${marks ? ' tracked' : ''}">${name}<td class="dnp-note" colspan="${labels.length}">${esc(note)}</td></tr>`;
  }
  const cells = labels.map((l, i) => `<td${marks?.has(colKey(l)) ? ' class="hl"' : ''}>${esc(r.stats[i] ?? '')}</td>`).join('');
  return `<tr${marks ? ' class="tracked"' : ''}>${name}${cells}</tr>`;
}

function headRow(title, labels) {
  return `<tr class="sec"><th class="name">${esc(title)}</th>${labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr>`;
}

function totalsRows(group) {
  if (!group.totals.some(Boolean)) return '';
  const tot = `<tr class="tot"><td class="name">TEAM</td>${group.labels.map((_, i) => `<td>${esc(group.totals[i] ?? '')}</td>`).join('')}</tr>`;
  const pct = group.percents?.some(Boolean)
    ? `<tr class="pct"><td class="name"></td>${group.percents.map((p) => `<td>${esc(p)}</td>`).join('')}</tr>` : '';
  return tot + pct;
}

function teamTablesHtml(b, team, tracked) {
  if (!team?.groups.length) return '<div class="empty"><div class="note">No stats yet.</div></div>';
  if (b.sport === 'nba') {
    const g = team.groups[0];
    const row = (r) => playerRowHtml(r, g.labels, (l) => l, tracked, b.state);
    return `<div class="box-scroll" data-scroll-key="${esc(team.abbr)}:players"><table class="box">
      ${headRow('Starters', g.labels)}${g.rows.filter((r) => r.starter).map(row).join('')}
      ${headRow('Bench', g.labels)}${g.rows.filter((r) => !r.starter).map(row).join('')}
      ${totalsRows(g)}</table></div>`;
  }
  return team.groups.map((g) => {
    const row = (r) => playerRowHtml(r, g.labels, (l) => `${g.name}:${l}`, tracked, b.state);
    return `<div class="box-scroll" data-scroll-key="${esc(team.abbr)}:${esc(g.name)}"><table class="box">
      ${headRow(NFL_TITLES[g.name] || g.title, g.labels)}${g.rows.map(row).join('')}${totalsRows(g)}</table></div>`;
  }).join('');
}

function teamStatsHtml(b) {
  const [away, home] = b.teams;
  if (!away?.teamStats.length) return '<div class="empty"><div class="note">Team stats appear once the game starts.</div></div>';
  // Paired by position, not label: NFL lists "Interceptions thrown" twice.
  return `<div class="panel tstats">
    <div class="ts-row ts-head"><span>${esc(b.away.abbr)}</span><span></span><span>${esc(b.home.abbr)}</span></div>
    ${away.teamStats.map((s, i) => `<div class="ts-row"><span>${esc(s.value)}</span><span class="ts-label">${esc(s.label)}</span><span>${esc(home?.teamStats[i]?.value ?? '')}</span></div>`).join('')}
  </div>`;
}

function pregameHtml(b) {
  const odds = oddsText(b.odds);
  const teams = [b.away.abbr, b.home.abbr].map((abbr) => {
    const list = b.injuries.filter((i) => i.teamAbbr === abbr);
    if (!list.length) return '';
    return `<div class="inj-team">${esc(abbr)}</div>${list.map((i) => `<div class="inj-row">
      <span class="inj-name">${esc(i.name)}</span>
      <span class="inj-st${/^out$/i.test(i.status) ? ' out' : ''}">${esc(i.status)}</span>
      <span class="inj-why">${esc(i.detail)}</span></div>`).join('')}`;
  }).join('');
  return `${odds.length ? `<div class="pg-odds">${odds.map(esc).join(' &middot; ')}</div>` : ''}
    ${b.venue ? `<div class="pg-venue">${esc(b.venue)}</div>` : ''}
    ${teams ? `<div class="panel"><h3>Injury report</h3>${teams}</div>` : ''}
    <div class="empty"><div class="note">The box score starts at ${b.sport === 'nfl' ? 'kickoff' : 'tip-off'}.</div></div>`;
}

export function boxScoreHtml(b, { side, tracked, error, from }) {
  const back = `<button class="back-btn" data-back>&#8249; ${from === 'live' ? 'Bets' : 'Games'}</button>`;
  if (!b) {
    return `${back}<div class="empty"><div class="note">${esc(error || 'Loading box score…')}</div></div>`;
  }
  const parts = [back, boxHeaderHtml(b)];
  if (b.state !== 'pre') parts.push(linescoreHtml(b));
  if (b.run) {
    parts.push(`<div class="run-line"><b>${esc(b.run.teamAbbr)}</b> on a ${b.run.for}-${b.run.against} run <span>&middot; last ${esc(b.run.span)}</span></div>`);
  }
  if (b.state === 'pre') {
    parts.push(pregameHtml(b));
  } else {
    parts.push(`<div class="seg box-seg">
      <button class="${side === 'away' ? 'on' : ''}" data-box-side="away">${esc(b.away.abbr)}</button>
      <button class="${side === 'home' ? 'on' : ''}" data-box-side="home">${esc(b.home.abbr)}</button>
      <button class="${side === 'team' ? 'on' : ''}" data-box-side="team">Team stats</button></div>`);
    parts.push(side === 'team' ? teamStatsHtml(b) : teamTablesHtml(b, b.teams[side === 'home' ? 1 : 0], tracked));
  }
  return parts.join('');
}
