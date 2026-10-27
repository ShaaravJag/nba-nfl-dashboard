// GET /api/slate?date=YYYYMMDD
//
// Today's NBA + NFL games plus a searchable player index for the teams playing,
// which is everything the add-a-leg screen needs in one request.
import { SPORTS, fetchJson, scoreboardUrl, rosterUrl, normalizeScoreboard, sportsDay } from './_espn.js';

// NBA returns a flat athlete list; NFL nests them in position groups
// ({ position: 'offense', items: [...] }), so flatten before mapping.
const SKIP_GROUPS = new Set(['practiceSquad', 'suspended']);

function flattenAthletes(athletes) {
  const out = [];
  for (const entry of athletes || []) {
    if (Array.isArray(entry?.items)) {
      if (SKIP_GROUPS.has(entry.position)) continue;
      out.push(...entry.items);
    } else if (entry) {
      out.push(entry);
    }
  }
  return out;
}

async function rosterFor(sport, teamId) {
  try {
    const data = await fetchJson(rosterUrl(sport, teamId));
    return flattenAthletes(data.athletes)
      .filter((a) => a?.id && a?.displayName)
      .map((a) => ({
        id: String(a.id),
        name: a.displayName,
        pos: a.position?.abbreviation || '',
        jersey: a.jersey || '',
      }));
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const raw = url.searchParams.get('date');
  const date = /^\d{8}$/.test(raw || '') ? raw : sportsDay();

  res.setHeader('Access-Control-Allow-Origin', '*');

  const boards = await Promise.allSettled(
    Object.keys(SPORTS).map(async (sport) => ({
      sport,
      games: normalizeScoreboard(sport, await fetchJson(scoreboardUrl(sport, date))),
    }))
  );

  const games = [];
  for (const board of boards) if (board.status === 'fulfilled') games.push(...board.value.games);

  // Only pull rosters for teams actually playing today.
  const teams = new Map();
  for (const g of games) {
    for (const side of ['home', 'away']) {
      if (g[side].id) teams.set(`${g.sport}:${g[side].id}`, { sport: g.sport, id: g[side].id, abbr: g[side].abbr, eventId: g.id });
    }
  }

  const rosters = await Promise.all(
    [...teams.values()].map(async (t) => ({ ...t, players: await rosterFor(t.sport, t.id) }))
  );

  const players = [];
  for (const t of rosters) {
    for (const p of t.players) {
      players.push({ ...p, sport: t.sport, teamId: t.id, teamAbbr: t.abbr, eventId: t.eventId });
    }
  }

  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  res.status(200).json({ date, fetchedAt: Date.now(), games, players });
}
