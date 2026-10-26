// GET /api/live?nba=401909868,401909870&nfl=401873011
//
// Fans out to ESPN, trims ~50KB/game of box score down to ~2KB, and leans on
// Vercel's edge cache so every poll from every device collapses into one
// upstream fetch per 5s.
import { SPORTS, loadGame } from './_espn.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const wanted = [];
  for (const sport of Object.keys(SPORTS)) {
    const raw = url.searchParams.get(sport);
    if (!raw) continue;
    for (const id of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/^\d+$/.test(id)) wanted.push({ sport, id });
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!wanted.length) {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(200).json({ fetchedAt: Date.now(), games: {}, errors: [] });
  }
  if (wanted.length > 20) return res.status(400).json({ error: 'Too many games requested' });

  const results = await Promise.allSettled(wanted.map(({ sport, id }) => loadGame(sport, id)));

  const games = {};
  const errors = [];
  results.forEach((result, i) => {
    const { sport, id } = wanted[i];
    if (result.status === 'fulfilled') games[id] = result.value;
    else errors.push({ sport, id, message: String(result.reason?.message || result.reason) });
  });

  // Short edge cache, then serve stale while revalidating so a slow ESPN
  // response never stalls the UI. The stale window is also the worst case age
  // of the first poll after the app has been closed for a while, so keep it
  // tight: on a live tracker an old score is worse than a moment's wait.
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
  res.status(200).json({ fetchedAt: Date.now(), games, errors });
}
