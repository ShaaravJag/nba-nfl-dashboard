// HTML for the live play-by-play feed. Pure functions of the data they're
// handed, like scores.js -- app.js owns fetching, polling and state.
import { MARKETS, resolveMarket, lastName } from './markets.js';
import { playerUrl } from './scores.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Order of a player's stat line in a feed item's `snap`. Shared with api/_feed.js. */
export const SNAP_KEYS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'to', 'fgm', 'fga', 'ftm', 'fta', 'fg3a', 'oreb', 'dreb', 'pf'];

const periodLabel = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);
const ROW_KINDS = new Set(['period', 'sub', 'misc']);

/**
 * The play on which each of your open legs on this game cleared or busted,
 * read off the running stat lines. It needs the player's line from before the
 * play, so a leg decided before the loaded plays goes unmarked -- unless the
 * whole game is loaded, when everyone starts from zero.
 * Returns Map(itemId -> [{ ok, text }]).
 */
export function legMarkers(items, legs, wholeGame = false) {
  const marks = new Map();
  const chrono = [...(items || [])].reverse();
  for (const leg of legs) {
    const market = MARKETS[leg.market] || resolveMarket(leg.sport, leg.market);
    // Minutes and plus/minus never appear in the play-by-play.
    if (!market || market.kind !== 'player' || leg.sport !== 'nba' || !leg.playerId) continue;
    if (market.key === 'nba.min' || market.key === 'nba.pm') continue;
    const line = Number(leg.line ?? market.defaultLine ?? 0);
    let prev = wholeGame ? 0 : null;
    for (const item of chrono) {
      const arr = item.snap?.[leg.playerId];
      if (!arr) continue;
      const now = Number(market.stat(Object.fromEntries(SNAP_KEYS.map((k, i) => [k, arr[i]])))) || 0;
      if (prev != null && prev <= line && now > line) {
        const over = leg.side !== 'under';
        if (!marks.has(item.id)) marks.set(item.id, []);
        marks.get(item.id).push({
          ok: over,
          text: `${over ? '✓' : '✗'} ${lastName(leg.playerName)} ${over ? 'o' : 'u'}${line} ${market.short} ${over ? 'hit' : 'busted'}`,
        });
        break;
      }
      prev = now;
    }
  }
  return marks;
}

// How much a play moved the acting team's chances, from ESPN's win probability.
function swingHtml(swing, side, box) {
  if (swing == null) return '';
  const away = side === 'away';
  const v = away ? -swing : swing;
  if (Math.abs(v) < 0.5) return '';
  return `<span class="fd-swing ${v > 0 ? 'up' : 'down'}">${esc(away ? box.away.abbr : box.home.abbr)} ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%</span>`;
}

function winBarHtml(box) {
  const wp = box.feed?.winProb;
  if (wp == null || box.state === 'pre') return '';
  const home = Math.max(0, Math.min(100, wp));
  const away = 100 - home;
  // Team colours, unless one would vanish on the dark card (Denver's navy).
  const color = (side, fallback) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(side.color || '')?.[1];
    if (!hex) return fallback;
    const n = parseInt(hex, 16);
    return Math.max(n >> 16, (n >> 8) & 255, n & 255) >= 110 ? side.color : fallback;
  };
  return `<div class="fd-wp">
    <span>${esc(box.away.abbr)} <b>${Math.round(away)}%</b></span>
    <div class="fd-wp-bar"><i style="width:${away}%;background:${color(box.away, 'var(--accent)')}"></i><i style="width:${home}%;background:${color(box.home, 'var(--muted)')}"></i></div>
    <span><b>${Math.round(home)}%</b> ${esc(box.home.abbr)}</span>
  </div>`;
}

function cardHtml(item, box, players, ctx) {
  const a = item.a && players[item.a.id];
  const b = item.b && players[item.b.id];
  const logo = item.team === box.away.abbr ? box.away.logo : item.team === box.home.abbr ? box.home.logo : null;
  const face = a?.headshot ? `<img class="fd-face" src="${esc(a.headshot)}" alt="" loading="lazy">`
    : logo ? `<img class="fd-face logo" src="${esc(logo)}" alt="" loading="lazy">` : '<span class="fd-face"></span>';
  const badge = a?.headshot && logo ? `<img class="fd-badge" src="${esc(logo)}" alt="" loading="lazy">` : '';
  const marks = (ctx.markers.get(item.id) || []).map((m) => `<span class="fd-mark ${m.ok ? 'ok' : 'bad'}">${esc(m.text)}</span>`);
  const notes = (item.notes || []).map((n) => `<span class="fd-note">${esc(n)}</span>`);
  const tracked = [item.a?.id, item.b?.id].some((id) => id && ctx.tracked.has(id));
  return `<div class="fd-item fd-card${tracked ? ' tracked' : ''}${ctx.fresh.has(item.id) ? ' fresh' : ''}" data-fd-id="${esc(item.id)}">
    <div class="fd-avatar">${face}${badge}</div>
    <div class="fd-main">
      <div class="fd-meta"><span>${esc(box.away.abbr)} ${item.away}-${item.home} ${esc(box.home.abbr)} &middot; ${periodLabel(item.q)} ${esc(item.clock)}</span>${swingHtml(item.swing, item.side, box)}</div>
      <div class="fd-title">${esc(item.title)}</div>
      ${a ? `<div class="fd-line"><a class="fd-name" href="${esc(playerUrl(box.sport, item.a.id))}" target="_blank" rel="noopener"><b>${esc(a.name)}</b></a> &middot; ${esc(item.a.line)}</div>` : ''}
      ${b ? `<div class="fd-line sub"><a class="fd-name" href="${esc(playerUrl(box.sport, item.b.id))}" target="_blank" rel="noopener">${esc(b.name)}</a> &middot; ${esc(item.b.line)}</div>` : ''}
      ${marks.length || notes.length ? `<div class="fd-notes">${marks.join('')}${notes.join('')}</div>` : ''}
    </div>
  </div>`;
}

// Subs, timeouts, reviews and period breaks: one quiet line each.
function rowHtml(item, box, players, ctx) {
  const id = `data-fd-id="${esc(item.id)}"`;
  const fresh = ctx.fresh.has(item.id) ? ' fresh' : '';
  if (item.kind === 'period') {
    return `<div class="fd-item fd-divider${fresh}" ${id}><span>${esc(item.title)}</span><b>${esc(box.away.abbr)} ${item.away} – ${item.home} ${esc(box.home.abbr)}</b></div>`;
  }
  let what = esc(item.title);
  if (item.kind === 'sub') {
    const names = (ids) => ids.map((pid) => esc(players[pid]?.name || '')).filter(Boolean).join(', ');
    what = `<b>${esc(item.team)}</b> ${names(item.subs.map((s) => s.in))} in &middot; ${names(item.subs.map((s) => s.out))} out`;
  }
  return `<div class="fd-item fd-row${fresh}" ${id}><span class="fd-time">${periodLabel(item.q)} ${esc(item.clock)}</span><span>${what}</span></div>`;
}

function driveHtml(d, box, ctx) {
  const head = `<div class="fd-drive${d.current ? ' current' : ''}${d.score ? ' score' : ''}">
    <b>${esc(d.team)}</b><span>${esc(d.current ? 'Current drive' : d.result)}</span><span class="fd-desc">${esc(d.desc)}</span></div>`;
  const plays = d.plays.map((p) => {
    const tags = [p.scoring && '<span class="fd-note score">Score</span>', p.turnover && '<span class="fd-note">Turnover</span>',
      p.penalty && '<span class="fd-note">Penalty</span>'].filter(Boolean).join('');
    return `<div class="fd-item fd-play${p.scoring ? ' scoring' : ''}${ctx.fresh.has(p.id) ? ' fresh' : ''}" data-fd-id="${esc(p.id)}">
      <div class="fd-meta"><span>${periodLabel(p.q)} ${esc(p.clock)}${p.down ? ` &middot; ${esc(p.down)}` : ''}${p.at ? ` at ${esc(p.at)}` : ''}</span>${swingHtml(p.swing, d.side, box)}</div>
      <div class="fd-text">${esc(p.text)}</div>
      ${tags ? `<div class="fd-notes">${tags}</div>` : ''}
    </div>`;
  }).join('');
  return head + plays;
}

/**
 * The feed panel: win-probability bar, then plays newest first. ctx carries
 * your leg markers, the players you're tracking and which plays are new since
 * the last render (they flash).
 */
export function feedHtml(box, ctx = {}) {
  const feed = box?.feed;
  if (!feed) return '';
  const c = { markers: ctx.markers || new Map(), tracked: ctx.tracked || new Set(), fresh: ctx.fresh || new Set() };
  const nfl = box.sport === 'nfl';
  const shown = nfl ? feed.drives.reduce((n, d) => n + d.plays.length, 0) : feed.items.length;
  if (!shown) {
    const note = box.state === 'pre' ? `The feed starts at ${nfl ? 'kickoff' : 'tip-off'}.` : 'No plays yet.';
    return `<div class="feed">${winBarHtml(box)}<div class="empty"><div class="note">${note}</div></div></div>`;
  }
  const body = nfl
    ? feed.drives.map((d) => driveHtml(d, box, c)).join('')
    : feed.items.map((it) => (ROW_KINDS.has(it.kind) ? rowHtml(it, box, feed.players, c) : cardHtml(it, box, feed.players, c))).join('');
  const more = feed.total > shown ? '<button class="btn ghost sm fd-more" data-feed-more>Show earlier plays</button>' : '';
  return `<div class="feed">${winBarHtml(box)}<div class="fd-list">${body}</div>${more}</div>`;
}

/** One line with the newest play, for the top of the box score tabs on a phone. */
export function latestPlayHtml(box) {
  const feed = box?.feed;
  if (!feed) return '';
  let text;
  if (box.sport === 'nfl') {
    const p = feed.drives?.[0]?.plays?.[0];
    if (!p) return '';
    text = `${periodLabel(p.q)} ${p.clock}${p.down ? ` · ${p.down}` : ''} · ${p.text}`;
  } else {
    const it = (feed.items || []).find((x) => !ROW_KINDS.has(x.kind));
    if (!it) return '';
    const who = it.a && feed.players[it.a.id]?.name;
    text = `${periodLabel(it.q)} ${it.clock} · ${who ? `${who}: ` : ''}${it.title}${it.a?.line ? ` · ${it.a.line}` : ''}`;
  }
  return `<button class="fd-strip" data-box-side="feed">${box.state === 'in' ? '<span class="live-dot"></span>' : ''}<span class="fd-strip-text">${esc(text)}</span><span class="fd-strip-go">&#8250;</span></button>`;
}
