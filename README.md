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

The **Games** tab is every NBA game by day and every NFL game by week, as REAL-style
tiles. Tapping one opens an ESPN-style box score -- every column, starters and bench,
DNP rows, team totals and team stats -- refreshing every 5s while the game is live.
Players on your open bets are marked, with the stat each bet rides on outlined.
Both views poll on their own timer, and only while you are looking at them.

Leg tiles also flag foul trouble, blowouts that could sit the starters, and players
ruled out or not playing, and each parlay gets a one-line summary of what it still
needs. The alerts are information only; settlement never reads them. A player who
actually doesn't play is different: that leg is voided and the parlay re-priced
(see Known limits).

## Layout

| Path | What it does |
|---|---|
| `public/markets.js` | Market catalog and settlement. The file that decides what can be tracked. |
| `public/app.js` | State, polling loop, rendering. |
| `public/sync.js` | Cross-device sync over Supabase REST. No client library. |
| `public/import-prompt.js` | The screenshot→JSON prompt, with its market enum generated from the catalog. |
| `public/scores.js` | HTML for the Games tab and the box score. Pure functions of the data. |
| `api/_espn.js` | ESPN fetching and normalization. |
| `api/live.js` | Trimmed live box scores for the games you have bets on. |
| `api/scores.js` | One sport's scoreboard: NBA by day, NFL by week. |
| `api/box.js` | One game's full box score, in ESPN's own columns. |
| `api/slate.js` | Today's games plus a searchable player index. |

## Running locally

```
npm run dev     # http://localhost:4321
npm test        # settlement, alerts and box scores against real finished games
```

`npm test` replays a completed NBA game through the settlement logic and checks the
box-score tables against known final numbers, so the maths can be checked without
waiting for tip-off.

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
- ESPN publishes no NBA possession, so only NFL tiles show who has the ball.
- **Void legs.** A player prop goes void once it's certain the player won't play:
  ruled out on ESPN's injury report with the game under way, or, NBA only, no
  minutes by the final. The leg drops out and the parlay is re-priced the way books
  do it: at the remaining legs' odds, or by dividing the void leg's odds out of the
  parlay price. Pushed legs drop out the same way, and if every leg drops, the stake
  comes back. NFL box scores leave out players without a stat, so an NFL player who
  sits without being listed as out isn't caught. Same-game parlays are re-priced on
  plain leg odds, which may differ slightly from the book's own correlated price.
- If a re-price has no odds to work from (no leg prices and none on the void leg),
  History asks you for the payout instead of guessing.

## Sync

`bet_sync` in Supabase holds one row per sync code. The 12-character random code is
the shared secret; row-level security only exposes a row whose id you already have.
localStorage remains the source of truth on each device, so the app works offline
and keeps working if the Supabase project pauses.
