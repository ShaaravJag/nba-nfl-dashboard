// HTML for the Fantasy view under NFL: your matchup in each league, laid out
// like Sleeper's matchup screen. Pure functions of the /api/fantasy payload,
// like scores.js and feed.js -- app.js owns fetching, polling and state.
import { gamesTopHtml } from './scores.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n, d) => (n == null ? '–' : Number(n).toFixed(d));
const ordinal = (q) => ['', '1st', '2nd', '3rd', '4th'][q] || 'OT';

const SLOT_CLASS = { QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', K: 'k', DEF: 'def', 'D/ST': 'def' };

/** "Sun 1:00 PM @ BUF · 65°", "BAL 17-14 BUF · 4:12 3rd", "Final · LV 20-23 NYJ" or "Bye". */
export function gameLine(p, games) {
  const g = games?.[p.team];
  if (!g) return 'Bye';
  const home = g.home.abbr === p.team;
  const us = home ? g.home : g.away;
  const them = home ? g.away : g.home;
  if (g.state === 'pre') {
    const when = new Date(g.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `${when} ${home ? 'vs' : '@'} ${them.abbr}${g.weather?.temp != null ? ` · ${g.weather.temp}°` : ''}`;
  }
  const score = `${us.abbr} ${us.score}-${them.score} ${them.abbr}`;
  if (g.state === 'post') return `Final · ${score}`;
  const clock = /half/i.test(g.detail || '') ? 'Half' : g.period > 4 ? `${g.clock} OT` : `${g.clock} ${ordinal(g.period)}`;
  return `${score} · ${clock}`;
}

// One player's half of a row. Every piece has its own grid cell -- name,
// points, projection, game, stats -- so nothing can sit on top of anything else;
// long text ends in "…" inside its own cell.
function cellHtml(p, side, ctx) {
  if (!p) return `<div class="fx-cell ${side} empty">Empty</div>`;
  const d = ctx.decimals;
  const link = p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`
    : esc(p.name);
  const inj = p.inj ? ` <b class="fx-inj${p.inj === 'Q' || p.inj === 'D' ? '' : ' out'}">${esc(p.inj)}</b>` : '';
  const done = p.status === 'in' ? Math.round((1 - p.left) * 100) : p.status === 'post' ? 100 : 0;
  // A wrapped stat line breaks between stats, never between "2" and "INT".
  const stat = p.status === 'pre' ? 'Yet to play' : (p.line || '').replace(/(\S) (?=[A-Z]{2,})/g, '$1 ');
  return `<div class="fx-cell ${side} ${esc(p.status)}${ctx.up.has(`${ctx.league}:${p.id}`) ? ' up' : ''}">
    <img class="fx-img${p.pos === 'DEF' ? ' logo' : ''}" src="${esc(p.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <span class="fx-name">${link}${inj}</span>
    <span class="fx-meta">${p.pos === 'DEF' ? 'D/ST' : esc(p.pos)}<span class="fx-tm"> · ${esc(p.team || 'FA')}</span></span>
    <span class="fx-pts${p.pts == null ? ' none' : ''}">${p.pts == null ? '–' : num(p.pts, d)}</span>
    <span class="fx-proj">${num(p.proj, d)}</span>
    <i class="fx-bar"><b style="width:${done}%"></b></i>
    <span class="fx-game">${p.status === 'in' ? '<span class="live-dot"></span>' : ''}${gameLine(p, ctx.games).split(' · ').map((s) => `<span>${esc(s)}</span>`).join(' · ')}</span>
    <span class="fx-stat${p.status === 'pre' ? ' dim' : ''}">${esc(stat || ' ')}</span>
  </div>`;
}

const rowHtml = (r, ctx) => `<div class="fx-row">${cellHtml(r.a, 'l', ctx)}`
  + `<div class="fx-slot ${SLOT_CLASS[r.slot] || 'flex'}">${esc(r.slot)}</div>${cellHtml(r.b, 'r', ctx)}</div>`;

function teamHtml(t, side, d) {
  if (!t) return `<div class="fx-team ${side} bye"><div class="fx-who"><div class="fx-tname">Bye week</div></div></div>`;
  const initials = t.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const av = t.avatar
    ? `<img class="fx-av" src="${esc(t.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<span class="fx-av">${esc(initials)}</span>`;
  return `<div class="fx-team ${side}">
    ${av}
    <div class="fx-who"><div class="fx-owner">${esc(t.owner)}</div><div class="fx-tname">${esc(t.name)}</div></div>
    <div class="fx-score">${num(t.score, d)}</div>
    <div class="fx-sub">${esc(t.record)} · proj ${num(t.proj, d)}</div>
  </div>`;
}

function yetHtml(t, side) {
  if (!t) return '<div></div>';
  const what = t.yet ? `Yet to play (${t.yet})` : t.inPlay ? 'Everyone has kicked off' : 'All done';
  const playing = t.inPlay ? `${t.inPlay} playing now` : '';
  return `<div class="${side}"><b>${what}</b><span>${esc([t.yetPos, playing].filter(Boolean).join(' · '))}</span></div>`;
}

function headHtml(l) {
  const d = l.decimals;
  const head = `<div class="fx-head">${teamHtml(l.me, 'l', d)}<div class="fx-vs">VS</div>${teamHtml(l.opp, 'r', d)}</div>`;
  if (!l.opp) return head;
  if (l.final) {
    const margin = Math.abs(l.me.score - l.opp.score).toFixed(d);
    const verdict = l.me.score > l.opp.score ? `You won by ${margin}` : l.me.score < l.opp.score ? `You lost by ${margin}` : 'Tied';
    return `${head}<div class="fx-final">Final · ${verdict}</div>`;
  }
  const me = Math.round((l.win ?? 0.5) * 100);
  return `${head}
    <div class="fx-wp"><b>${me}%</b><div class="fx-wp-bar"><i style="width:${me}%"></i><i style="width:${100 - me}%"></i></div><b>${100 - me}%</b></div>
    <div class="fx-ytp">${yetHtml(l.me, 'l')}${yetHtml(l.opp, 'r')}</div>`;
}

function chipsHtml(data, current) {
  return `<div class="fx-chips">${data.leagues.map((l) => {
    const lead = l.me && l.opp ? Math.sign(l.me.score - l.opp.score) : 0;
    const score = l.error ? '<span class="dim">—</span>'
      // One decimal here whatever the league uses, so three chips fit a phone.
      : `<b class="${lead > 0 ? 'lead' : lead < 0 ? 'trail' : ''}">${num(l.me.score, 1)}</b> – ${l.opp ? num(l.opp.score, 1) : 'bye'}`;
    return `<button class="fx-chip${l.key === current ? ' on' : ''}" data-fx-league="${esc(l.key)}">
      <span class="fx-chip-name">${l.live ? '<span class="live-dot"></span>' : ''}${esc(l.name)}</span>
      <span class="fx-chip-score">${score}</span></button>`;
  }).join('')}</div>`;
}

function weekPickHtml(data) {
  const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
  return `<label class="fx-week">Wk <select id="fx-week">${weeks.map((w) =>
    `<option value="${w}"${w === data.week ? ' selected' : ''}>${w}${w === data.currentWeek ? ' (now)' : ''}</option>`).join('')}</select></label>`;
}

function keyPromptHtml(message) {
  return `<div class="panel">
    <h3>Fantasy key</h3>
    <div class="note">Your fantasy leagues are locked behind the key you set as FANTASY_KEY in Vercel. It's saved on this device only.</div>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
    <div class="row" style="margin-top:10px"><input id="in-fx-key" type="password" autocomplete="off" placeholder="Fantasy key">
      <button class="btn sm" id="btn-fx-key" style="flex:none">Unlock</button></div>
  </div>`;
}

/**
 * The whole view. fx is app state: { data, status, message, bench };
 * ctx carries which league is open and which players' points just went up.
 */
export function fantasyHtml(fx, ctx = {}) {
  const top = `<div class="games-top">${gamesTopHtml('nfl', 'fantasy')}</div>`;
  if (fx.status === 'key') return top + keyPromptHtml(fx.message);
  if (fx.status === 'setup') {
    return `${top}<div class="empty"><div>Fantasy isn't set up on the server yet.</div>
      <div class="note">Add FANTASY_KEY, ESPN_S2 and ESPN_SWID to the project's environment variables in Vercel, then redeploy.</div></div>`;
  }
  const data = fx.data;
  if (!data) {
    return top + (fx.status === 'error'
      ? `<div class="empty"><div>Couldn't load your leagues.</div><div class="note">${esc(fx.message || 'Check your connection and try again.')}</div></div>`
      : '<div class="empty"><div class="note">Loading your matchups…</div></div>');
  }
  const l = data.leagues.find((x) => x.key === ctx.league) || data.leagues.find((x) => !x.error) || data.leagues[0];
  const sec = (label) => `<div class="fx-sec"><span>${label}</span>${weekPickHtml(data)}</div>`;
  if (l.error) return `${top}${chipsHtml(data, l.key)}${sec(esc(l.name))}<div class="empty"><div class="note">${esc(l.error)}</div></div>`;

  const c = { decimals: l.decimals, games: data.games, league: l.key, up: ctx.up || new Set() };
  const benchCount = l.bench.length + l.ir.length;
  const bench = fx.bench ? [...l.bench, ...l.ir].map((r) => rowHtml(r, c)).join('') : '';
  return `${top}${chipsHtml(data, l.key)}
    <div class="fx">
      ${headHtml(l)}
      ${sec('Starters')}
      ${l.rows.map((r) => rowHtml(r, c)).join('')}
      ${benchCount ? `<button class="fx-sec fx-toggle" data-fx-bench><span>Bench</span><span class="fx-more">${fx.bench ? 'Hide' : `Show ${benchCount}`}</span></button>${bench}` : ''}
    </div>`;
}
