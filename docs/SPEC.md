# GAMBIT — Bootstrap Spec
**Target agent:** Claude Code (Fable)
**Owner:** Aaron
**Nature:** A chess.com-parity platform whose *actual* product is a set of trainers that don't exist anywhere else. The clone is infrastructure; the trainers are the point.
Read this whole document before writing code. Do not skip phase gates. Each gate has a falsifiable exit condition — if it doesn't pass, do not advance.
---
## 0. Design thesis (read this, it governs every decision)
chess.com's core loop is solved and boring: board, engine, matchmaking, review. All of it is library assembly. Building it is worth doing only because **five original trainers need that infrastructure to exist**, and those trainers are the reason this repo exists.
Therefore:
- **Never** invent an abstraction for the clone layer. Use the boring library, wire it up, move on.
- **Do** over-engineer the analysis pipeline. Everything downstream — calibration, fingerprinting, time analysis — depends on one canonical per-ply analysis record. Get that schema right in Phase 2 and the rest is cheap.
- Every original feature ships behind a flag, default **off**, so the clone half is independently shippable.
---
## 1. Stack
| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript strict | Known quantity, Vercel-native |
| Styling | Tailwind v4 | — |
| Board UI | `react-chessboard` v4 | Don't hand-roll drag/drop |
| Rules | `chess.js` v1.x | Legality, SAN/FEN/PGN, draw detection |
| Engine | `stockfish.wasm` (NNUE, multi-threaded build) | See §3 — headers are non-negotiable |
| Human-like bots | Maia (lc0 WASM) behind flag; SF-sampling default | See §6 |
| DB | Supabase Postgres + Drizzle ORM | Realtime included, free tier fine |
| Auth | Supabase Auth (email + OAuth) | — |
| Multiplayer | Supabase Realtime channels; PartyKit as fallback | Vercel serverless cannot hold websockets |
| LLM | Anthropic API, `claude-sonnet-4-6`, server-side route handlers only | Never expose the key client-side |
| Deploy | Vercel | — |
Monorepo not needed. Single Next app. Engine and analysis workers live in `/public/engine` and `/src/workers`.
---
## 2. Repository layout
```
/src
  /app
    /(marketing)/          landing, about
    /play                  vs-bot, vs-human, daily
    /analysis/[gameId]     review board + move list + eval graph
    /puzzles
    /train                 ← original trainers, flag-gated
      /calibration
      /fingerprint
      /tempo
      /repertoire
      /postmortem
    /api
      /analyze             batch engine analysis (server-side SF via node)
      /coach               LLM commentary
      /classify-blunder    LLM motif tagging (structured output)
      /explorer            Lichess explorer proxy + cache
      /import              chess.com / Lichess PGN ingest
  /lib
    /chess                 chess.js wrappers, FEN utils, material count
    /engine                worker client, UCI parser, pool manager
    /eval                  cp↔winprob, classification, thresholds
    /rating                glicko2.ts
    /flags                 feature flag module
  /workers
    stockfish.worker.ts
    analysis.worker.ts     orchestrates multi-ply batch analysis
  /db
    schema.ts              drizzle
    /migrations
/public
  /engine/stockfish.wasm, stockfish.js
  /maia/                   lc0 weights, flag-gated, lazy-loaded
```
---
## 3. Engine integration (highest-risk item — do this first)
### 3.1 SharedArrayBuffer headers
Multi-threaded Stockfish requires cross-origin isolation. Without it you silently fall back to single-thread and Phase 2 analysis takes 40x longer. Set in `next.config.ts`:
```ts
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
    ],
  }];
}
```
**Consequence you must handle:** COEP breaks any cross-origin resource without CORP headers — third-party images, embeds, fonts. Self-host all fonts. Proxy any external image through a route handler.
**Gate check:** `crossOriginIsolated === true` in browser console on the deployed Vercel preview. Log it on boot in dev. If false, stop and fix before continuing.
### 3.2 Worker contract
The rest of the app must never touch UCI strings. Expose exactly this:
```ts
interface EngineClient {
  init(opts: { threads: number; hashMb: number }): Promise<void>;
  setPosition(fen: string, moves?: string[]): void;
  analyze(opts: {
    depth?: number;
    movetimeMs?: number;
    multipv?: number;
  }): AsyncIterable<EngineInfo>;   // streams; last yield is final
  stop(): void;
  quit(): void;
}
interface EngineInfo {
  depth: number;
  multipv: number;          // 1-indexed
  scoreCp: number | null;   // from side-to-move POV
  mateIn: number | null;    // signed
  pv: string[];             // UCI moves
  nodes: number;
  nps: number;
}
```
**Critical:** Stockfish reports score from the **side to move**. Normalize to White-POV at the boundary of `/lib/eval` and never again. Every sign bug in this project will come from this. Write a unit test with a known losing-for-black position.
### 3.3 Engine pool
Phase 2 batch review analyzes ~80 plies at depth 18. Run a pool sized `min(navigator.hardwareConcurrency - 1, 4)` of worker instances, each analyzing a different ply, with a job queue. Show real progress (plies done / total), not a spinner.
Server-side analysis (`/api/analyze`) uses the native Stockfish binary via `node-uci` for imported-game bulk jobs so the user's laptop isn't melting. Client-side worker is for interactive analysis only.
---
## 4. Evaluation and classification (`/lib/eval`) — the spec everything depends on
### 4.1 Centipawns → win probability
Never classify on raw centipawns. A 200cp swing at +50 is catastrophic; at +900 it's noise. Convert first:
```ts
// Lichess-derived logistic. Returns 0..100 for the given POV.
export function winProb(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1000, 1000))) - 1);
}
```
Mate scores: `mateIn > 0 → 100`, `mateIn < 0 → 0`.
### 4.2 Move classification
For each ply: let `wpBefore` = win prob for the mover before their move, `wpAfter` = win prob for the mover after. `loss = wpBefore - wpAfter`.
| Class | Condition |
|---|---|
| `BOOK` | Position in Lichess explorer with ≥ 1000 games at the user's rating band |
| `BRILLIANT` | See 4.3 |
| `GREAT` | See 4.4 |
| `BEST` | Move == MultiPV-1 move |
| `EXCELLENT` | `loss < 2` |
| `GOOD` | `loss < 5` |
| `INACCURACY` | `loss >= 10` |
| `MISTAKE` | `loss >= 20` |
| `BLUNDER` | `loss >= 30` |
| `MISS` | Best move led to mate or ≥ +400cp gain, played move captured < half of it |
(Gaps between 5–10 fall to `GOOD`. Order of evaluation matters: check BOOK → BRILLIANT → GREAT → MISS → loss bands.)
### 4.3 BRILLIANT — all must hold
1. Move sacrifices material: static material delta after the opponent's best reply is ≤ −200cp for the mover
2. Move is sound: `loss < 5`
3. Position was not already trivially winning: `wpBefore < 85`
4. Position is not lost anyway: `wpAfter > 40`
5. Not a recapture, not a forced move (legal moves > 1)
### 4.4 GREAT — only-move
With MultiPV = 3: `winProb(pv1) - winProb(pv2) >= 15` **and** the player found pv1. Excludes positions with only one legal move.
### 4.5 Accuracy score
Per-move accuracy from win-prob loss, then harmonic-ish aggregate:
```
moveAcc = 103.1668 * exp(-0.04354 * loss) - 3.1669   // clamp 0..100
gameAcc = weighted mean, weights = position volatility
```
Volatility weight = stdev of win-prob over a ±2-ply window, floor 0.5. This stops a 60-move dead-drawn endgame from inflating accuracy to 99%.
### 4.6 Analysis settings
- Review pass: `depth 18`, `MultiPV 3`
- Deep dive (user-triggered on one position): `depth 24`, `MultiPV 5`
- Shallow pass (for the bot blunder-plausibility trick, §6): `depth 6`, `MultiPV 5`
---
## 5. Data model (Drizzle)
Get this right once. Everything original reads from `plies`.
```ts
users(id, handle, email, createdAt)
ratings(userId, timeControl, rating, rd, volatility, updatedAt)  // Glicko-2, per TC
games(
  id, userId, source: 'local'|'online'|'chesscom'|'lichess',
  externalId, pgn, whiteName, blackName, userColor,
  result, termination, timeControl, eco, opening,
  playedAt, importedAt
)
plies(
  id, gameId, ply, moveNumber, color,
  san, uci, fenBefore, fenAfter,
  evalBeforeCp, evalAfterCp, mateBefore, mateAfter,
  bestMoveUci, pv1, pv2, pv3,          // json arrays
  wpBefore, wpAfter, wpLoss,
  classification,                       // enum from 4.2
  clockMsRemaining, timeSpentMs,        // null if PGN lacks %clk
  isCritical,                           // see §9
  analyzedAtDepth
)
blunder_tags(id, plyId, motif, confidence, explanation, model, taggedAt)
calibration_attempts(
  id, userId, fen, positionTags,        // json: openness, phase, material imbalance, side attacking
  predictedWp, actualWp, squaredError, respondedAt
)
repertoire_nodes(
  id, userId, color, fen, moveUci,
  reachProb, ratingBand, whiteWins, draws, blackWins,
  evPerNode, status: 'known'|'learning'|'unseen', lastReviewedAt
)
postmortem_responses(id, plyId, userId, userReasoning, verdict, critique, respondedAt)
puzzles(id, fen, movesUci, rating, ratingDeviation, themes, popularity)
puzzle_attempts(id, userId, puzzleId, solved, timeMs, attemptedAt)
```
Index `plies(gameId, ply)`, `plies(gameId) where classification in ('MISTAKE','BLUNDER')`, `blunder_tags(motif)`.
---
## 6. Bots that feel human (this is where you beat chess.com)
chess.com's bots are Stockfish with `Skill Level` nerfed. That produces a 2000-strength positional move followed by a random queen hang. Humans don't blunder randomly — they blunder in **specific, structured ways**. Build two tiers.
### Tier A — default, no extra deps: shallow-good/deep-bad sampling
The core trick:
1. Run **depth 6, MultiPV 5** on the position — these are the moves that *look* good to a human doing a shallow search
2. Run **depth 18, MultiPV 5** — ground truth
3. A move that ranks top-3 shallow but is bad deep is a **human-plausible blunder**. That's exactly the move a 1200 plays.
4. Selection policy given target rating `R`:
   - `pBlunder = clamp(0.45 - (R - 600) / 3000, 0.02, 0.45)`
   - With prob `pBlunder`, and if a shallow-good/deep-bad candidate exists with deep loss in 15–45 wp, play it
   - Otherwise sample from deep MultiPV via softmax over `-wpLoss` with temperature `T = clamp(6.0 - (R - 600) / 300, 0.15, 6.0)`
5. Additionally scale by phase: raise `pBlunder` 1.4x in complex middlegames (legal moves > 35), lower to 0.5x in forced sequences.
Calibrate empirically: self-play each rating band 200 games against a reference SF at known Elo, fit the curve. Log the fitted table in `/lib/engine/bot-calibration.json`. **Do not ship uncalibrated constants.**
### Tier B — flag `NEXT_PUBLIC_FF_MAIA`: real Maia weights
Maia is Leela trained to predict human moves at specific rating bands (`maia1100`–`maia1900`). It errs where humans err because it was trained on where humans erred. Run via lc0 WASM, lazy-load weights per band (~10–20MB each), cache in IndexedDB. Node backend fallback if WASM proves too slow.
When Maia is enabled, Tier A remains for bands Maia doesn't cover (< 1100, > 1900).
### Coaches
"Coach" = a persona layer over a bot. Persona config: `{ name, ratingBand, style: 'aggressive'|'solid'|'gambit'|'endgame', voice }`. After each of the user's moves, if `wpLoss >= 10` or the move was `GREAT`/`BRILLIANT`, fire `/api/coach` with `{ fenBefore, san, bestMove, pv, wpLoss, persona }` and stream back two sentences. Rate-limit to one comment per 3 plies. This is where you're structurally better than chess.com — their commentary is template lookup on tactical motif; yours is a model reading the actual position.
---
## 7. Rating (`/lib/rating/glicko2.ts`)
Glicko-2, standard params: `τ = 0.5`, initial `rating 1500`, `RD 350`, `σ 0.06`. Rating period = 12 games or 7 days, whichever first — batch updates within a period, don't update per-game (that's what makes Glicko work). Separate rating per time control bucket: `bullet | blitz | rapid | classical | daily`.
Bots have fixed rating and `RD 30` so they inform the user's rating without drifting.
---
## 8. Phases and gates
### Phase 0 — Skeleton + engine
Scaffold, Tailwind, Supabase, Drizzle migrations, board rendering, `chess.js` wired, Stockfish worker with the §3.2 interface.
**Gate:** `crossOriginIsolated === true` on Vercel preview. Engine reaches depth 20 on the start position in < 3s. Sign-normalization unit test passes. Legal move generation matches `chess.js` perft(4) = 197,281.
### Phase 1 — Play vs bot
All time controls with a real clock (increment + delay), resign/draw offer/takeback-in-casual, Tier A bots at bands 600/800/1000/1200/1400/1600/1800/2000/2200, Glicko-2 updates, game saved to `games` + PGN with `%clk`.
**Gate:** Bot calibration table fitted from ≥ 200 self-play games per band; measured Elo within ±75 of nominal for every band. **This gate is the one you will want to skip. Do not skip it.**
### Phase 2 — Import + review pipeline
Chess.com public API (`api.chess.com/pub/player/{u}/games/{YYYY}/{MM}`) and Lichess (`lichess.org/api/games/user/{u}?clocks=true&evals=false`) ingest. Batch server-side analysis populating `plies` completely. Review UI: eval graph, move list with classification icons, accuracy per side, key-moments jump.
**Gate:** Import 50 real games, every ply has non-null `evalBeforeCp`, `wpLoss`, `classification`. Classification distribution sanity-checks against the same games' chess.com review (blunder counts within ±20%).
### Phase 3 — Puzzles + explorer
Lichess puzzle database import (CSV dump, ~4M puzzles, filter to a workable subset). Rated puzzle mode with Glicko. Opening explorer via `/api/explorer` proxy to `explorer.lichess.ovh` with 24h cache in Postgres.
**Gate:** Puzzle rating converges within 30 puzzles; explorer p95 latency < 300ms warm.
### Phase 4 — Multiplayer
Supabase Realtime channel per game. **Server is authoritative on clock and legality** — client never computes remaining time for scoring. Matchmaking by rating window that widens over queue time. Reconnect with state resync. Abandonment timer.
**Gate:** Two browsers, 3+0 bullet game to completion, no desync, clock drift < 200ms at flag.
### Phase 5 — The trainers (§9). All flag-gated, default off.
---
## 9. The original features
Flag module (`/lib/flags`): env-driven, per-user override in DB, dev toggle panel.
```ts
FF_CALIBRATION | FF_FINGERPRINT | FF_TEMPO | FF_REPERTOIRE | FF_POSTMORTEM | FF_MAIA
```
### 9.1 Eval Calibration Trainer — `/train/calibration`
**Claim:** knowing *whether you're better* is the 1200→1800 skill, and nobody trains it directly.
Flow: show a position (from the user's own games, biased toward `isCritical`). User predicts win probability for White with a slider, 0–100. Reveal engine's WP. Score `(pred - actual)² / 10000`.
Track and surface:
- **Calibration curve** — bin predictions into deciles, plot mean prediction vs mean engine WP. Diagonal = calibrated.
- **Directional bias by tag** — group `positionTags` and compute signed mean error. The output the user wants is literally: *"You overestimate your position by 14 WP when you're the one attacking, and by 22 in closed positions."*
- **Discrimination vs calibration** — decompose squared error into resolution and reliability. Someone can be well-calibrated on average and still unable to tell winning from losing.
`positionTags` computed at generation time: `phase`, `openness` (pawn locks / open files), `materialBalance`, `sideAttacking` (king-zone attacker count), `kingSafetyDelta`, `hasImbalance` (bishop pair, exchange, pawn structure asymmetry).
**Note the honest caveat, and put it in the UI:** the engine's WP is not ground truth for a human game — it's ground truth under perfect play. Also report a secondary score against *empirical* outcomes from Lichess explorer at the user's rating band where the position is in-book. Show both.
### 9.2 Blunder Fingerprinting — `/train/fingerprint`
**Claim:** "you blundered 4 times" is descriptive. "73% of your blunders are overloaded-defender misses in positions with an open f-file" is causal.
Pipeline: for every ply where `classification ∈ {MISTAKE, BLUNDER, MISS}`, call `/api/classify-blunder` with `{ fenBefore, sanPlayed, bestMove, pv1, pv2, wpLoss, materialDelta, phase }`. Model returns **structured JSON only**, no prose preamble:
```json
{ "motif": "OVERLOADED_DEFENDER", "secondary": "BACK_RANK", "confidence": 0.82,
  "explanation": "..." }
```
Fixed taxonomy — the model must pick from this enum, closed set, no free text:
```
HANGING_PIECE, OVERLOADED_DEFENDER, PINNED_PIECE_MOVED, BACK_RANK,
FORK_ALLOWED, SKEWER_ALLOWED, DISCOVERED_ATTACK_MISSED, TRAPPED_PIECE,
REMOVING_THE_DEFENDER, ZWISCHENZUG_MISSED, KING_SAFETY_COLLAPSE,
PAWN_STRUCTURE_COLLAPSE, MATERIALISM, PREMATURE_ATTACK, PASSIVITY,
ENDGAME_TECHNIQUE, PAWN_RACE_MISCOUNT, OPPOSITION_LOST,
TIME_PRESSURE, TUNNEL_VISION_POST_FORCING, UNCLEAR
```
Two motifs are computed, not model-judged — trust the data over the model here:
- `TIME_PRESSURE`: `clockMsRemaining < 15000` and no other motif above 0.6 confidence
- `TUNNEL_VISION_POST_FORCING`: previous ≥ 3 plies were all checks/captures/forced
Output: ranked motif distribution with counts, trend over time (is it shrinking?), and a **drill deck** — pull puzzles from the Lichess set matching the top-3 motif themes, at the user's puzzle rating. The loop is: diagnose → drill → re-measure next month.
Validation you owe yourself: hand-label 50 blunders, measure model agreement. If < 70%, the taxonomy is wrong or the prompt is underspecified. Log the number.
### 9.3 Time Allocation — `/train/tempo`
**Claim:** most players' accuracy is flat past ~15s on non-critical moves, then they have 20 seconds left for the position that mattered.
Requires `%clk` in PGN — both chess.com and Lichess export it; import with clocks or the whole feature is dark.
Compute:
- `timeSpentMs` per ply from clock deltas minus increment
- **Personal response curve:** `wpLoss` vs `log(timeSpentMs)`, fitted separately for critical and non-critical positions. Where does your curve flatten?
- **`isCritical` definition** (compute at analysis time, store on `plies`): `winProb(pv1) - winProb(pv2) >= 12` (only-move-ish) **or** `stdev(wp) over ±2 ply >= 10` (volatile) **or** legal captures ≥ 5 with material at stake ≥ 300cp
- **Misallocation metric:** total seconds spent on non-critical positions past your personal flat point. Report in seconds/game — "you waste 94 seconds per game," which is a number that changes behavior
- **Critical-position detection trainer:** show a position, user calls "critical / routine" in 3 seconds, score against the computed flag. This trains the *recognition*, which is the actionable half
### 9.4 Repertoire EV Optimizer — `/train/repertoire`
**Claim:** repertoire tools teach 15 moves into the Najdorf. Your opponents leave book on move 4.
Build a tree from `explorer.lichess.ovh/lichess` filtered to the user's `ratings` band and `speeds`. For each node:
```
reachProb(node)   = ∏ opponent move frequencies along the path
scoreDelta(move)  = expectedScore(move) - expectedScore(weighted avg of alternatives)
EV(node)          = reachProb × scoreDelta × 100      // points per 100 games
cost(node)        = memorization units (1 per novel move, discounted if transposes to known)
priority          = EV / cost
```
Expand breadth-first by `priority`, prune `reachProb < 0.005`. Present as a ranked to-learn list: *"Learn 4 moves here → +2.1 points per 100 games. Learn 9 moves in the Najdorf → +0.3."* Spaced-repetition drilling on `repertoire_nodes` with SM-2.
Second output that matters: **your own leaks.** Cross-reference your played games against the tree — where do *you* leave book into a −EV node? Those go to the top of the list.
### 9.5 Interrogative Post-Mortem — `/train/postmortem`
**Claim:** you can play the right move for the wrong reason for years and never find out.
On any reviewed ply, before revealing the engine line, the app asks: *"What were you worried about here? What did you think their plan was?"* User writes free prose. **Then** reveal. `/api/coach` gets `{ fenBefore, sanPlayed, userReasoning, engineTruth }` and returns:
```json
{ "verdict": "RIGHT_MOVE_WRONG_REASON" | "CORRECT" | "MISREAD_THREAT" |
             "MISSED_OPPORTUNITY" | "SOUND_BUT_INCOMPLETE",
  "critique": "..." }
```
The valuable class is `RIGHT_MOVE_WRONG_REASON` — invisible to every other chess tool in existence, because they only see the move. Track its frequency over time as its own metric.
Gate it to critical positions (`isCritical`) so it doesn't become tedious. Max 5 prompts per game review.
---
## 10. Cross-cutting requirements
**LLM calls.** All server-side. Structured outputs get an explicit "respond with JSON only, no markdown fences" instruction *and* defensive fence-stripping before `JSON.parse`. Cache classification results by `(fen, san)` hash — the same blunder recurs across users and across a user's own games.
**Cost control.** Blunder classification on a 500-game import is ~3000 calls. Batch them, cache aggressively, and put a per-user monthly cap with a visible counter.
**Performance budget.** Review page interactive < 1.5s. Engine analysis progress must be streamed, never a blocking spinner. Puzzle load < 200ms.
**Testing.** `chess.js` perft suite. Sign-normalization tests on known positions. Glicko-2 against the reference paper's worked example (1500/200 vs three opponents → 1464.06, RD 151.52). Classification thresholds against 20 hand-labeled positions.
**Mobile.** Board must be usable one-handed on a phone. Tap-tap move input in addition to drag. This is where the majority of chess play happens.
---
## 11. What to build first, concretely
Start Phase 0 now. The single highest-risk item is cross-origin isolation on Vercel with `stockfish.wasm` multi-threaded — if that fails, everything downstream is 40x slower and the architecture changes (server-side-only analysis). Prove it works on a deployed preview URL before writing a second feature.
Then Phase 1 and stop at the calibration gate. Bot quality is the difference between a portfolio piece and something you actually open on a Tuesday.
