// GET /api/box?sport=nba&id=401909870[&limit=80]
//
// One game's full box score plus its play-by-play feed (the newest `limit`
// plays), trimmed from ESPN's ~500KB summary down to what the game view draws.
import { SPORTS, loadBox } from './_espn.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const sport = url.searchParams.get('sport');
  const id = url.searchParams.get('id');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!SPORTS[sport] || !/^\d+$/.test(id || '')) {
    return res.status(400).json({ error: 'Need a sport (nba or nfl) and a numeric game id' });
  }

  const limit = Math.min(1000, Math.max(1, Math.floor(Number(url.searchParams.get('limit'))) || 80));
  let box;
  try {
    box = await loadBox(sport, id, limit);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String(err?.message || err) });
  }

  // Live box scores churn every few seconds. A final one only changes if ESPN
  // corrects a stat, and a pre-game one only once it tips off.
  res.setHeader('Cache-Control', box.state === 'in'
    ? 'public, s-maxage=5, stale-while-revalidate=10'
    : box.state === 'post' ? 'public, s-maxage=3600, stale-while-revalidate=86400'
      : 'public, s-maxage=60, stale-while-revalidate=60');
  res.status(200).json({ fetchedAt: Date.now(), ...box });
}
