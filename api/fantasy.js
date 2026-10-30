// GET /api/fantasy?week=8   (header x-fantasy-key: <FANTASY_KEY>)
//
// Your matchup in each of the three fantasy leagues. The site is public and the
// ESPN leagues are read with your ESPN login, so this needs the key, and the
// response is never cached at the edge, where it could be served to a request
// without one.
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadFantasy } from './_fantasy.js';

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function keyMatches(given, expected) {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const expected = process.env.FANTASY_KEY;
  if (!expected) return res.status(503).json({ error: 'setup', message: 'FANTASY_KEY isn\'t set on the server.' });
  if (!keyMatches(req.headers['x-fantasy-key'], expected)) return res.status(401).json({ error: 'key' });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const week = Number(url.searchParams.get('week'));
  try {
    res.status(200).json(await loadFantasy({ week: Number.isInteger(week) && week > 0 ? week : undefined }));
  } catch (err) {
    res.status(502).json({ error: 'upstream', message: String(err?.message || err) });
  }
}
