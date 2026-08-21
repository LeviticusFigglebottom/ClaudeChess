# GAMBIT — Addendum A
**Supersedes/extends:** `GAMBIT_BOOTSTRAP.md`
**Status:** Phase 0 complete and gate-verified. This document defines **Phase 0.5**, which must land *before* Phase 1 writes any real game rows.
**Why now:** every item in §A1–A3 changes the schema or the rules-engine boundary. Migrating empty tables is free. Migrating after 500 games and 40k plies exist is not. Do this first.

> Owner's decision at Phase 0.5 kickoff (supersedes A1.1's recommendation below):
> **The rules engine is `chessops`, replacing chess.js.** Rationale: chessops is
> what Lichess runs on, natively supports Chess960 with correct X-FEN castling,
> ships a game tree model that satisfies A3.2, and already implements the variant
> rules in A1.3 (KotH, three-check, atomic, horde, racing kings, crazyhouse) —
> which removes the rules cost from Phase 4.5 entirely. It is GPL-3.0-or-later,
> same bucket as Stockfish.

---
## A0. Phase 0 review — carry-forward fixes
**A0.1 — Vendor the engine binaries. Do not fetch on postinstall.**
The current `postinstall` pulls Stockfish from the npm CDN with pinned hashes. That makes every Vercel production build dependent on a third-party CDN being up and on that exact version staying published. Commit the binaries to the repo (Git LFS if size warrants) and delete the fetch script from the install path. Keep the script as `npm run engine:refresh` for manual updates, with the hash check retained.
**A0.2 — Licensing note.** Stockfish and Fairy-Stockfish are both GPL-3.0. Shipping them means the distribution must include source or a pointer to it. Add a `/licenses` page and a `NOTICE` file now rather than discovering this later. This is fine for the project as scoped — just don't build a closed-source product on top of it without understanding the obligation.
**A0.3 — Engine abstraction validation.** The §3.2 contract is now load-bearing in a way it wasn't when written: §A1 requires a *second* engine binary behind the same interface. Before Phase 1, confirm no UCI string, no `EngineInfo` field, and no engine-specific option name escapes `src/lib/engine`. If anything does, fix it now — it's a 20-minute fix today and a refactor later.
---
## A1. Variants
### A1.1 The rules-engine problem (decide this before anything else)
`chess.js` has known, unresolved Chess960 castling bugs. This is documented in the project's own issue tracker (#441, #564) and Lichess hit it in production through their Board API. A Lichess investigation into Chess960 castling failures traced the bug to chess.js, the move-generation library in the path. There is also an open design question about accepting king-takes-rook castling encoding, which several engines and libraries have standardized on to avoid special-casing standard chess.
Three options, in order of preference:
**Option 1 — `cm-chess` (recommended).** It is a chess.js-inspired engine wrapper with first-class support for tree-structured move history with variations, PGN import/export with NAGs and comments, and Chess960 including correct O-O / O-O-O castling resolution. It solves §A1 and §A3 (variation tree) in one dependency swap. Cost: less battle-tested than chess.js; the `plies` write path and the `/play` move handler need rework. Do this **now**, at ~600 lines of surface area, not after Phase 2.
**Option 2 — chess.js + a 960 castling shim.** Keep chess.js for standard, intercept castling in 960 by converting king-to-rook UCI into the library's expected form, and hand-verify against a perft suite for 960 start positions. Cheaper today, and you own a correctness bug forever.
**Option 3 — chess.js for standard, `cm-chess` for 960 only.** Two rules engines, two code paths, two sets of bugs. Rejected.
**Gate:** whichever option, perft(4) must pass for **five** randomly chosen 960 start positions plus SP518 (standard), with castling exercised in each.
### A1.2 Chess960 — build it
Cost is genuinely low once A1.1 is settled, and the payoff to this project specifically is higher than it looks:
- Stockfish supports it natively via the `UCI_Chess960` option. Set it per-position; the engine handles the rest.
- Position generation: index 0–959, use the standard Scharnagl numbering so positions are reproducible and shareable. SP518 is the standard array.
- Castling in FEN must use **Shredder-FEN / X-FEN** file letters (`HAha`), not `KQkq`, or castling rights get lost across serialization. This is exactly the bug in the chess.com forum thread — 960 games created with `KQkq`-style rights that then can't castle.
- UI: castling is expressed as king-takes-own-rook. Support tap-king-then-tap-rook explicitly, since when king and rook are adjacent the drag gesture is ambiguous.
**Why this matters for GAMBIT and not just for parity:** Chess960 removes opening memorization as a confound. That makes it the **cleanest possible substrate for the Eval Calibration Trainer (§9.1)** — a 960 position at move 8 tests pure positional judgment with zero recall. It also makes bot calibration (Phase 1 gate) more honest, since neither side is playing from book.
The reverse is also true and must be handled: **§9.4 Repertoire is undefined for 960**, and `BOOK` classification (§4.2) can never fire. Gate both on `variant === 'standard'`.
### A1.3 Other variants — ranked
| Variant | Rules cost | Engine cost | Verdict |
|---|---|---|---|
| **Chess960** | Medium (castling) | Free — `UCI_Chess960` | **Build** |
| **Three-check** | Trivial (check counter) | Fairy-SF required | Build with Fairy |
| **King of the Hill** | Trivial (win square) | Fairy-SF required | Build with Fairy |
| **Crazyhouse** | High (drops = new move type, pocket UI, move-gen change) | Fairy-SF | Flag, later |
| **Atomic / Horde / Racing Kings** | Medium each | Fairy-SF | Flag, later |
| **Duck chess** | High, no engine support | None | Skip |
| **Bughouse** | Very high (4 players, 2 boards, cross-board realtime) | Fairy-SF | Skip |
The gating fact: **vanilla Stockfish cannot evaluate any of these except 960.** It will happily return an eval for a King-of-the-Hill position and that eval will be meaningless, which silently corrupts every downstream trainer. Variant support therefore requires a second engine.
**Engine strategy — dual binary behind one interface:**
- `fairy-stockfish-nnue.wasm` on npm, ~1.7MB, GPL-3.0, actively maintained, and used in production for local analysis on pychess.org. A WebAssembly port of Fairy-Stockfish is published on npm and is used for local analysis on pychess.org.
- Keep vanilla Stockfish as the default for `standard` and `chess960` — it is stronger and its NNUE is tuned for exactly that.
- Load Fairy-SF lazily, only when a variant game or variant analysis is opened. Never on the standard path.
- Both sit behind the existing `EngineClient` interface. Add `variant: VariantId` to `init()`. The rest of the app never learns which binary is running.
**Recommended scope:** Chess960 in Phase 1. Three-check and King of the Hill in a Phase 4.5, flagged `FF_VARIANTS`. Everything else deferred indefinitely — the trainers are the product, and Crazyhouse costs more than §9.2 does.
### A1.4 Schema changes (do before Phase 1)
```ts
games:
  + variant: 'standard' | 'chess960' | 'threecheck' | 'koth' | 'crazyhouse'  // default 'standard'
  + startFen: text        // null for standard; required for 960/custom
  + startPositionId: int  // 0-959 for chess960, null otherwise
plies:
  + variantStateJson: jsonb  // null for standard; check counts, pockets, etc.
ratings:
  // rating key becomes (userId, variant, timeControl) — 960 rating is separate
  + variant
```
Every analysis, classification, and trainer query must filter on `variant`. A 960 blunder and a standard blunder are not the same population and must not be pooled in §9.2's motif distribution.
---
## A2. Account system
The original spec said "Supabase Auth" and stopped. That's a one-line answer to a ten-part problem.
### A2.1 Anonymous-first
The single highest-impact decision: **let people play before they sign up.** Supabase supports anonymous sign-in that later converts to a permanent account with history intact. A chess site that demands an email before the first move loses most of its visitors on the landing page.
- Anonymous session on first visit, real `users` row with `isAnonymous: true`
- Play vs bots, do puzzles, run local analysis — all allowed anonymous
- Rated multiplayer, game import, and any LLM feature require a verified account (cost and abuse control)
- Conversion flow preserves `games`, `ratings`, `puzzle_attempts` by linking, never copying
### A2.2 Schema
```ts
users:
  + isAnonymous, emailVerifiedAt, handle (citext unique, 3-20 chars, reserved-word list)
  + displayName, avatarUrl, countryCode, bio, title           // FM/IM/GM, admin-granted only
  + tier: 'free' | 'plus', prefersBoardTheme, prefersPieceSet
  + deletedAt                                                  // soft delete, 30-day window
  + createdAt, lastSeenAt
sessions(id, userId, deviceLabel, ip, userAgent, createdAt, revokedAt)
relationships(id, userId, targetUserId, kind: 'friend'|'follow'|'block', status, createdAt)
  // block must actually block: no challenges, no matchmaking pairing, no DMs
challenges(id, fromUserId, toUserId|null, variant, timeControl, rated, color, token, expiresAt)
  // toUserId null + token = shareable open challenge link
usage_counters(userId, month, llmCalls, llmCostCents, importsRun, analysisPliesDeep)
fairplay_flags(id, userId, gameId, signal, score, reviewedAt, outcome)
audit_log(id, userId, action, meta, createdAt)   // auth events, rating adjustments, deletions
```
### A2.3 Fair play — minimal but present
Multiplayer without any cheat signal is multiplayer nobody trusts. Not building chess.com's system, but do collect:
- **Engine correlation** — per-game % of moves matching engine top-1 at depth 18, banded by position complexity. You already compute this in the review pipeline; it's free.
- **Accuracy vs. rating outlier** — flag when `gameAcc` sits > 3σ above the player's own trailing 50-game distribution.
- **Move-time entropy** — humans have highly variable think times. Near-constant time-per-move with high accuracy is the loudest signal there is, and §9.3 already computes `timeSpentMs`.
- **Tab blur during rated games** — record events, don't block. Signal only.
Write flags to `fairplay_flags`. Do not auto-ban. This is a personal project; the value is having the data, and it feeds §9.3 anyway.
### A2.4 Data obligations
- **Export** — full PGN archive + JSON of all analysis. You're importing from chess.com and Lichess; be at least as open as they are.
- **Delete** — soft delete with 30-day recovery, then hard cascade. Test the cascade before Phase 4 or you will find out about a FK constraint the hard way.
- **Rate limits** — per-user, per-tier, on `/api/analyze`, `/api/coach`, `/api/classify-blunder`, `/api/import`. Enforce against `usage_counters`, and surface the counter in the UI. An unbounded LLM endpoint behind an anonymous session is a bill waiting to happen.
---
## A3. Other gaps found on review
**A3.1 — Analysis board.** Not in the original spec at all, and it's a top-three chess.com feature. Free-form board: load FEN/PGN, play moves, engine analysis, save as a study. Depends on A3.2.
**A3.2 — Variation tree.** `plies` is linear. Real analysis branches. Options: (a) `cm-chess`'s native tree, which is the strongest argument for A1.1 Option 1; (b) a `variations(id, gameId, parentPlyId, moveIndex, san, uci, fenAfter, comment, nag)` table. Either way, **`plies` remains the canonical mainline** and all trainers keep reading it unchanged. Variations are additive and never feed §9 statistics.
**A3.3 — Tablebase.** Below 7 pieces the engine's eval is an approximation and Syzygy is ground truth. Without it, endgame classifications are wrong exactly where beginners lose the most points. Query `tablebase.lichess.ovh/standard?fen=` when `pieceCount <= 7`, cache by FEN in Postgres, and override `evalAfterCp` with a WDL-derived value. Cheap, high-accuracy return, standard-only.
**A3.4 — ECO/opening detection.** The `games.eco` and `games.opening` columns have no populating source. Import Lichess's `chess-openings` TSV files at build time into a `openings(eco, name, pgn, fenKey)` table, match on normalized FEN prefix, take the deepest hit. Needed by §9.4 and by the review header.
**A3.5 — Premoves.** Required for bullet, and non-trivial under a server-authoritative clock: the client queues a move, sends it the instant the opponent's move arrives, and the server validates against its own position and rejects on mismatch. Never let a premove skip server validation. Also: auto-cancel premove on check, and clear the queue on any position change.
**A3.6 — Clock semantics.** Specify explicitly and test: Fischer increment (added after the move), Bronstein delay, simple delay, and daily/correspondence. Correspondence needs a **cron-driven timeout job**, not Realtime — Vercel Cron hitting a route handler that flags expired games. Realtime only works while someone is connected, which is the opposite of correspondence.
**A3.7 — Accessibility.** Keyboard move entry (type SAN, arrow-key square navigation), ARIA live-region board announcements, colorblind-safe move-classification icons that differ by *shape*, not just color. Chess has a real blind and low-vision playing community, and none of this is expensive if it goes in before the board UI calcifies.
**A3.8 — Observability.** Track: engine init failure rate by browser, `crossOriginIsolated` false rate in the wild, p50/p95 analysis time per game, LLM cost per user per month, classification cache hit rate. The last one determines whether §9.2 is affordable at scale.
---
## A4. Revised phase order
```
Phase 0    ✅ complete, gate-verified (pending Vercel preview confirmation)
Phase 0.5  ← A0 fixes, A1.1 rules-engine decision, A1.4 + A2.2 schema, A3.4 ECO import
Phase 1      Play vs bot — now includes Chess960. Gate: bot calibration, unchanged.
Phase 1.5    Accounts (A2), anonymous-first, challenge links
Phase 2      Import + review pipeline. Add A3.3 tablebase before the classification gate.
Phase 2.5    Analysis board + variation tree (A3.1/A3.2)
Phase 3      Puzzles + explorer
Phase 4      Multiplayer. Add A3.5 premoves, A3.6 clock semantics, A2.3 fairplay signals.
Phase 4.5    Variants beyond 960 (FF_VARIANTS), Fairy-SF second binary
Phase 5      Trainers (§9). Unchanged — this is still the product.
```
Accessibility (A3.7) and observability (A3.8) are not phases. They land in whichever phase first builds the surface they apply to.
---
## A5. Immediate next actions
1. Connect Vercel, run `npm run gate -- --url <preview>`, close the Phase 0 gate formally.
2. Decide A1.1. If `cm-chess`, do the swap now — it costs the least it will ever cost, and it also settles A3.2.
3. Land A1.4 + A2.2 migrations against empty tables.
4. Then Phase 1.
