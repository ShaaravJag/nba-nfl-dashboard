// Play-by-play feed for the game view. NBA plays are replayed in order into
// each player's running stat line, streaks and the team situation, so every
// card can say what the play meant at the time ("1/8 FG", "6-straight missed
// FG", "15th team turnover"). The replay reproduces ESPN's final box score to
// the stat (scripts/test-feed.mjs). NFL comes drive by drive, Gamecast-style:
// its plays carry no structured participants to count. Underscore prefix
// keeps Vercel from routing this file.
import { SNAP_KEYS } from '../public/feed.js';

const toNum = (raw) => {
  const n = Number(String(raw ?? '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n) => Math.round(n * 10) / 10;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ESPN's resizer serves a 96px headshot for ~8KB; the full image is ~200KB.
function headshot(href) {
  if (!href) return null;
  try {
    return `https://a.espncdn.com/combiner/i?img=${new URL(href).pathname}&w=96&h=70&cb=1`;
  } catch {
    return null;
  }
}

// Home win probability after each play, as a percentage. ESPN's list is not
// in play order (its last entry can belong to a play well before the end), so
// it's looked up by play id and walked in play order.
function winProbabilities(summary) {
  return new Map((summary?.winprobability || []).map((w) => [String(w.playId), toNum(w.homeWinPercentage) * 100]));
}

function teamsOf(summary) {
  const teams = {};
  for (const c of summary?.header?.competitions?.[0]?.competitors || []) {
    teams[String(c.team?.id)] = { abbr: c.team?.abbreviation || '', side: c.homeAway };
  }
  return teams;
}

// --- NBA ------------------------------------------------------------------

const blank = () => Object.fromEntries(SNAP_KEYS.map((k) => [k, 0]));
const doubleDigits = (s) => [s.pts, s.reb, s.ast, s.stl, s.blk].filter((v) => v >= 10).length;

// "Pullup Jump Shot" -> "pull-up jumper", "Driving Layup Shot" -> "driving layup".
function shotName(type, three, corner) {
  const t = type.toLowerCase();
  if (three) {
    if (corner) return 'corner three';
    if (t.includes('heave')) return 'heave';
    if (t.includes('step back')) return 'step-back three';
    if (t.includes('pullup')) return 'pull-up three';
    if (t.includes('fade')) return 'fadeaway three';
    return 'three';
  }
  return t.replace(/\bshot\b/g, '').replace('pullup', 'pull-up').replace('step back', 'step-back')
    .replace('fade away', 'fadeaway').replace('alley oop', 'alley-oop').replace(/\s+/g, ' ').trim()
    .replace(/jump$/, 'jumper').replace(/jump bank$/, 'bank shot');
}

// The corner three is the short one along the sideline. ESPN marks a missing
// coordinate with a huge negative sentinel, so anything off the court is ignored.
function isCorner(c) {
  const x = Number(c?.x);
  const y = Number(c?.y);
  if (!(x >= -5 && x <= 55 && y >= -5 && y <= 50)) return false;
  return Math.abs(x - 25) >= 21 && y <= 14;
}

const MILESTONES = { pts: [10, 20, 30, 40, 50, 60], reb: [10, 15, 20], ast: [10, 15, 20] };
const STAT_WORD = { pts: 'pts', reb: 'reb', ast: 'ast' };

/** NBA feed items, oldest first. */
export function nbaFeed(summary) {
  const teams = teamsOf(summary);
  const wps = winProbabilities(summary);

  const players = {};
  for (const block of summary?.boxscore?.players || []) {
    const abbr = block.team?.abbreviation || '';
    for (const group of block.statistics || []) {
      for (const entry of group.athletes || []) {
        const a = entry.athlete || {};
        if (a.id == null) continue;
        players[String(a.id)] = { name: a.shortName || a.displayName || '', team: abbr, headshot: headshot(a.headshot?.href) };
      }
    }
  }

  const stats = {};
  const stat = (id) => stats[id] || (stats[id] = blank());
  const streaks = {};
  const streak = (id) => streaks[id] || (streaks[id] = { miss: 0, make: 0, miss3: 0, make3: 0 });
  const teamTo = { home: 0, away: 0 };
  const teamFouls = { home: 0, away: 0 };
  let foulPeriod = 0;
  let leader = null;          // last team in front, ignoring ties
  let largestLead = 0;
  let run = { side: null, pts: 0 };
  let prevWp = null;
  let carried = 0;            // swing from plays the feed drops or merges, owed to the next card
  const items = [];
  const plays = summary?.plays || [];

  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const type = String(p.type?.text || '').replace(/\s+/g, ' ').trim();
    const t = type.toLowerCase();
    const text = String(p.text || '').replace(/\s+/g, ' ').trim();
    const [aId, bId] = (p.participants || []).map((x) => (x.athlete?.id != null ? String(x.athlete.id) : null));
    const team = teams[String(p.team?.id)] || {};
    const q = toNum(p.period?.number);
    if (q !== foulPeriod) { foulPeriod = q; teamFouls.home = 0; teamFouls.away = 0; }

    const wpRaw = wps.get(String(p.id));
    const delta = wpRaw != null && prevWp != null ? wpRaw - prevWp : 0;
    if (wpRaw != null) prevWp = wpRaw;
    carried += delta;
    const base = {
      id: String(p.id), q, clock: p.clock?.displayValue || '', away: toNum(p.awayScore), home: toNum(p.homeScore),
      team: team.abbr || '', side: team.side || null, wp: wpRaw != null ? round1(wpRaw) : null,
    };
    // Every new card collects the swing owed to it; a skipped or merged play leaves its share for the next one.
    const emit = (item) => { items.push({ ...base, swing: round1(carried), ...item }); carried = 0; };

    const before = {};
    const remember = (id) => { if (id && !before[id]) before[id] = { ...stat(id), dd: doubleDigits(stat(id)) }; };
    remember(aId); remember(bId);
    const notes = [];
    const snapOf = (...ids) => Object.fromEntries(ids.filter(Boolean).map((id) => [id, SNAP_KEYS.map((k) => stat(id)[k])]));

    // A player's milestones on this play: 10/20/30 points, a double-double.
    // The card already names its main player; a secondary one is named.
    const milestones = (id, named = false) => {
      if (!id || !before[id]) return;
      const now = stat(id);
      const who = named && players[id] ? `${players[id].name}: ` : '';
      const dd = doubleDigits(now);
      // A double-double says more than the "reaches 10" that completed it.
      const ddNote = before[id].dd < 3 && dd >= 3 ? 'triple-double' : before[id].dd < 2 && dd >= 2 ? 'double-double' : null;
      for (const [key, marks] of Object.entries(MILESTONES)) {
        const hit = marks.filter((m) => before[id][key] < m && now[key] >= m).pop();
        if (hit && !(ddNote && hit === 10)) notes.push({ rank: 0, text: `${who ? `${who}reaches` : 'Reaches'} ${hit} ${STAT_WORD[key]}` });
      }
      if (ddNote) notes.push({ rank: 0, text: who ? `${who}${ddNote}` : ddNote.charAt(0).toUpperCase() + ddNote.slice(1) });
    };

    // What a basket did to the game: lead changes, ties, runs, biggest lead.
    const scored = (points) => {
      const lead = base.home > base.away ? 'home' : base.away > base.home ? 'away' : null;
      if (!lead && base.home > 0) notes.push({ rank: 3, text: 'Ties it' });
      else if (lead && leader && lead !== leader) notes.push({ rank: 3, text: 'Takes the lead' });
      if (lead) leader = lead;
      run = run.side === team.side ? { side: run.side, pts: run.pts + points } : { side: team.side, pts: points };
      if (run.pts >= 7) notes.push({ rank: 4, text: `${team.abbr} on a ${run.pts}-0 run` });
      const margin = Math.abs(base.home - base.away);
      if (margin >= 10 && margin > largestLead && Math.floor(margin / 5) > Math.floor(largestLead / 5)) {
        notes.push({ rank: 5, text: `Largest lead (${margin})` });
      }
      largestLead = Math.max(largestLead, margin);
    };

    const push = (item) => emit({ ...item, notes: notes.sort((x, y) => x.rank - y.rank).slice(0, 2).map((n) => n.text) });

    // Substitutions: a whole swap at one clock is one row.
    if (String(p.type?.id) === '584') {
      const last = items[items.length - 1];
      const swap = { in: aId, out: bId };
      if (last?.kind === 'sub' && last.team === base.team && last.q === q && last.clock === base.clock) last.subs.push(swap);
      else emit({ kind: 'sub', subs: [swap], notes: [] });
      continue;
    }

    if (/^end (of )?(period|game)$/.test(t)) {
      emit({ kind: 'period', title: text || type, notes: [] });
      continue;
    }

    if (t.startsWith('free throw')) {
      if (!aId) continue;
      const s = stat(aId);
      const made = !!p.scoringPlay;
      s.fta++;
      if (made) { s.ftm++; s.pts += toNum(p.scoreValue); }
      const which = type.replace(/^free throw\s*-?\s*/i, '').toLowerCase();
      const label = !which ? '' : /^\d+ of \d+$/.test(which) ? ` ${which}` : ` (${which})`;
      milestones(aId);
      if (made) scored(toNum(p.scoreValue));
      push({ kind: 'ft', title: `${made ? 'Made' : 'Missed'} free throw${label}`,
        a: { id: aId, line: `${s.pts} pts · ${s.ftm}/${s.fta} FT` }, snap: snapOf(aId) });
      continue;
    }

    if (p.shootingPlay && aId) {
      const s = stat(aId);
      const k = streak(aId);
      const made = !!p.scoringPlay;
      const three = toNum(p.pointsAttempted) === 3;
      const blocked = !made && !!bId && text.toLowerCase().includes('block');
      // A missed end-of-quarter heave is not a field goal attempt.
      const counted = made || !t.includes('heave');
      const drought = k.miss;
      if (counted) {
        s.fga++;
        if (three) s.fg3a++;
        if (made) {
          s.fgm++; s.pts += toNum(p.scoreValue);
          if (three) s.fg3m++;
          if (bId) stat(bId).ast++;
        } else if (blocked) {
          stat(bId).blk++;
        }
        if (made) { k.make++; k.miss = 0; } else { k.miss++; k.make = 0; }
        if (three) { if (made) { k.make3++; k.miss3 = 0; } else { k.miss3++; k.make3 = 0; } }
        if (!made && k.miss >= 4) notes.push({ rank: 2, text: `${k.miss}-straight missed FG` });
        if (!made && three && k.miss3 >= 4) notes.push({ rank: 2, text: `${k.miss3}-straight missed threes` });
        if (made && three && k.make3 >= 3) notes.push({ rank: 2, text: `${k.make3} straight threes` });
        else if (made && k.make >= 4) notes.push({ rank: 2, text: `${k.make} straight makes` });
        if (made && drought >= 5) notes.push({ rank: 2, text: `Ends ${drought}-shot drought` });
      }
      milestones(aId); milestones(bId, true);
      if (made) scored(toNum(p.scoreValue));
      const dist = text.match(/(\d+)-foot/)?.[1];
      const verb = made ? 'Made' : blocked ? 'Blocked' : 'Missed';
      const line = made
        ? `${s.pts} pts · ${three ? `${s.fg3m}/${s.fg3a} 3PT` : `${s.fgm}/${s.fga} FG`}`
        : `${s.fgm}/${s.fga} FG${three ? ` · ${s.fg3m}/${s.fg3a} 3PT` : ''}`;
      const b = made && bId ? { id: bId, line: `${stat(bId).ast} ast`, role: 'ast' }
        : blocked ? { id: bId, line: `${stat(bId).blk} blk`, role: 'blk' } : null;
      push({ kind: 'shot', made, title: `${verb} ${dist ? `${dist}' ` : ''}${shotName(type, three, isCorner(p.coordinate))}`,
        a: { id: aId, line }, b, snap: snapOf(aId, b?.id) });
      continue;
    }

    if (t === 'offensive rebound' || t === 'defensive rebound') {
      if (!aId) continue;                        // team rebounds are noise
      const s = stat(aId);
      if (t.startsWith('offensive')) s.oreb++; else s.dreb++;
      s.reb++;
      milestones(aId);
      push({ kind: 'reb', title: t === 'offensive rebound' ? 'Offensive rebound' : 'Defensive rebound',
        a: { id: aId, line: `${s.reb} reb` }, snap: snapOf(aId) });
      continue;
    }

    if (t.includes('turnover') || t === 'traveling') {
      if (team.side) {
        teamTo[team.side]++;
        const n = teamTo[team.side];
        if (n >= 10 && n % 5 === 0) notes.push({ rank: 6, text: `${ordinal(n)} team turnover` });
      }
      const what = t.replace(/\s*turnover$/, '').replace(/^out of bounds - /, 'out of bounds, ').trim() || 'turnover';
      if (!aId) { push({ kind: 'to', title: `Turnover — ${what}` }); continue; }
      const s = stat(aId);
      s.to++;
      const steal = bId && text.toLowerCase().includes('steal');
      if (steal) { stat(bId).stl++; milestones(bId, true); }
      // An offensive foul arrives as a foul then this turnover; it shows once, here.
      const fouled = plays[i - 1] && /^offensive (foul|charge)$/i.test(plays[i - 1].type?.text || '')
        && String(plays[i - 1].participants?.[0]?.athlete?.id) === aId;
      push({ kind: 'to', title: `Turnover — ${what}`,
        a: { id: aId, line: `${s.to} to${fouled ? ` · ${s.pf} pf` : ''}` },
        b: steal ? { id: bId, line: `${stat(bId).stl} stl`, role: 'stl' } : null, snap: snapOf(aId, steal ? bId : null) });
      continue;
    }

    if ((t.includes('foul') || t.includes('charge')) && aId) {
      const s = stat(aId);
      const technical = t.includes('technical');
      const offensive = t.includes('offensive') || t.includes('charge');
      if (!technical) s.pf++;
      if (s.pf === 6 && !technical) notes.push({ rank: 1, text: 'Fouled out' });
      else if (s.pf === 5 && !technical) notes.push({ rank: 1, text: '5th foul' });
      // Offensive and technical fouls don't count toward the team's bonus.
      if (!technical && !offensive && team.side) {
        teamFouls[team.side]++;
        const other = Object.values(teams).find((x) => x.side !== team.side);
        if (teamFouls[team.side] === 5 && other) notes.push({ rank: 1, text: `${other.abbr} in the bonus` });
      }
      const next = plays[i + 1];
      const folds = offensive && next && /turnover/i.test(next.type?.text || '')
        && String(next.participants?.[0]?.athlete?.id) === aId;
      if (folds) continue;
      push({ kind: 'foul', title: type.charAt(0) + type.slice(1).toLowerCase(),
        a: { id: aId, line: technical ? 'technical' : `${s.pf} pf` }, snap: snapOf(aId) });
      continue;
    }

    // Timeouts, jump balls, reviews, violations: the play's own words.
    if (text) push({ kind: 'misc', title: text });
  }

  return { items, players, totals: stats, winProb: prevWp != null ? round1(prevWp) : null };
}

// --- NFL ------------------------------------------------------------------

/** NFL drives, oldest first, each with its plays oldest first. */
export function nflFeed(summary) {
  const teams = teamsOf(summary);
  const wps = winProbabilities(summary);
  // The live drive is also listed under `previous`; the `current` copy is the one to keep.
  const current = summary?.drives?.current;
  const list = (summary?.drives?.previous || []).filter((d) => !current || String(d.id) !== String(current.id))
    .map((d) => ({ d, current: false }));
  if (current) list.push({ d: current, current: true });

  let prevWp = null;
  const drives = [];
  for (const { d, current: live } of list) {
    const team = teams[String(d.team?.id)] || { abbr: d.team?.abbreviation || '' };
    const plays = (d.plays || []).map((p) => {
      const wpRaw = wps.get(String(p.id));
      const swing = wpRaw != null && prevWp != null ? round1(wpRaw - prevWp) : null;
      if (wpRaw != null) prevWp = wpRaw;
      const down = String(p.start?.shortDownDistanceText || '').trim();
      return {
        id: String(p.id), q: toNum(p.period?.number), clock: p.clock?.displayValue || '',
        down: down.startsWith('&') ? '' : down, at: p.start?.possessionText || '',
        type: p.type?.text || '', text: String(p.text || '').trim(), yds: toNum(p.statYardage),
        scoring: !!p.scoringPlay, turnover: !!p.isTurnover, penalty: !!p.isPenalty,
        away: toNum(p.awayScore), home: toNum(p.homeScore), wp: wpRaw != null ? round1(wpRaw) : null, swing,
      };
    });
    drives.push({
      id: String(d.id), team: team.abbr || d.team?.abbreviation || '', side: team.side || null,
      result: d.displayResult || d.result || '', desc: d.description || '', start: d.start?.text || '',
      score: !!d.isScore, current: live, plays,
    });
  }
  return { drives, winProb: prevWp != null ? round1(prevWp) : null };
}

/**
 * The feed as the box endpoint sends it: newest first, trimmed to `limit`
 * entries, with only the players those entries mention.
 */
export function buildFeed(sport, summary, limit = 80) {
  if (sport === 'nfl') {
    const { drives, winProb } = nflFeed(summary);
    const total = drives.reduce((n, d) => n + d.plays.length, 0);
    const out = [];
    let budget = limit;
    for (const d of drives.reverse()) {
      if (budget <= 0) break;
      out.push({ ...d, plays: d.plays.reverse().slice(0, budget) });
      budget -= d.plays.length;
    }
    return { sport, winProb, total, drives: out };
  }

  const { items, players, winProb } = nbaFeed(summary);
  const recent = items.reverse().slice(0, limit);
  const used = {};
  for (const item of recent) {
    for (const id of [item.a?.id, item.b?.id, ...(item.subs || []).flatMap((s) => [s.in, s.out])]) {
      if (id && players[id]) used[id] = players[id];
    }
  }
  return { sport, winProb, total: items.length, items: recent, players: used };
}
