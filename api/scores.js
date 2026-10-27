// GET /api/scores?sport=nba&date=YYYYMMDD
// GET /api/scores?sport=nfl&week=7
//
// One sport's scoreboard for the Games tab, trimmed from ESPN's 140-235KB to a
// few KB. NBA goes by day; NFL by week, since its games bunch up on Thursday,
// Sunday and Monday and most single days would be empty.
import { SPORTS, fetchJson, scoreboardUrl, weekUrl, normalizeScoreboard, sportsDay, weekInfo } from './_espn.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const sport = url.searchParams.get('sport') || 'nba';
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!SPORTS[sport]) return res.status(400).json({ error: 'Unknown sport' });

  const today = sportsDay();
  const week = Number(url.searchParams.get('week'));
  const rawDate = url.searchParams.get('date');
  const explicit = sport === 'nfl' ? Number.isInteger(week) && week > 0 : /^\d{8}$/.test(rawDate || '');
  const date = sport === 'nfl' ? null : explicit ? rawDate : today;

  let board;
  try {
    board = await fetchJson(sport === 'nfl'
      ? explicit ? weekUrl(sport, week, Number(url.searchParams.get('seasontype')) || 2) : scoreboardUrl(sport)
      : scoreboardUrl(sport, date));
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String(err?.message || err) });
  }

  const games = normalizeScoreboard(sport, board);

  // Live scores churn every few seconds. A board where everything is final only
  // changes if ESPN corrects something -- but only trust that for an explicit
  // day or week: the default "today" URL has to roll over at 6am.
  const live = games.some((g) => g.state === 'in');
  const settled = explicit && games.length > 0 && games.every((g) => g.state === 'post');
  res.setHeader('Cache-Control', live
    ? 'public, s-maxage=5, stale-while-revalidate=10'
    : settled ? 'public, s-maxage=3600, stale-while-revalidate=86400'
      : 'public, s-maxage=60, stale-while-revalidate=60');
  res.status(200).json({
    sport,
    today,
    date,
    week: sport === 'nfl' ? weekInfo(board) : null,
    fetchedAt: Date.now(),
    games,
  });
}
