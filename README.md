# Bet Tracker

Live parlay tracking across sportsbooks, for personal use. Enter a bet once and
watch each leg's progress, the player's live stat line, and the game clock update
on their own — on a laptop and on a phone, with no subscription and no paid APIs.

## How it works

Stats come from ESPN's public site API (no key, no cost). `cache-control: max-age=5`
on their side means data lands within roughly 5–15 seconds of live.

A game's full box score is ~50KB, which is far too heavy to poll from a phone, so
`api/live.js` fans out to ESPN, trims each game to about 2KB, and sets a 5-second
edge cache. Every poll from every device collapses into one upstream fetch per
5 seconds.

Polling runs at 3s while a tracked game is live and the tab is visible, 15s in the
background, and stops when nothing is in progress.

## Layout

| Path | What it does |
|---|---|
| `public/markets.js` | Market catalog and settlement. The file that decides what can be tracked. |
| `public/app.js` | State, polling loop, rendering. |
| `public/sync.js` | Cross-device sync over Supabase REST. No client library. |
| `public/import-prompt.js` | The screenshot→JSON prompt, with its market enum generated from the catalog. |
| `api/_espn.js` | ESPN fetching and normalization. |
| `api/live.js` | Trimmed live box scores. |
| `api/slate.js` | Today's games plus a searchable player index. |

## Running locally

```
npm run dev     # http://localhost:4321
npm test        # settlement checks against a real finished game
```

`npm test` replays a completed NBA game through the settlement logic, so the maths
can be checked without waiting for tip-off.

## Adding bets

Either search the slate and build a leg by hand, or hit **Copy import prompt**,
paste it into a Claude chat with your bet-slip screenshots, and paste the JSON back
in. The prompt handles several screenshots, several sportsbooks, and several
parlays at once.

## Deploying

Pushing to `main` triggers a deployment, but Vercel will mark it `BLOCKED` unless
GitHub can attribute the commit to the account that owns the Vercel project. On a
Hobby team the commit author must verifiably be the team owner, and GitHub matches
commits to accounts by **verified email only** — a commit whose email is not on the
account shows `author: null` in the API and cannot be verified.

This repo is therefore configured to commit as the GitHub-provided noreply address:

```
git config user.email "110620877+ShaaravJag@users.noreply.github.com"
```

That address always attributes to the account and keeps a real email out of the
history. To check attribution after a push:

```
gh api repos/ShaaravJag/bet-tracker/commits/HEAD --jq '.author.login'
```

`null` means the deployment will be blocked. If a deployment does get blocked, it
can still be shipped through the API, which is authenticated as the account rather
than the commit author.

## Known limits

- Box scores are cumulative, so **first-half and quarter player props cannot be
  auto-tracked**. Game and team period totals can be, from the period line scores.
  Anything unmappable is kept as a leg with a manual hit/miss toggle rather than
  being dropped.
- FanDuel has no public API. Bets are entered manually or imported from screenshots.

## Sync

`bet_sync` in Supabase holds one row per sync code. The 12-character random code is
the shared secret; row-level security only exposes a row whose id you already have.
localStorage remains the source of truth on each device, so the app works offline
and keeps working if the Supabase project pauses.
