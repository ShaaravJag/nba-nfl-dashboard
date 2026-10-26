// The prompt the Copy button puts on the clipboard. The market enum is built
// from the live catalog so the prompt can never drift out of sync with what the
// app can actually track.
import { MARKETS } from './markets.js';

function enumFor(sport, kind) {
  return Object.values(MARKETS)
    .filter((m) => m.sport === sport && m.kind === kind)
    .map((m) => `  "${m.key}"  ${m.label}`)
    .join('\n');
}

export const IMPORT_PROMPT = `You are converting sportsbook bet-slip screenshots into JSON for a personal bet tracker.

I will attach one or more screenshots. They may come from different sportsbooks (FanDuel, DraftKings, BetMGM, Caesars, ESPN BET, Fanatics, others), and a single screenshot may contain several separate bets.

OUTPUT RULES — these matter most:
- Reply with JSON ONLY. No explanation, no commentary, no markdown code fences, no backticks.
- Output a single JSON array, even if there is only one bet.
- One array element per distinct bet slip. A 4-leg parlay is ONE element with 4 legs.
- If one screenshot shows three parlays, output three elements.
- If several screenshots show the SAME bet, output it once.
- A round robin is not one bet: output each individual combination as its own element.
- A straight/single bet is an element with exactly one leg.
- Never invent a bet that is not visible. Never drop a leg you can see.

SCHEMA
[
  {
    "book": "FanDuel",          // sportsbook name as shown
    "stake": 10,                // wager in dollars, number only, no "$"
    "americanOdds": 650,        // total odds for the whole bet, e.g. +650 -> 650, -110 -> -110
    "payout": 75.00,            // total return if it wins, if the slip shows it; otherwise omit
    "legs": [
      {
        "sport": "nba",             // "nba" or "nfl"
        "playerName": "Zion Williamson",  // player props only, full name as shown
        "teamAbbr": "NO",           // game lines only: the team the bet is on
        "market": "nba.pts",        // from the enum below
        "line": 19.5,               // number
        "side": "over",             // "over" or "under"; omit for spread/moneyline
        "americanOdds": -162        // this leg's own price, if shown
      }
    ]
  }
]

CONVERTING LINES
- "TO SCORE 20+ POINTS" means 20 or more, so line 19.5, side "over".
- "Over 6.5 Rebounds" -> line 6.5, side "over".
- "Under 24.5 Points" -> line 24.5, side "under".
- "Alt" lines work the same way: use the number actually required.
- Spread "LAL -6.5" -> market spread, teamAbbr "LAL", line -6.5, no side.
- Moneyline -> market moneyline, teamAbbr set, line 0, no side.
- "Over 221.5 Total Points" -> market game_total, line 221.5, side "over", no teamAbbr.
- Anytime touchdown / double-double / triple-double are yes-no markets: line 0.5
  for anytime TD, 1.5 for double-double, 2.5 for triple-double, side "over".

MARKET ENUM — use these exact strings.

NBA player props:
${enumFor('nba', 'player')}

NBA game lines:
${enumFor('nba', 'game')}

NFL player props:
${enumFor('nfl', 'player')}

NFL game lines:
${enumFor('nfl', 'game')}

IF A MARKET IS NOT IN THE LIST
Do not guess and do not drop it. Emit the leg like this so the tracker keeps it
as a manually-marked leg:
  { "sport": "nba", "playerName": "...", "market": "unsupported", "rawLabel": "exact text from the screenshot" }
Use this for anything the list cannot express, such as first-half or quarter
player props, "first basket", "race to 20 points", or same-game correlations.

Now read the attached screenshots and output the JSON array.`;
