import {
  MARKETS, UNSUPPORTED, marketGroups, resolveMarket, evaluateLeg, betStatus,
  payoutFor, priceBet, formatOdds, combineOdds, legAlerts, sweatLine,
} from './markets.js';
import { createSync } from './sync.js';
import { IMPORT_PROMPT } from './import-prompt.js';
import { scoreboardHtml, boxScoreHtml, otherGamesHtml, MARKET_COLUMNS } from './scores.js';
import { feedHtml, latestPlayHtml, legMarkers } from './feed.js';
import { fantasyHtml } from './fantasy.js';

const BETS_KEY = 'bt.bets.v2';
const PREFS_KEY = 'bt.prefs.v1';
const PINS_KEY = 'bt.pins.v1';
const FX_KEY = 'bt.fantasyKey';   // unlocks /api/fantasy; per device, never synced
const PIN_DAYS = 3;          // pinned games drop off after this, so finished ones don't pile up
const BOOKS = ['FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'ESPN BET', 'Fanatics', 'Other'];

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n == null ? '--' : `$${Number(n).toFixed(2)}`);

// ---------------------------------------------------------------- state

const prefs = load(PREFS_KEY, { sound: true, book: 'FanDuel' });

const state = {
  bets: load(BETS_KEY, []),
  pins: freshPins(load(PINS_KEY, {})),
  prefs,
  games: {},
  slate: null,
  tab: 'live',
  lastFetch: 0,
  fetching: false,
  legStatus: {},      // legId -> last seen status, drives the flash + beep
  draft: newDraft(prefs.book),
  picker: newPicker(),
  scores: newScores(prefs.scoresSport),
  box: null,          // { sport, id, data, side, from, pushed, scrollTop, error }: the last box score opened
  gamesView: 'list',  // what the Games tab shows when you come back to it: 'list', 'game' or 'fantasy'
  // Fantasy matchups. prev holds each player's last points, so a rise flashes.
  fx: { data: null, status: null, message: '', week: null, bench: false, prev: new Map() },
};

function load(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function newDraft(book = 'FanDuel') { return { book, stake: '', odds: '', payout: '', legs: [] }; }
function newPicker() { return { query: '', pick: null, market: null, line: '', side: 'over', odds: '', teamAbbr: null }; }
function newScores(sport = 'nba') {
  return { sport, today: null, date: null, week: null, seasonType: null, weekMeta: null, data: null, error: null };
}

function persist({ push = true } = {}) {
  save(BETS_KEY, state.bets);
  save(PREFS_KEY, state.prefs);
  save(PINS_KEY, state.pins);
  if (push) sync.push(state.bets, state.pins);
}

// { "nba:401909868": pinnedAt }, minus anything older than PIN_DAYS.
function freshPins(pins) {
  const cutoff = Date.now() - PIN_DAYS * 86400000;
  return Object.fromEntries(Object.entries(pins || {}).filter(([, at]) => at > cutoff));
}

// ---------------------------------------------------------------- sync

const sync = createSync({
  onRemote(bets, pins) {
    state.bets = bets;
    save(BETS_KEY, bets);
    if (pins) { state.pins = freshPins(pins); save(PINS_KEY, state.pins); }
    render();
    toast('Synced from your other device');
  },
});

// ---------------------------------------------------------------- data

async function loadSlate(force = false) {
  if (state.slate && !force && Date.now() - state.slate.fetchedAt < 10 * 60 * 1000) return state.slate;
  try {
    const res = await fetch('/api/slate');
    if (!res.ok) throw new Error(`slate ${res.status}`);
    state.slate = await res.json();
  } catch (err) {
    console.warn('slate failed', err);
    state.slate = state.slate || { games: [], players: [], fetchedAt: 0 };
  }
  return state.slate;
}

/** Event ids still worth polling: anything on an unsettled bet. */
function activeEventIds() {
  const bySport = { nba: new Set(), nfl: new Set() };
  for (const bet of state.bets) {
    if (bet.result) continue;
    for (const leg of bet.legs) {
      if (leg.eventId && bySport[leg.sport]) bySport[leg.sport].add(leg.eventId);
    }
  }
  return bySport;
}

async function poll() {
  if (state.fetching) return;
  const bySport = activeEventIds();
  const params = new URLSearchParams();
  for (const [sport, ids] of Object.entries(bySport)) {
    if (ids.size) params.set(sport, [...ids].sort().join(','));
  }
  if (![...params.keys()].length) { setPulse(false, 'no open bets'); return; }

  state.fetching = true;
  try {
    const res = await fetch(`/api/live?${params}`);
    if (!res.ok) throw new Error(`live ${res.status}`);
    const data = await res.json();
    Object.assign(state.games, data.games);
    state.lastFetch = Date.now();
    settleFinished();
    if (state.tab === 'live') renderLive();
    const anyLive = Object.values(state.games).some((g) => g.state === 'in');
    setPulse(anyLive, anyLive ? 'live' : 'updated');
  } catch (err) {
    console.warn('poll failed', err);
    setPulse(false, 'offline');
  } finally {
    state.fetching = false;
  }
}

// Poll fast while something is live and we are on screen, slowly in the
// background, and not at all when nothing is in progress.
function pollInterval() {
  const games = Object.values(state.games);
  const bySport = activeEventIds();
  const tracking = bySport.nba.size + bySport.nfl.size;
  if (!tracking) return 60000;
  const anyLive = games.some((g) => g.state === 'in');
  if (!anyLive) return 30000;
  return document.hidden ? 15000 : 3000;
}

let pollTimer = null;
function scheduleNextPoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => { await poll(); scheduleNextPoll(); }, pollInterval());
}

// ---------------------------------------------------------------- games + box score

function scoresQuery() {
  const s = state.scores;
  const q = new URLSearchParams({ sport: s.sport });
  if (s.sport === 'nba' && s.date) q.set('date', s.date);
  if (s.sport === 'nfl' && s.week) { q.set('week', s.week); q.set('seasontype', s.seasonType || 2); }
  return q.toString();
}

async function loadScores() {
  const query = scoresQuery();
  try {
    const res = await fetch(`/api/scores?${query}`);
    if (!res.ok) throw new Error(`scores ${res.status}`);
    const data = await res.json();
    if (query !== scoresQuery()) return;             // moved to another day or sport meanwhile
    const s = state.scores;
    Object.assign(s, { data, error: null, today: data.today || s.today });
    // Pin the default day or week so later polls ask for it by name.
    if (s.sport === 'nba' && !s.date) s.date = data.date;
    if (s.sport === 'nfl' && data.week) {
      s.weekMeta = data.week;
      if (!s.week) { s.week = data.week.number; s.seasonType = data.week.seasonType; }
    }
  } catch (err) {
    console.warn('scores failed', err);
    if (query === scoresQuery()) state.scores.error = 'Check your connection and try again.';
  }
  if (state.tab === 'games') renderGames();
  else if (state.tab === 'game') renderBox();
}

async function loadBoxScore() {
  const box = state.box;
  if (!box) return;
  const { sport, id } = box;
  try {
    const res = await fetch(`/api/box?sport=${sport}&id=${id}&limit=${box.limit || FEED_STEP}`);
    if (!res.ok) throw new Error(`box ${res.status}`);
    const data = await res.json();
    if (state.box?.id !== id) return;
    Object.assign(state.box, { data, error: null });
  } catch (err) {
    console.warn('box failed', err);
    if (state.box?.id === id && !state.box.data) state.box.error = "Couldn't load this box score.";
  }
  if (state.tab === 'game' && state.box?.id === id) renderBox();
}

function fantasyKey() {
  try { return localStorage.getItem(FX_KEY) || ''; } catch { return ''; }
}

async function loadFantasy() {
  const fx = state.fx;
  const key = fantasyKey();
  if (!key) {
    Object.assign(fx, { status: 'key', message: '' });
    if (state.tab === 'fantasy') renderFantasy();
    return;
  }
  const week = fx.week;
  try {
    const res = await fetch(`/api/fantasy${week ? `?week=${week}` : ''}`, { headers: { 'x-fantasy-key': key }, cache: 'no-store' });
    if (week !== fx.week) return;                    // picked another week meanwhile
    if (res.status === 401) Object.assign(fx, { status: 'key', message: "That key didn't work.", data: null });
    else if (res.status === 503) Object.assign(fx, { status: 'setup', data: null });
    else if (!res.ok) throw new Error(`fantasy ${res.status}`);
    else {
      const data = await res.json();
      if (week !== fx.week) return;
      Object.assign(fx, { data, status: null, message: '' });
      if (!fx.week) fx.week = data.week;
    }
  } catch (err) {
    console.warn('fantasy failed', err);
    if (!fx.data) Object.assign(fx, { status: 'error', message: 'Check your connection and try again.' });
  }
  if (state.tab === 'fantasy') renderFantasy();
}

// The Games tab and an open box score poll on their own timer, separate from
// the bet loop, and only while you are looking at them.
let viewTimer = null;

function viewDelay() {
  if (document.hidden) return null;
  if (state.tab === 'games') return state.scores.data?.games?.some((g) => g.state === 'in') ? 10000 : 60000;
  // Sleeper's live stats refresh every 4s and ESPN's fantasy API isn't cached,
  // so a live matchup keeps pace with their own apps.
  if (state.tab === 'fantasy') {
    if (state.fx.status === 'key' || state.fx.status === 'setup') return null;
    return state.fx.data?.live ? 5000 : 60000;
  }
  if (state.tab === 'game') {
    const s = state.box?.data?.state;
    if (s === 'in') return 5000;
    // A finished box stops changing, but the strip of other games keeps moving.
    return state.scores.data?.games?.some((g) => g.state === 'in') ? 15000 : s === 'post' ? 60000 : 30000;
  }
  return null;
}

async function refreshView() {
  if (state.tab === 'games') await loadScores();
  else if (state.tab === 'game') await Promise.all([loadBoxScore(), loadStrip()]);
  else if (state.tab === 'fantasy') await loadFantasy();
}

// The strip above a box score shows the Games tab's slate. Opened from a bet
// leg or a link, that slate may be missing or for the other sport, so load the
// game's sport (today, or the current NFL week); otherwise refresh it at most
// every 15s.
let stripAt = 0;
async function loadStrip() {
  const sport = state.box?.sport;
  if (!sport) return;
  if (state.scores.sport !== sport) state.scores = newScores(sport);
  if (state.scores.data && Date.now() - stripAt < 15000) return;
  stripAt = Date.now();
  await loadScores();
}

function scheduleView() {
  clearTimeout(viewTimer);
  const ms = viewDelay();
  if (ms) viewTimer = setTimeout(async () => { await refreshView(); scheduleView(); }, ms);
}

// Entering a view fetches straight away, then settles into its own cadence.
function startView() {
  clearTimeout(viewTimer);
  if (['games', 'game', 'fantasy'].includes(state.tab)) refreshView().then(scheduleView);
}

function openLegCounts() {
  const counts = new Map();
  for (const bet of state.bets) {
    if (bet.result) continue;
    for (const leg of bet.legs) if (leg.eventId) counts.set(leg.eventId, (counts.get(leg.eventId) || 0) + 1);
  }
  return counts;
}

/** playerId -> box-score columns your open bets on this game ride on. */
function trackedFor(eventId) {
  const map = new Map();
  for (const bet of state.bets) {
    if (bet.result) continue;
    for (const leg of bet.legs) {
      if (leg.eventId !== eventId || !leg.playerId) continue;
      if (!map.has(leg.playerId)) map.set(leg.playerId, new Set());
      for (const col of MARKET_COLUMNS[leg.market] || []) map.get(leg.playerId).add(col);
    }
  }
  return map;
}

function setPulse(on, text) {
  $('#pulse-dot').classList.toggle('on', !!on);
  $('#pulse-text').textContent = text;
}

/** Freeze a bet's outcome once every game involved has ended. */
function settleFinished() {
  let changed = false;
  for (const bet of state.bets) {
    if (bet.result) continue;
    const results = bet.legs.map((leg) => evaluateLeg(leg, state.games));
    const allDone = bet.legs.every((leg, i) => {
      if (leg.manualStatus || leg.market === UNSUPPORTED) return !!leg.manualStatus;
      const g = state.games[leg.eventId];
      return g && (g.state === 'post' || ['won', 'lost', 'push', 'void'].includes(results[i].status));
    });
    const status = betStatus(results);
    // A busted leg settles the whole parlay immediately -- no need to wait.
    const dead = results.some((r) => ['lost', 'bust'].includes(r.status));
    if (!allDone && !dead) continue;
    bet.result = {
      status: dead ? 'lost' : status,
      at: Date.now(),
      // Frozen with the bet: what it actually paid once void legs dropped out.
      // Null when a re-price had no odds to work from -- History asks for it.
      payout: dead ? 0 : payoutFor(bet, results),
      legs: results.map((r, i) => ({ id: bet.legs[i].id, value: r.value, status: r.status })),
    };
    changed = true;
  }
  if (changed) persist();
}

// ---------------------------------------------------------------- audio

let audioCtx = null;
function beep(up) {
  if (!state.prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(up ? 660 : 400, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(up ? 990 : 260, audioCtx.currentTime + 0.16);
    gain.gain.setValueAtTime(0.09, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    osc.start(); osc.stop(audioCtx.currentTime + 0.32);
  } catch { /* no audio available */ }
}

// ---------------------------------------------------------------- render

function render() {
  $('#view').classList.toggle('wide', state.tab === 'game' && wideMQ.matches);
  // A box score and the fantasy view live under Games.
  const tab = state.tab === 'game' || state.tab === 'fantasy' ? 'games' : state.tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  if (state.tab === 'live') renderLive();
  else if (state.tab === 'games') renderGames();
  else if (state.tab === 'game') renderBox();
  else if (state.tab === 'fantasy') renderFantasy();
  else if (state.tab === 'add') renderAdd();
  else if (state.tab === 'history') renderHistory();
  else if (state.tab === 'settings') renderSettings();
}

function statusPill(status) {
  const map = { won: 'won', lost: 'lost', live: 'live', pending: 'pending' };
  const label = { won: 'Won', lost: 'Lost', live: 'Live', pending: 'Pending', void: 'Void', push: 'Push' }[status] || status;
  return `<span class="pill ${map[status] || 'pending'}">${label}</span>`;
}

function legSubtitle(leg, res) {
  if (leg.market === UNSUPPORTED) return esc(leg.rawLabel || 'Manual leg');
  const market = MARKETS[leg.market];
  if (!market) return esc(leg.market);
  if (market.margin) {
    return leg.market.endsWith('moneyline')
      ? `${esc(leg.teamAbbr)} MONEYLINE`
      : `${esc(leg.teamAbbr)} ${leg.line > 0 ? '+' : ''}${leg.line} SPREAD`;
  }
  if (market.boolean) return esc(market.boolean.toUpperCase());
  const side = leg.side === 'under' ? 'UNDER' : 'OVER';
  return `${side} ${leg.line} ${esc(market.label.toUpperCase())}`;
}

function gameStripHtml(g, leg) {
  if (!g) return `<div class="gamestrip"><span class="badge-final">--</span><span>Waiting for data</span></div>`;
  const badge = g.state === 'in' ? '<span class="badge-live">LIVE</span>'
    : g.state === 'post' ? '<span class="badge-final">FINAL</span>'
    : '<span class="badge-final">SOON</span>';
  // statusDetail is the clock mid-game and tip-off time before it, but just
  // repeats the badge once the game is over.
  const when = g.state === 'post' ? '' : `<span>${esc(g.statusDetail)}</span><span class="sep">&middot;</span>`;
  const odds = leg.americanOdds ? `<span class="odds">${formatOdds(leg.americanOdds)}</span>` : '';
  return `<div class="gamestrip" data-open-game="${esc(leg.sport)}:${esc(leg.eventId)}">${badge}${when}` +
    `<span>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span>${odds}<span class="strip-go">&#8250;</span></div>`;
}

function teamsHtml(g) {
  if (!g) return '<div class="teams"></div>';
  const row = (side) => {
    const ball = g.possession && g.possession === side.id ? ' has-ball' : '';
    const logo = side.logo ? `<img src="${esc(side.logo)}" alt="${esc(side.abbr)}" loading="lazy">` : '<span style="width:19px"></span>';
    return `<div class="team-row${ball}">${logo}<span class="sc">${side.score}</span></div>`;
  };
  return `<div class="teams">${row(g.away)}${row(g.home)}</div>`;
}

function barHtml(res) {
  if (res.manual || res.margin || res.value == null) return '';
  const pct = Math.max(0, Math.min(100, res.progress * 100));
  const knob = Math.max(5, Math.min(95, pct));
  const label = Number.isInteger(res.value) ? res.value : Math.round(res.value * 10) / 10;
  const target = res.side === 'over' ? res.target : res.line;
  return `<div class="bar">
    <div class="track">
      <div class="fill" style="width:${pct}%"></div>
      <div class="knob" style="left:${knob}%">${label}</div>
    </div>
    <span class="target">${target}</span>
  </div>`;
}

function legFootHtml(leg, res, alerts = []) {
  const bits = alerts.map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`);
  if (res.status === 'void') {
    bits.push(`<span class="void-tag">Void &middot; ${esc(res.voidReason)}</span><span>dropped from the bet</span>`);
  } else if (res.manual) {
    bits.push('<span>Not auto-tracked</span>');
  } else if (!alerts.some((al) => al.void)) {
    // A leg the book will likely void has no target worth counting toward.
    if (res.needed > 0 && res.status === 'live') bits.push(`<span>needs ${res.needed} more</span>`);
    if (res.status === 'hit') bits.push('<span style="color:var(--green)">Hit</span>');
    if (res.status === 'bust') bits.push('<span style="color:var(--red)">Busted</span>');
    if (res.projection != null && res.status === 'live') bits.push(`<span class="sep">&middot;</span><span>on pace for ${res.projection}</span>`);
    // A 0-0 margin before tip-off is noise, not information.
    if (res.margin && res.status !== 'pending') bits.push(`<span>margin ${res.detail}</span>`);
  }
  const manual = `<span class="manual-btns">
      <button data-manual="won" data-leg="${leg.id}" class="${leg.manualStatus === 'won' ? 'on-win' : ''}">Hit</button>
      <button data-manual="lost" data-leg="${leg.id}" class="${leg.manualStatus === 'lost' ? 'on-lose' : ''}">Miss</button>
    </span>`;
  if (!bits.length && !res.manual) return '';
  return `<div class="leg-foot">${bits.join('')}${res.manual ? manual : ''}</div>`;
}

function legHtml(leg, res) {
  const g = state.games[leg.eventId];
  const prev = state.legStatus[leg.id];
  let flash = '';
  if (prev && prev !== res.status) {
    if (['hit', 'won'].includes(res.status)) { flash = ' flash'; beep(true); }
    else if (['bust', 'lost'].includes(res.status)) { flash = ' flash-bad'; beep(false); }
  }
  state.legStatus[leg.id] = res.status;

  const isPlayer = MARKETS[leg.market]?.kind === 'player' || leg.playerName;
  const player = g?.players?.[leg.playerId];
  const onCourt = player?.onCourt;
  const dot = leg.sport === 'nba' && g?.state === 'in' && isPlayer
    ? `<span class="oncourt ${onCourt ? '' : 'off'}" title="${onCourt ? 'On the floor' : 'On the bench'}"></span>` : '';
  const title = isPlayer ? esc(leg.playerName) : esc(MARKETS[leg.market]?.label || leg.rawLabel || 'Leg');
  // Minutes and fouls are what tell you whether an NBA over still has time.
  const meta = leg.sport === 'nba' && isPlayer && player && g?.state !== 'pre'
    ? `<span class="pmeta">${player.stats?.min ?? 0} MIN &middot; ${player.stats?.pf ?? 0} PF</span>` : '';

  return `<div class="leg ${res.status}${flash}" data-leg="${leg.id}">
    ${gameStripHtml(g, leg)}
    <div class="leg-body">
      ${teamsHtml(g)}
      <div>
        <div class="pname">${title}${dot}</div>
        <div class="pmarket"><span>${legSubtitle(leg, res)}</span>${meta}</div>
        ${barHtml(res)}
      </div>
    </div>
    ${legFootHtml(leg, res, legAlerts(leg, g, res))}
  </div>`;
}

function betHtml(bet) {
  const results = bet.legs.map((leg) => evaluateLeg(leg, state.games));
  const status = bet.result?.status || betStatus(results);
  // A void leg drops out and the parlay is re-priced on the legs that stand.
  const price = priceBet(bet, results);
  const refund = ['void', 'push'].includes(status);
  const odds = price.repriced ? price.odds : bet.americanOdds || combineOdds(bet.legs.map((l) => l.americanOdds));
  const title = bet.legs.length > 1 ? `${bet.legs.length}-leg parlay` : 'Straight bet';
  const sub = [
    bet.stake && refund ? `${money(bet.stake)} stake back` : null,
    bet.stake && !refund ? `${money(bet.stake)} to win ${money(price.payout != null ? price.payout - bet.stake : null)}` : null,
    odds && !refund ? formatOdds(odds) : null,
    price.repriced && !refund
      ? `<span class="repriced">${price.payout == null ? 're-price needs leg odds' : 're-priced'}</span>` : null,
  ].filter(Boolean).join('  ·  ');

  // Folded, a card keeps its header and a one-line count of where the legs stand.
  const folded = !!state.prefs.collapsed?.[bet.id];
  const count = (...ss) => results.filter((r) => ss.includes(r.status)).length;
  const tally = [
    count('hit', 'won') && `${count('hit', 'won')} ✓`,
    count('bust', 'lost') && `${count('bust', 'lost')} ✗`,
    count('live', 'unknown') && `${count('live', 'unknown')} live`,
    count('pending') && `${count('pending')} to go`,
  ].filter(Boolean).join(' · ');

  return `<article class="bet ${status}${folded ? ' collapsed' : ''}" data-bet="${bet.id}">
    <div class="bet-head" data-collapse="${bet.id}">
      <span class="book ${esc((bet.book || '').toLowerCase().replace(/\s/g, ''))}">${esc(bet.book || 'Bet')}</span>
      <span class="bet-title">${title}</span>
      ${folded && tally ? `<span class="bet-count">${tally}</span>` : ''}
      <span class="spacer" style="flex:1"></span>
      <button class="icon-btn fold" data-collapse="${bet.id}" title="${folded ? 'Show legs' : 'Hide legs'}">&#8964;</button>
      <button class="icon-btn" data-del="${bet.id}" title="Delete bet">&times;</button>
    </div>
    <div class="bet-meta">
      <span>${sub || ''}</span>
      <span class="spacer" style="flex:1"></span>
      ${statusPill(status)}
    </div>
    ${bet.result ? '' : `<div class="sweat">${esc(sweatLine(bet, results))}</div>`}
    ${bet.legs.map((leg, i) => legHtml(leg, results[i])).join('')}
  </article>`;
}

function renderLive() {
  // Forget folds for bets that are gone or settled.
  const c = state.prefs.collapsed;
  if (c) for (const id of Object.keys(c)) if (!state.bets.some((b) => b.id === id && !b.result)) delete c[id];
  const view = $('#view');
  const open = state.bets.filter((b) => !b.result);
  const atRisk = open.reduce((a, b) => a + (Number(b.stake) || 0), 0);
  const toWin = open.reduce((a, b) => {
    const p = payoutFor(b, b.legs.map((leg) => evaluateLeg(leg, state.games)));
    return a + (p ? p - (Number(b.stake) || 0) : 0);
  }, 0);

  if (!open.length) {
    view.innerHTML = `<div class="empty"><div class="big">&#9898;</div>
      <div>No open bets.</div>
      <div class="note">Add a parlay manually, or paste one in from a screenshot.</div>
      <div style="margin-top:16px"><button class="btn sm" data-goto="add">Add a bet</button></div></div>`;
    return;
  }

  view.innerHTML = `
    <div class="summary">
      <div class="sum-card"><div class="k">Open</div><div class="v">${open.length}</div></div>
      <div class="sum-card"><div class="k">At risk</div><div class="v">${money(atRisk)}</div></div>
      <div class="sum-card"><div class="k">To win</div><div class="v pos">${money(toWin)}</div></div>
    </div>
    ${open.map(betHtml).join('')}`;
}

function renderGames() {
  const view = $('#view');
  const top = view.scrollTop;
  view.innerHTML = scoreboardHtml(state.scores, { legCounts: openLegCounts(), pins: state.pins });
  view.scrollTop = top;
}

function renderFantasy() {
  const view = $('#view');
  const top = view.scrollTop;
  const fx = state.fx;
  // A player whose points went up since the last fetch flashes once.
  const up = new Set();
  for (const l of fx.data?.leagues || []) {
    for (const r of [...(l.rows || []), ...(l.bench || []), ...(l.ir || [])]) {
      for (const p of [r.a, r.b]) {
        if (!p || p.pts == null) continue;
        const key = `${l.key}:${p.id}`;
        if (fx.prev.has(key) && p.pts > fx.prev.get(key)) up.add(key);
        fx.prev.set(key, p.pts);
      }
    }
  }
  view.innerHTML = fantasyHtml(fx, { league: state.prefs.fxLeague, up });
  view.scrollTop = top;
}

/** Legs on your open bets that ride on this game. */
function openLegsOn(eventId) {
  return state.bets.filter((b) => !b.result).flatMap((b) => b.legs).filter((l) => l.eventId === eventId);
}

// Feed entries newest first, whichever sport.
const feedIds = (data) => (data?.feed?.items || data?.feed?.drives?.flatMap((d) => d.plays) || []).map((x) => x.id);

// The feed card you're reading, so it can stay put when new plays land above
// it. At the newest play already, there's nothing to hold: new plays come in.
function feedAnchor(scroller) {
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const cards = [...scroller.querySelectorAll('[data-fd-id]')];
  const first = cards.find((n) => n.getBoundingClientRect().bottom > top + 1);
  if (!first || first === cards[0]) return null;
  return { id: first.dataset.fdId, offset: first.getBoundingClientRect().top - top };
}

function restoreAnchor(scroller, anchor) {
  if (!scroller || !anchor) return;
  const card = scroller.querySelector(`[data-fd-id="${CSS.escape(anchor.id)}"]`);
  if (card) scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
}

function renderBox() {
  const view = $('#view');
  const wide = wideMQ.matches;
  view.classList.toggle('wide', wide);
  const box = state.box || {};
  const data = box.data;

  // Everything a 5s refresh would otherwise throw away: page scroll, each
  // table's sideways scroll, the feed column's scroll, the card being read.
  const top = view.scrollTop;
  const lefts = new Map([...view.querySelectorAll('[data-scroll-key]')].map((n) => [n.dataset.scrollKey, n.scrollLeft]));
  const colTop = view.querySelector('.col-feed')?.scrollTop || 0;
  const anchor = feedAnchor(wide ? view.querySelector('.col-feed') : view);

  // Plays that arrived since the last render flash once.
  const ids = feedIds(data);
  const fresh = new Set();
  if (box.seen) for (const id of ids) { if (box.seen.has(id)) break; fresh.add(id); }
  if (ids.length) box.seen = new Set(ids);

  const legs = openLegsOn(box.id);
  const feed = data?.feed;
  const feedPanel = data ? feedHtml(data, {
    markers: legMarkers(feed?.items, legs, !!feed && feed.total <= (feed.items?.length || 0)),
    tracked: new Set(legs.map((l) => l.playerId).filter(Boolean)),
    fresh,
  }) : '';
  view.innerHTML = boxScoreHtml(data, {
    side: box.side || 'feed', tracked: trackedFor(box.id), error: box.error, from: box.from,
    wide, feedPanel, strip: data ? latestPlayHtml(data) : '',
    gameStrip: state.scores.sport === box.sport
      ? otherGamesHtml(state.scores.data?.games, box.id, { pins: state.pins, legCounts: openLegCounts() }) : '',
  });

  for (const n of view.querySelectorAll('[data-scroll-key]')) {
    const left = lefts.get(n.dataset.scrollKey);
    if (left) n.scrollLeft = left;
  }
  // First time the strip shows (or a different game was picked): bring the
  // open game into view; after that, leave the strip where you scrolled it.
  const gstrip = view.querySelector('.gstrip');
  const current = gstrip?.querySelector('.gs-chip.on');
  if (current && (!lefts.has('gstrip') || box.stripFor !== box.id)) {
    gstrip.scrollLeft = current.offsetLeft - (gstrip.clientWidth - current.offsetWidth) / 2;
    box.stripFor = box.id;
  }
  view.scrollTop = top;
  const col = view.querySelector('.col-feed');
  if (col) col.scrollTop = colTop;
  restoreAnchor(wide ? col : view, anchor);
}

// What a settled bet made or lost. A won parlay with a void leg pays its
// re-priced amount, frozen at settlement; a void or push bet returns the stake.
// Null when the re-price had no odds to work from and nobody has entered it.
function settledProfit(bet) {
  const stake = Number(bet.stake) || 0;
  const { status, payout, legs } = bet.result;
  if (status === 'lost') return -stake;
  if (status !== 'won') return 0;
  // Bets settled before re-pricing existed have no frozen payout.
  const paid = payout !== undefined ? payout : payoutFor(bet, legs);
  return paid == null ? null : Math.round((paid - stake) * 100) / 100;
}

function renderHistory() {
  const view = $('#view');
  const done = state.bets.filter((b) => b.result).sort((a, b) => b.result.at - a.result.at);
  const won = done.filter((b) => b.result.status === 'won');
  const lost = done.filter((b) => b.result.status === 'lost');
  const profit = done.reduce((acc, b) => acc + (settledProfit(b) || 0), 0);
  const unpriced = done.filter((b) => settledProfit(b) == null).length;

  const rows = done.map((b) => {
    const delta = settledProfit(b);
    const voids = (b.result.legs || []).filter((l) => l.status === 'void').length;
    let amount;
    if (delta == null) amount = `<span class="amt"><button class="btn sm ghost" data-set-payout="${b.id}">Set payout</button></span>`;
    else if (['void', 'push'].includes(b.result.status)) amount = `<span class="amt muted">${b.result.status === 'void' ? 'Void' : 'Push'}</span>`;
    else amount = `<span class="amt ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : ''}">${delta >= 0 ? '+' : '−'}${money(Math.abs(delta)).slice(1)}</span>`;
    return `<div class="hist-row">
      <span class="book ${esc((b.book || '').toLowerCase().replace(/\s/g, ''))}">${esc(b.book || 'Bet')}</span>
      <div>
        <div style="font-size:13.5px">${b.legs.length > 1 ? `${b.legs.length}-leg parlay` : 'Straight'}</div>
        <div class="bet-sub">${b.legs.map((l) => esc(l.playerName || l.teamAbbr || '')).filter(Boolean).slice(0, 3).join(', ')}${b.legs.length > 3 ? '…' : ''}${voids ? ` &middot; ${voids} void` : ''}</div>
      </div>
      ${amount}
      <button class="icon-btn" data-del="${b.id}">&times;</button>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="summary">
      <div class="sum-card"><div class="k">Record</div><div class="v">${won.length}-${lost.length}</div></div>
      <div class="sum-card"><div class="k">Settled</div><div class="v">${done.length}</div></div>
      <div class="sum-card"><div class="k">Profit</div><div class="v ${profit >= 0 ? 'pos' : 'neg'}">${profit >= 0 ? '+' : '−'}${money(Math.abs(profit)).slice(1)}</div></div>
    </div>
    ${unpriced ? `<div class="note">${unpriced} won bet${unpriced > 1 ? 's' : ''} left out of profit: a voided leg had no odds to re-price from. Tap Set payout and enter what the book paid.</div>` : ''}
    ${done.length ? `<div class="panel">${rows}</div>` : '<div class="empty"><div class="big">&#9776;</div><div>Nothing settled yet.</div></div>'}`;
}

// ---------------------------------------------------------------- add tab

function searchSlate(query) {
  const slate = state.slate;
  if (!slate) return { players: [], games: [] };
  const q = query.trim().toLowerCase();
  if (!q) return { players: [], games: slate.games };
  const players = slate.players
    .filter((p) => (p.name || '').toLowerCase().includes(q) || (p.teamAbbr || '').toLowerCase() === q)
    .slice(0, 25);
  const games = slate.games.filter((g) =>
    [g.name, g.home.name, g.away.name, g.home.abbr, g.away.abbr]
      .some((field) => (field || '').toLowerCase().includes(q))
  );
  return { players, games };
}

function renderPickerResults() {
  const box = $('#picker-results');
  if (!box) return;
  const { players, games } = searchSlate(state.picker.query);
  const rows = [];
  for (const p of players) {
    rows.push(`<div class="result" data-pick-player="${p.id}">
      <div><div class="nm">${esc(p.name)}</div><div class="mt">${esc(p.teamAbbr)} &middot; ${esc(p.pos || '')} &middot; ${p.sport.toUpperCase()}</div></div>
      <span class="go">&rsaquo;</span></div>`);
  }
  for (const g of games.slice(0, 12)) {
    rows.push(`<div class="result" data-pick-game="${g.id}">
      <div><div class="nm">${esc(g.name)}</div><div class="mt">Game lines &middot; ${g.sport.toUpperCase()} &middot; ${esc(g.statusDetail)}</div></div>
      <span class="go">&rsaquo;</span></div>`);
  }
  box.innerHTML = rows.join('') || '<div class="result"><div class="mt">No match on today’s slate.</div></div>';
}

function pickerDetailHtml() {
  const p = state.picker;
  if (!p.pick) return '';
  const sport = p.pick.sport;
  const isPlayer = p.pick.type === 'player';
  const groups = marketGroups(sport, isPlayer ? 'player' : 'game');
  let chips = '';
  for (const [group, markets] of groups) {
    chips += `<div class="chip-group-label">${esc(group)}</div><div class="chips">`;
    chips += markets.map((m) => `<button class="chip ${p.market === m.key ? 'sel' : ''}" data-market="${m.key}">${esc(m.label)}</button>`).join('');
    chips += '</div>';
  }

  const market = p.market ? MARKETS[p.market] : null;
  const needsTeam = market && (market.margin || p.market?.endsWith('team_total'));
  const g = isPlayer ? null : state.slate.games.find((x) => x.id === p.pick.eventId);
  const teamChips = needsTeam && g
    ? `<div class="chip-group-label">Team</div><div class="chips">
        ${[g.away, g.home].map((t) => `<button class="chip ${p.teamAbbr === t.abbr ? 'sel' : ''}" data-team="${esc(t.abbr)}">${esc(t.abbr)}</button>`).join('')}
      </div>` : '';

  const hideSide = market?.margin;
  return `
    <div class="panel">
      <h3>${esc(p.pick.label)}</h3>
      ${chips}
      ${teamChips}
      ${market ? `
        <div class="row" style="margin-top:12px">
          <div><label>Line</label><input id="in-line" type="text" inputmode="decimal" value="${esc(p.line)}" placeholder="${market.defaultLine ?? '19.5'}"></div>
          ${hideSide ? '' : `<div><label>Side</label><select id="in-side">
            <option value="over"${p.side === 'over' ? ' selected' : ''}>Over</option>
            <option value="under"${p.side === 'under' ? ' selected' : ''}>Under</option>
          </select></div>`}
          <div><label>Odds</label><input id="in-odds" type="text" inputmode="text" value="${esc(p.odds)}" placeholder="-110"></div>
        </div>
        <button class="btn" id="btn-add-leg" style="margin-top:12px">Add leg</button>` : '<div class="note">Pick a market above.</div>'}
    </div>`;
}

function renderAdd() {
  const view = $('#view');
  const d = state.draft;
  const legRows = d.legs.map((leg) => `<div class="pending-leg">
      <span>${esc(leg.playerName || leg.teamAbbr || '')}</span>
      <span class="mt" style="color:var(--dim)">${legSubtitle(leg, {})}</span>
      <button class="x" data-rm-leg="${leg.id}">&times;</button>
    </div>`).join('');

  // Import leads: pasting a screenshot-derived parlay is the common path, and
  // building one leg at a time is the fallback.
  view.innerHTML = `
    <div class="panel">
      <h3>Import from screenshots</h3>
      <div class="note">Copy the prompt, start a Claude chat, attach your bet-slip screenshots, and paste the JSON it returns below. Handles several screenshots, several books, and several parlays at once.</div>
      <button class="btn" id="btn-copy-prompt" style="margin-top:10px">Copy import prompt</button>
      <textarea id="in-import" placeholder='[{"book":"FanDuel","stake":10,"americanOdds":650,"legs":[...]}]' style="margin-top:10px"></textarea>
      <button class="btn ghost" id="btn-import" style="margin-top:8px">Import JSON</button>
      <div id="import-msg"></div>
    </div>

    <div class="or-divider"><span>or build one by hand</span></div>

    <div class="panel">
      <h3>Add a leg</h3>
      <input id="in-search" type="search" placeholder="Search player or game on today's slate" value="${esc(state.picker.query)}" autocomplete="off">
      <div class="results" id="picker-results"></div>
    </div>
    ${pickerDetailHtml()}

    <div class="panel">
      <h3>Bet details</h3>
      <div class="row">
        <div><label>Book</label><select id="in-book">${BOOKS.map((b) => `<option${d.book === b ? ' selected' : ''}>${b}</option>`).join('')}</select></div>
        <div><label>Stake ($)</label><input id="in-stake" type="text" inputmode="decimal" value="${esc(d.stake)}" placeholder="10"></div>
      </div>
      <div class="row" style="margin-top:9px">
        <div><label>Total odds</label><input id="in-totodds" type="text" value="${esc(d.odds)}" placeholder="+650"></div>
        <div><label>Payout ($, optional)</label><input id="in-payout" type="text" inputmode="decimal" value="${esc(d.payout)}" placeholder="auto"></div>
      </div>
      <div class="note">Leave odds blank to compute the parlay price from the leg odds.</div>
      ${d.legs.length ? `<div class="pending-legs">${legRows}</div>
        <button class="btn" id="btn-save-bet" style="margin-top:10px">Save bet (${d.legs.length} leg${d.legs.length > 1 ? 's' : ''})</button>`
        : '<div class="note" style="margin-top:8px">Add a leg above, then save.</div>'}
    </div>`;

  renderPickerResults();
}

function renderSettings() {
  const info = sync.info();
  $('#view').innerHTML = `
    <div class="panel">
      <h3>Sync across devices</h3>
      ${info.configured ? `
        <div class="note">Your sync code pairs this device with your phone. Open the app there, hit the gear, and enter this code.</div>
        <div class="row" style="margin-top:10px"><input id="in-code" class="mono" value="${esc(info.code)}" readonly></div>
        <div class="row" style="margin-top:8px">
          <button class="btn ghost sm" id="btn-copy-code">Copy code</button>
          <button class="btn ghost sm" id="btn-set-code">Enter a different code</button>
        </div>
        <div class="note" style="margin-top:8px">Status: ${esc(info.status)}</div>
      ` : `<div class="note">Sync is not configured. Bets are stored on this device only.</div>`}
    </div>
    <div class="panel">
      <h3>Fantasy</h3>
      <div class="note">The key that unlocks your fantasy leagues (FANTASY_KEY in Vercel). It stays on this device and isn't synced. ${fantasyKey() ? 'A key is saved.' : 'No key saved yet.'}</div>
      <div class="row" style="margin-top:10px">
        <input id="in-fx-key" type="password" autocomplete="off" placeholder="${fantasyKey() ? 'Replace the saved key' : 'Fantasy key'}">
        <button class="btn sm" id="btn-fx-key" style="flex:none">Save</button>
      </div>
      ${fantasyKey() ? '<div class="row" style="margin-top:8px"><button class="btn ghost sm" id="btn-fx-forget" style="flex:none">Forget key</button></div>' : ''}
    </div>
    <div class="panel">
      <h3>Preferences</h3>
      <label style="display:flex;align-items:center;gap:9px;font-size:14px;color:var(--text)">
        <input type="checkbox" id="in-sound" style="width:auto" ${state.prefs.sound ? 'checked' : ''}> Sound when a leg hits or busts
      </label>
    </div>
    <div class="panel">
      <h3>Data</h3>
      <div class="note">${state.bets.length} bet${state.bets.length === 1 ? '' : 's'} stored on this device.</div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost sm" id="btn-export">Export JSON</button>
        <button class="btn danger sm" id="btn-clear">Clear all</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- import

function validateImport(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { error: `Not valid JSON: ${err.message}` }; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const bets = [];
  const warnings = [];

  list.forEach((item, bi) => {
    if (!item || typeof item !== 'object') { warnings.push(`Bet ${bi + 1}: not an object, skipped.`); return; }
    const legsIn = Array.isArray(item.legs) ? item.legs : [];
    if (!legsIn.length) { warnings.push(`Bet ${bi + 1}: no legs, skipped.`); return; }

    const legs = legsIn.map((l, li) => {
      const sport = (l.sport || '').toLowerCase() === 'nfl' ? 'nfl' : 'nba';
      const market = l.market === UNSUPPORTED ? null : resolveMarket(sport, l.market);
      if (!market && l.market !== UNSUPPORTED) {
        warnings.push(`Bet ${bi + 1} leg ${li + 1}: unknown market "${l.market}" — kept as a manual leg.`);
      }
      const matched = matchLeg(sport, l);
      if (!matched.eventId) warnings.push(`Bet ${bi + 1} leg ${li + 1}: no game today for "${l.playerName || l.teamAbbr || '?'}" — kept as a manual leg.`);
      return {
        id: uid(),
        sport,
        market: market && matched.eventId ? market.key : UNSUPPORTED,
        rawLabel: l.rawLabel || [l.playerName || l.teamAbbr, l.side, l.line, l.market].filter(Boolean).join(' '),
        line: Number(l.line ?? market?.defaultLine ?? 0),
        side: l.side === 'under' ? 'under' : 'over',
        playerId: matched.playerId || null,
        playerName: matched.playerName || l.playerName || '',
        teamAbbr: matched.teamAbbr || l.teamAbbr || '',
        eventId: matched.eventId || null,
        americanOdds: Number(l.americanOdds) || null,
      };
    });

    bets.push({
      id: uid(),
      book: item.book || 'Other',
      placedAt: Date.now(),
      stake: Number(item.stake) || 0,
      americanOdds: Number(item.americanOdds) || null,
      payout: Number(item.payout) || null,
      legs,
    });
  });

  if (!bets.length) return { error: warnings.join('\n') || 'Nothing importable found.' };
  return { bets, warnings };
}

/** Resolve a pasted leg to a real athlete + today's game. */
function matchLeg(sport, leg) {
  const slate = state.slate;
  if (!slate) return {};
  if (leg.playerName) {
    const want = String(leg.playerName).toLowerCase().replace(/[^a-z ]/g, '').trim();
    const pool = slate.players.filter((p) => p.sport === sport);
    const exact = pool.find((p) => p.name.toLowerCase().replace(/[^a-z ]/g, '') === want);
    const loose = exact || pool.find((p) => {
      const n = p.name.toLowerCase();
      const parts = want.split(' ');
      return parts.length > 1 ? n.includes(parts[parts.length - 1]) && n.startsWith(parts[0][0]) : n.includes(want);
    });
    if (loose) return { playerId: loose.id, playerName: loose.name, teamAbbr: loose.teamAbbr, eventId: loose.eventId };
    return {};
  }
  if (leg.teamAbbr) {
    const abbr = String(leg.teamAbbr).toUpperCase();
    const g = slate.games.find((x) => x.sport === sport && (x.home.abbr === abbr || x.away.abbr === abbr));
    if (g) return { teamAbbr: abbr, eventId: g.id };
  }
  return {};
}

// ---------------------------------------------------------------- events

function toast(msg) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(node._t);
  node._t = setTimeout(() => node.classList.remove('show'), 2600);
}

const TABS = ['live', 'games', 'fantasy', 'add', 'history', 'settings'];
const FEED_STEP = 80;     // plays per page of the feed

// A new game opens on the kind of tab you used last: the feed (REAL's default)
// or a team's box score.
const firstSide = () => (state.prefs.gameTab === 'box' ? 'away' : 'feed');

// Wide screens show the feed beside the box score instead of as a tab.
const wideMQ = window.matchMedia('(min-width: 1024px)');
wideMQ.addEventListener('change', () => { if (state.tab === 'game') renderBox(); });

function go(tab) {
  // Leaving a box score: remember where you were on it, and note that the
  // replaceState below overwrites its history entry.
  if (state.tab === 'game' && state.box) {
    state.box.scrollTop = $('#view').scrollTop;
    state.box.pushed = false;
  }
  state.tab = tab;
  if (tab === 'games') state.gamesView = 'list';
  if (tab === 'fantasy') enterFantasy();
  history.replaceState(null, '', `#${tab}`);
  render();
  startView();
}

// Fantasy sits under NFL, so the Scores switch above it goes back to NFL scores.
function enterFantasy() {
  state.gamesView = 'fantasy';
  if (state.scores.sport !== 'nfl') {
    state.scores = newScores('nfl');
    state.prefs.scoresSport = 'nfl';
    persist({ push: false });
  }
}

// The tab bar keeps your place: Games reopens the box score you left it on.
// Tapping Games while that box score is showing goes back to the scoreboard,
// the way re-tapping a tab works on iPhone.
function tapTab(tab) {
  if (tab !== 'games') return go(tab);
  if (state.tab === 'game') {
    state.gamesView = 'list';
    if (state.box?.pushed && state.box.from === 'games') return history.back();
    return go('games');
  }
  if (state.tab === 'fantasy') return go('games');
  if (state.gamesView === 'game' && state.box) return resumeBox();
  if (state.gamesView === 'fantasy') return go('fantasy');
  return go('games');
}

function openGame(sport, id, from) {
  const same = state.box?.id === id;
  // Switching games from the strip keeps where you came from: Back still goes
  // there, not to the previous game.
  const inPlace = state.tab === 'game' && state.box;
  if (inPlace) from = state.box.from;
  state.box = {
    sport, id, from, pushed: inPlace ? state.box.pushed : true, scrollTop: 0, error: null,
    data: same ? state.box.data : null, side: same ? state.box.side : firstSide(),
    limit: same ? state.box.limit : FEED_STEP,
  };
  state.tab = 'game';
  state.gamesView = 'game';
  history[inPlace ? 'replaceState' : 'pushState'](null, '', `#game/${sport}/${id}`);
  $('#view').scrollTop = 0;
  render();
  startView();
}

// Back to the box score the Games tab was left on: same game, same team tab,
// same scroll. It refetches straight away, since the data went stale meanwhile.
function resumeBox() {
  const box = state.box;
  box.from = 'games';
  state.tab = 'game';
  history.replaceState(null, '', `#game/${box.sport}/${box.id}`);
  render();
  $('#view').scrollTop = box.scrollTop || 0;
  startView();
}

// Leave a box score for wherever it was opened from. Pop its history entry
// when it still has one, so the laptop's back button stays in step; otherwise
// there is nothing safe to pop, so switch views directly.
function closeBox() {
  state.gamesView = 'list';
  if (state.box?.pushed) return history.back();
  go(state.box?.from === 'live' ? 'live' : 'games');
}

// Reads the hash: #games, #history, #game/nba/401909870 ...
function route() {
  const wasBox = state.tab === 'game';
  const m = location.hash.match(/^#game\/(nba|nfl)\/(\d+)$/);
  if (m) {
    const [, sport, id] = m;
    if (state.box?.id !== id) state.box = { sport, id, data: null, side: firstSide(), limit: FEED_STEP, from: null, error: null };
    state.tab = 'game';
    state.gamesView = 'game';
  } else {
    const tab = location.hash.slice(1);
    state.tab = TABS.includes(tab) ? tab : 'live';
    // The browser's back button away from a box score closes it, like Back.
    if (wasBox || state.tab === 'games') state.gamesView = 'list';
    if (state.tab === 'fantasy') enterFantasy();
  }
  // Reached by a reload or the browser's back/forward: what sits behind this
  // entry is unknown, so Back switches views rather than popping history.
  if (state.box) state.box.pushed = false;
  render();
  startView();
}

window.addEventListener('popstate', route);

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-tab],[data-goto],[data-del],[data-pick-player],[data-pick-game],[data-market],[data-team],[data-rm-leg],[data-manual],[data-open-game],[data-sport],[data-day],[data-week],[data-box-side],[data-back],[data-set-payout],[data-feed-more],[data-collapse],button');
  if (!t) return;

  if (t.dataset.tab) return tapTab(t.dataset.tab);
  if (t.dataset.goto) return go(t.dataset.goto);
  if (t.id === 'btn-settings') return go('settings');
  if (t.id === 'btn-refresh') { await Promise.all([poll(), refreshView()]); toast('Refreshed'); return; }

  // The pin sits inside a game tile, so it is checked before the tile opens.
  const pin = ev.target.closest('[data-pin]');
  if (pin) {
    const key = pin.dataset.pin;
    if (state.pins[key]) delete state.pins[key]; else state.pins[key] = Date.now();
    persist();
    renderGames();
    return;
  }
  if (t.dataset.openGame) {
    const [sport, id] = t.dataset.openGame.split(':');
    if (sport && id) openGame(sport, id, state.tab);
    return;
  }
  if (t.dataset.back !== undefined) return closeBox();
  if (t.dataset.setPayout) {
    const bet = state.bets.find((b) => b.id === t.dataset.setPayout);
    if (!bet?.result) return;
    const raw = prompt('A leg was voided and there were no odds to re-price from.\nWhat did the book pay back in total, stake included?');
    if (raw == null) return;
    const paid = Number(String(raw).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(paid) || paid < 0) { toast('Enter an amount like 42.50'); return; }
    bet.result.payout = Math.round(paid * 100) / 100;
    persist(); renderHistory();
    return;
  }
  if (t.dataset.boxSide) {
    state.box.side = t.dataset.boxSide;
    state.prefs.gameTab = t.dataset.boxSide === 'feed' ? 'feed' : 'box';
    persist({ push: false });
    renderBox();
    return;
  }
  if (t.dataset.feedMore !== undefined && state.box) {
    state.box.limit = (state.box.limit || FEED_STEP) + FEED_STEP;
    t.disabled = true; t.textContent = 'Loading…';
    await loadBoxScore();
    return;
  }
  if (t.dataset.sport) {
    const changed = t.dataset.sport !== state.scores.sport;
    if (changed) {
      state.scores = newScores(t.dataset.sport);
      state.prefs.scoresSport = t.dataset.sport;
      persist({ push: false });
    }
    if (state.tab !== 'games') { if (changed) go('games'); return; }
    if (changed) { renderGames(); startView(); }
    return;
  }
  if (t.dataset.fxLeague) {
    state.prefs.fxLeague = t.dataset.fxLeague;
    persist({ push: false });
    renderFantasy();
    return;
  }
  if (t.dataset.fxBench !== undefined) { state.fx.bench = !state.fx.bench; renderFantasy(); return; }
  if (t.id === 'btn-fx-key') return saveFantasyKey();
  if (t.id === 'btn-fx-forget') {
    try { localStorage.removeItem(FX_KEY); } catch { /* private mode */ }
    Object.assign(state.fx, { data: null, status: null, message: '' });
    renderSettings(); toast('Fantasy key removed');
    return;
  }
  if (t.dataset.day) {
    Object.assign(state.scores, { date: t.dataset.day, data: null, error: null });
    renderGames(); startView(); return;
  }
  if (t.dataset.week) {
    Object.assign(state.scores, { week: Number(t.dataset.week), data: null, error: null });
    renderGames(); startView(); return;
  }

  if (t.dataset.collapse) {
    const c = (state.prefs.collapsed ||= {});
    if (c[t.dataset.collapse]) delete c[t.dataset.collapse]; else c[t.dataset.collapse] = true;
    persist({ push: false });
    renderLive();
    return;
  }
  if (t.dataset.del) {
    const bet = state.bets.find((b) => b.id === t.dataset.del);
    if (bet && confirm('Delete this bet?')) {
      state.bets = state.bets.filter((b) => b.id !== t.dataset.del);
      persist(); render();
    }
    return;
  }

  if (t.dataset.manual) {
    const leg = state.bets.flatMap((b) => b.legs).find((l) => l.id === t.dataset.leg);
    if (leg) {
      leg.manualStatus = leg.manualStatus === t.dataset.manual ? null : t.dataset.manual;
      settleFinished(); persist(); renderLive();
    }
    return;
  }

  if (t.dataset.pickPlayer) {
    const p = state.slate.players.find((x) => x.id === t.dataset.pickPlayer);
    state.picker = { ...newPicker(), query: state.picker.query, pick: { type: 'player', ...p, label: `${p.name} · ${p.teamAbbr}` } };
    renderAdd(); return;
  }
  if (t.dataset.pickGame) {
    const g = state.slate.games.find((x) => x.id === t.dataset.pickGame);
    state.picker = { ...newPicker(), query: state.picker.query, pick: { type: 'game', sport: g.sport, eventId: g.id, label: g.name } };
    renderAdd(); return;
  }
  if (t.dataset.market) { state.picker.market = t.dataset.market; captureLegInputs(); renderAdd(); return; }
  if (t.dataset.team) { state.picker.teamAbbr = t.dataset.team; captureLegInputs(); renderAdd(); return; }
  if (t.dataset.rmLeg) {
    state.draft.legs = state.draft.legs.filter((l) => l.id !== t.dataset.rmLeg);
    renderAdd(); return;
  }

  if (t.id === 'btn-add-leg') return addLeg();
  if (t.id === 'btn-save-bet') return saveBet();
  if (t.id === 'btn-copy-prompt') {
    await navigator.clipboard.writeText(IMPORT_PROMPT).catch(() => {});
    toast('Prompt copied — paste it into Claude with your screenshots');
    return;
  }
  if (t.id === 'btn-import') return doImport();
  if (t.id === 'btn-copy-code') { await navigator.clipboard.writeText(sync.info().code).catch(() => {}); toast('Sync code copied'); return; }
  if (t.id === 'btn-set-code') {
    const code = prompt('Enter the sync code from your other device:');
    if (code) { sync.setCode(code.trim()); toast('Pairing…'); }
    return;
  }
  if (t.id === 'btn-export') {
    await navigator.clipboard.writeText(JSON.stringify(state.bets, null, 2)).catch(() => {});
    toast('Bets copied to clipboard'); return;
  }
  if (t.id === 'btn-clear') {
    if (confirm('Delete every bet on this device?')) { state.bets = []; persist(); render(); }
    return;
  }
});

function saveFantasyKey() {
  const key = $('#in-fx-key')?.value.trim();
  if (!key) return toast('Enter the key first');
  try { localStorage.setItem(FX_KEY, key); } catch { return toast("This browser won't store the key"); }
  Object.assign(state.fx, { data: null, status: null, message: '' });
  if (state.tab === 'fantasy') { renderFantasy(); startView(); } else { renderSettings(); toast('Fantasy key saved'); }
}

function captureLegInputs() {
  const line = $('#in-line'); const side = $('#in-side'); const odds = $('#in-odds');
  if (line) state.picker.line = line.value;
  if (side) state.picker.side = side.value;
  if (odds) state.picker.odds = odds.value;
}

function addLeg() {
  captureLegInputs();
  const p = state.picker;
  const market = MARKETS[p.market];
  if (!market) return toast('Pick a market first');
  const needsTeam = market.margin || p.market.endsWith('team_total');
  if (needsTeam && !p.teamAbbr) return toast('Pick which team');

  const line = p.line === '' ? market.defaultLine ?? null : Number(p.line);
  if (line == null || Number.isNaN(line)) return toast('Enter a line');

  state.draft.legs.push({
    id: uid(),
    sport: p.pick.sport,
    market: p.market,
    line,
    side: market.margin ? 'over' : p.side,
    playerId: p.pick.type === 'player' ? p.pick.id : null,
    playerName: p.pick.type === 'player' ? p.pick.name : '',
    teamAbbr: needsTeam ? p.teamAbbr : (p.pick.teamAbbr || ''),
    eventId: p.pick.eventId,
    americanOdds: p.odds ? Number(String(p.odds).replace('+', '')) : null,
  });
  state.picker = newPicker();
  renderAdd();
  toast('Leg added');
}

function captureBetInputs() {
  const d = state.draft;
  const book = $('#in-book'); const stake = $('#in-stake'); const odds = $('#in-totodds'); const payout = $('#in-payout');
  if (book) d.book = book.value;
  if (stake) d.stake = stake.value;
  if (odds) d.odds = odds.value;
  if (payout) d.payout = payout.value;
}

function saveBet() {
  captureBetInputs();
  const d = state.draft;
  if (!d.legs.length) return toast('Add at least one leg');
  state.prefs.book = d.book;
  state.bets.unshift({
    id: uid(),
    book: d.book,
    placedAt: Date.now(),
    stake: Number(d.stake) || 0,
    americanOdds: d.odds ? Number(String(d.odds).replace('+', '')) : null,
    payout: Number(d.payout) || null,
    legs: d.legs,
  });
  state.draft = newDraft(state.prefs.book);
  persist();
  go('live');
  poll();
  toast('Bet added');
}

function doImport() {
  const raw = $('#in-import').value.trim();
  const msg = $('#import-msg');
  if (!raw) { msg.innerHTML = '<div class="err">Paste the JSON first.</div>'; return; }
  const { bets, warnings, error } = validateImport(raw);
  if (error) { msg.innerHTML = `<div class="err">${esc(error)}</div>`; return; }
  state.bets.unshift(...bets);
  persist();
  const warn = warnings?.length ? `<div class="err">${esc(warnings.join('\n'))}</div>` : '';
  msg.innerHTML = `<div class="ok">Imported ${bets.length} bet${bets.length > 1 ? 's' : ''}.</div>${warn}`;
  poll();
  setTimeout(() => go('live'), warnings?.length ? 2500 : 600);
}

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'in-search') { state.picker.query = ev.target.value; renderPickerResults(); }
  if (ev.target.id === 'in-sound') { state.prefs.sound = ev.target.checked; persist({ push: false }); }
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'fx-week') {
    Object.assign(state.fx, { week: Number(ev.target.value), data: null, prev: new Map() });
    renderFantasy(); startView();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'in-fx-key') saveFantasyKey();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(viewTimer); return; }
  poll(); scheduleNextPoll(); startView();
});

// ---------------------------------------------------------------- boot

(async function boot() {
  route();
  sync.start();
  await loadSlate();
  await poll();
  scheduleNextPoll();
  if (state.tab === 'add') renderAdd();
})();
