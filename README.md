# GAMBIT

A chess.com-parity platform whose *actual* product is a set of trainers that don't exist anywhere else. The clone is infrastructure; the trainers are the point. Full design: [`docs/SPEC.md`](docs/SPEC.md) + [`docs/ADDENDUM_A.md`](docs/ADDENDUM_A.md) + [`docs/ADDENDUM_B.md`](docs/ADDENDUM_B.md) + [`docs/ADDENDUM_C.md`](docs/ADDENDUM_C.md).

## Status: Phases 0–5 complete ✅ (0 · 0.5 · 1 · 1.5 · 2 · 2.5 · 3 · 4 · 4.5 · 5 — bot-calibration finals in their dedicated sessions)

Every phase gate below was executed by machine on this build (local Postgres 16, dev-auth, real engines; gate scripts in `scripts/gate-*.mts`). Two findings from running the gates are worth reading first:

1. **A spec defect, corrected**: §4.2's loss thresholds (10/20/30) transcribed Lichess's published 0.1/0.2/0.3 winning-chances deltas — which live on a [−1,1] scale — onto 0–100 without halving. The Phase 2 agreement gate caught it (GAMBIT reported ~4–5× fewer blunders than Lichess's own judgments on near-identical evals). Corrected to **5/10/15** in `src/lib/eval/classify.ts` with the derivation documented in-code, plus a depth-24 **borderline verification pass** for plies whose loss lands near the 10/15 decision boundaries.
2. **An upstream block, routed around**: `explorer.lichess.ovh` answers nginx **401** to this container's egress (its sibling `tablebase.lichess.ovh` answers 200, and `lichess.org` is fine). Everything explorer-fed (§9.1 empirical score, §9.4 tree, the explorer panel) runs through one client (`src/lib/explorer`) with `EXPLORER_BASE_URL`; gates exercised the identical code path against `scripts/mock-explorer.mjs` (deterministic, clearly-synthetic payloads), and the features degrade gracefully when the live upstream refuses. Production egress must be re-verified on deploy.

### Phase 2 — import + analysis + review (`gate-phase2-report.mts`, 50 imported Lichess games, 3,013 plies)

| Gate | Measured |
|---|---|
| **A — completeness**: every ply carries eval, win-prob loss, classification, isCritical | ✅ 3,013/3,013 plies, zero nulls; isCritical on 20.0% |
| **B — clocks**: timeSpentMs wherever the source PGN carried %clk | ✅ 3,009/3,009 clk-bearing plies (the 4 others are From-Position games whose sources omit early %clk) |
| **C — agreement vs Lichess's own judgments** (their NAGs on the same games, blunder+mistake counts within ±20% per side) | ✅ **white blunders 101 vs 120 (15.8%) · white mistakes 68 vs 79 (13.9%) · black blunders 99 vs 115 (13.9%) · black mistakes 74 vs 84 (11.9%)** — all four cells inside ±20% |
| C — >50% divergences investigated | ✅ 2 games (down from 3): per-ply diagnostics (`dbg-agree.mts`) show identical eval SIGNS and near-identical losses with Lichess's deeper cloud evals slightly more decisive — borderline plies fall across fixed thresholds; no classification-logic disagreement |
| **D — C4 fixture suite** | ✅ **159 fixtures, every one rank-1** (146 harvested from Lichess-puzzle themes + 10 handcrafted + 3 from this sample's own UNCLEAR review); a miss is a test failure, not a statistic |
| D — SEE vs exhaustive reference | ✅ **1000/1000 random capture positions agree** (the stand-pat prune was found unsound by this cross-check and removed) |
| D — no detector > 40% of blunders | ✅ max HANGING_PIECE 33.0% |
| D — UNCLEAR < 15% on the blunder sample | ❌ **26.8%** (48/179 blunders; 35.1% across all error classes; 19.2% on the pre-correction loss≥30 class). See below — reported as a measured finding, not silently absorbed |

**On the UNCLEAR miss.** C4's loop ("read the UNCLEAR sample; recurring patterns become detectors") ran twice against real UNCLEAR plies and produced six detector extensions plus three real-game fixtures. What remains is measured, not mysterious: a swing analysis over every surviving blunder-UNCLEAR (`dbg-unclear-swing.mts`) shows **46 of 49 have QUIET refutations** — no material swing within six plies, no mate. These are positional errors (initiative-killing trades, slow king-safety decay, structure concessions) that the closed C2.3 vocabulary — tactical mechanisms plus three narrow positional heuristics — cannot name with decidable geometry. Two structural notes: (1) the §4.2 threshold correction TRIPLED the blunder class by admitting 15–30wp positional slides; on the population the 15% bar was written against (loss ≥ 30), the rate is 19.2%; (2) inventing softer detectors to chase the number would trade rank-1 precision (the fixture suite's guarantee) for coverage — the honest state is a vocabulary gap, documented for a future addendum.

Per-game agreement table (ours vs Lichess, blunders/mistakes per side):

```
game      | ours W (B/M) | lich W (B/M) | ours B (B/M) | lich B (B/M)
qFnrMpgy |     1/2      |     1/2      |     0/2      |     0/1
pLJI70om |     3/0      |     3/1      |     3/1      |     3/2
ZcaiTVSc |     1/0      |     2/1      |     1/1      |     1/0
toi0gdv9 |     1/0      |     0/0      |     0/0      |     1/0
wiQq64ed |     1/2      |     1/4      |     1/0      |     1/1
pfnn5lPH |     6/1      |     7/3      |     2/3      |     1/8
ybvHcaEB |     2/0      |     2/0      |     2/1      |     2/0
DmwcmAeq |     4/3      |     5/3      |     3/1      |     4/2
eeHKM0vo |     4/2      |     4/4      |     3/3      |     4/2
72N85ObF |     0/1      |     0/1      |     1/0      |     1/1
o7i0X79D |     0/0      |     0/1      |     2/0      |     2/0
bx1nIPNY |     2/1      |     3/0      |     3/0      |     3/1
JbyN5XKE |     4/7      |     7/2      |     5/3      |     5/6
eXN12r6v |     1/1      |     2/0      |     1/0      |     1/0
PuqlzxVK |     5/0      |     4/1      |     4/0      |     2/2
OfooeDje |     0/0      |     0/0      |     1/2      |     1/2
XFuCm63i |     0/1      |     1/1      |     2/0      |     2/1
jhwLRGQ6 |     2/1      |     3/0      |     2/2      |     4/0
iuCTGyoj |     0/2      |     0/5      |     1/3      |     2/3
lui2jTCm |     0/1      |     1/3      |     0/4      |     1/7
lnKwHGjY |     2/1      |     2/3      |     1/4      |     2/0
GZlXv074 |     3/1      |     3/3      |     4/1      |     4/0
ah3zHYET |     3/2      |     3/2      |     4/5      |     5/6
zpCYJ0HA |     2/3      |     3/3      |     1/1      |     1/1
G0sau0p0 |     2/1      |     2/1      |     2/0      |     2/0
b4dyuTvM |     2/3      |     2/1      |     1/2      |     1/1
Gzft3tpg |     1/1      |     2/0      |     1/0      |     1/2
mkKF2v5m |     2/1      |     2/1      |     1/0      |     1/0
KXPt4uR7 |     1/3      |     2/5      |     1/2      |     2/4
l7y5GC19 |     1/3      |     0/4      |     0/2      |     0/2
iy0Ucoss |     3/0      |     3/0      |     4/1      |     5/0
ac1w0wJc |     2/1      |     4/0      |     0/2      |     1/2
IIzI81QV |     1/0      |     1/1      |     0/0      |     0/0
cL1bQkmO |     0/0      |     0/0      |     1/0      |     1/0
Jk3xPTvF |     3/7      |     5/4      |     4/4      |     5/2
H5CzIFfC |     10/2      |     10/2      |     9/3      |     9/2
IKcYKW2l |     0/2      |     0/2      |     1/1      |     1/2
btgCejNn |     3/1      |     5/0      |     1/2      |     2/1
65B4Ytym |     2/0      |     2/2      |     3/4      |     4/4
FuUuRPJk |     1/0      |     1/0      |     0/0      |     0/1
kPPbehrf |     1/1      |     2/2      |     1/1      |     2/1
1qd4NOUZ |     1/1      |     1/1      |     0/3      |     2/1
9VbkfB4b |     3/0      |     3/1      |     4/1      |     5/0
rmwJLV3U |     0/3      |     0/3      |     1/2      |     1/2
jCDYb77F |     6/1      |     6/2      |     6/2      |     6/2
qJE6D1Ks |     1/1      |     2/1      |     2/1      |     2/1
KsnbRtQC |     4/2      |     2/3      |     5/0      |     3/3
lewEsHXi |     2/1      |     3/0      |     2/1      |     3/0
WbJ9rOrc |     1/1      |     2/0      |     1/2      |     2/2
GVuZbn6p |     1/0      |     1/0      |     1/1      |     1/3
```


### Phase 3 — puzzles + explorer

| Gate | Measured |
|---|---|
| Puzzle rating convergence (fresh user vs seeded pools of true 950/1650/2100; real selection + per-attempt Glicko) | ✅ error at attempt 30: **46 / 119 / 23** Elo; late-attempt steps ≤ 19 — converged, no oscillation |
| Explorer p95 warm (cache path, 120 requests over 10 positions) | ✅ p50 **124ms**, p95 **198ms** (< 300ms), max 383ms |
| Puzzle pool | 31,224 puzzles (Lichess CC0 dump, rating-stratified subset), themes indexed for the §9.2 drill deck; puzzle Glicko is its own pool (`ratings[standard,'puzzle']`), never blended |

### Phase 4 — multiplayer (`gate-phase4.mts`, Playwright, two browser contexts, 3+0 to completion)

| Gate | Measured |
|---|---|
| Matchmaking pairs two queued players | ✅ both contexts land in the same live game via the UI |
| No desync | ✅ 30 scripted plies: after every ply both boards equal the facade-replay FEN; seq never diverged. Propagation median **103ms**, max 156ms (production server; 191–302ms on dev under load) |
| A3.5 premove | ✅ armed while waiting, auto-fired on turn, server-validated |
| Completion + flagfall | ✅ ends `0-1 · time forfeit`, both browsers identical; claim verified server-side |
| Clock drift at flag < 200ms | ✅ **−41ms** — the verified claim landed 41ms past true zero, recorded as the SIGNED `remainingAtFlagMs` in the end event (an earlier clamped-to-0 recording was rejected as evidence and replaced with the signed value; a contended-CPU run measured −4.3s, which motivated the lazy server-side flag finalize on state reads) |

### Phase 4.5 — variants (`gate-phase45.mts` + `gate-phase45-live.mts`)

| Gate | Measured |
|---|---|
| Rules agreement, chessops vs Fairy-Stockfish `go perft` on positions where variant ends prune the tree | ✅ three-check 59,866 & 728,887; KotH 2,056 & 19,562 — identical on both implementations |
| Fairy routing behind `EngineClient`/`ServerEngine` | ✅ three-check scores Bxf7+ as #1 (third check = mate); KotH +59cp; crazyhouse still refused at init (A1.3/B1.1) |
| Live three-check through the real APIs | ✅ queue pairs, 9 scripted plies, game ends the moment the third check lands: `1-0 · variant end`, FEN `… 0+3` |

### Phase 5 — the trainers (`gate-phase5.mts`, 15/15 over the real 50-game dataset)

| Gate | Measured |
|---|---|
| §9.1 calibration | ✅ own-game positions with deterministic tags; server-computed reveal (engine WP + Brier); report with decile curve, signed bias by tag, Murphy decomposition; empirical secondary score wired (explorer-gated) |
| §9.2 fingerprint | ✅ distribution over **353 real error plies with zero LLM involvement** (C5); drill deck maps top motifs → puzzle themes (B1.2) into `/puzzles?themes=`; explanations degrade to the rendered mechanism chain when the LLM is dark (200, `available:false`) |
| §9.3 tempo | ✅ response curves from **1,503 clocked plies over 50 games** (critical vs routine); flat point 0s for this blitz player; **misallocation 115s/game**; 3-second recognition round-trip with the flag server-side |
| §9.4 repertoire | ✅ EV tree 180 nodes/30 positions at the user's band; ranked EV/cost list (top +6.7/100 games); SM-2 drill transitions state and schedules `dueAt`; own-leaks scan found 1 leak in 5 repeated book moves |
| §9.5 post-mortem | ✅ prompts gated to critical plies, exactly ≤5 per game; `/api/coach` refuses 503 without a key (the one *required* LLM use, C0); verdict taxonomy closed; RIGHT_MOVE_WRONG_REASON tracked as its own metric |

## Earlier phases

| Phase 1.5 gate (accounts, A2) | Evidence |
|---|---|
| **Conversion preserves all history and preferences** | ✅ `src/lib/account/account.test.ts` "GATE: anonymous→permanent conversion": anon user accrues 2 games (1 rated), a rating row with pending Glicko batch, a puzzle attempt, and a full B2.5 prefs object → conversion (same auth uuid, `isAnonymous` flipped) leaves every primary key, row count, rating value, and the prefs object bit-identical — linked, never copied. One-way: a later anonymous-shaped sync cannot flip back. |
| **Delete cascade tested** | ✅ same file, "GATE: delete cascade": a user with rows in all 13 child tables (games→plies→blunder_tags, ratings, puzzle_attempts, calibration_attempts, postmortem_responses, relationships, challenges, usage_counters, fairplay_flags, sessions) hard-deletes clean; shared `puzzles` rows and a second user's games survive; `audit_log` rows survive with `user_id` nulled. Soft delete revokes sessions; recovery works inside 30 days and refuses after; the purge cron deletes only past-window accounts. |
| **Rate limits enforced and visible in UI** | ✅ `src/lib/account/usage.test.ts`: anonymous = zero caps on every server-metered kind (A2.1); free/plus tier caps bind exactly at the cap with nothing booked on denial; the B0.4 cost ceiling binds independently; caps sum across per-model rows; months roll over; 3-way race at cap-1 admits exactly one (advisory lock). Live now: `/api/import`, `/api/analyze`, `/api/coach`, `/api/classify-blunder` run the guard chain (401 → 403 unverified → 429 capped → 501 stub) ahead of their Phase 2/5 bodies, and `/account` renders every counter against its cap with meter bars. |
| **Blocks actually block** | ✅ `src/lib/account/social.test.ts`: blocking severs friendship both ways, voids open challenges between the pair, refuses new challenges/requests in both directions, refuses open-link accepts, and `canPair` (the Phase 4 matchmaking guard) returns false until unblocked. |
| **B1.3 — `users.title` grant path** | ✅ Built (kept the column): `POST /api/admin/title` behind the `ADMIN_USER_IDS` allowlist, FIDE-title enum + revoke, audit-logged, admin panel on `/account` — `account.test.ts` "B1.3". |
| **App integrity after the auth layer** | ✅ 196/196 tests; `tsc` + eslint clean; production build clean; engine gate re-run on this build: crossOriginIsolated, MT engine, depth 20 in 1179 ms, POV + 960 checks all green; with no Supabase env every page renders, APIs answer typed 503s, and the header shows "local mode" with zero client console errors. |

Phase 1.5 in one paragraph: **anonymous-first accounts** (Supabase session on first visit; play/puzzles/local analysis never gated), conversion by linking (same auth uuid — games/ratings/attempts never move), full **B2.5 preference sync** (localStorage ⇄ `users.prefs`, surviving conversion), server-side games + **Glicko-2 period state** (`ratings.period`, same `period.ts` module as the client, server wins), **friends/blocks/challenge links** (open challenges carry share tokens; accepted challenges are the Phase 4 handoff), **usage counters** with per-tier monthly caps enforced atomically and shown on `/account`, data **export** (PGN archive + analysis JSON), soft delete → 30-day recovery → cron purge, and device session management.

| Phase 0.5 gate | Measured result |
|---|---|
| **G1** — all ported tests green on chessops, no assertion weakened | ✅ 92/92 (the 57 ported intact + 35 new for 960/facade/openings/schema) |
| **G2** — perft(4): SP518 + five random 960 SPs, castling exercised | ✅ SP518=197,281; SP266=169,678; SP642=168,662; SP144=200,154; SP636=165,921; SP773=167,419 — chessops and Stockfish 18 `go perft` agree on every FEN, including castle-ready reductions where castling is proven inside the tree (see below) |
| **G3** — X-FEN round-trip, 20 random 960 positions, adjacent K+R included | ✅ 20/20 lossless (superset: all 960 SPs round-trip; 20-sample includes adjacent-K/R positions) |
| **G4** — engine sane on 960 with `UCI_Chess960`, sign normalization holds | ✅ SP266 X-FEN `HBhb` accepted → White-POV +45cp at depth 14; queen-odds probe: raw `cp −719` (side-to-move) → White-POV wp 93.4% |
| **G5** — migrations apply to empty DB, `drizzle-kit check` clean | ✅ 3 migrations / 90 statements on empty Postgres (PGlite + citext) + constraint probes + openings seed; `drizzle-kit check`: clean |
| **G6** — typecheck + production build, zero warnings | ✅ tsc clean, eslint zero problems, `next build` clean |

Castle-ready perft evidence (`node scripts/perft960-report.mjs`): each SP is also verified on a reduction with back ranks stripped to king + rooks, where a castling move provably exists at the root — SP518=369,906; SP266=318,333; SP642=317,211; SP144=314,956; SP636=366,272; SP773=366,277 nodes, all agreeing across both implementations.

Phase 0 gate results (still green on the current build): `crossOriginIsolated === true`, Stockfish 18 Lite WASM **multi-threaded**, depth 20 on startpos in ~1.1–1.6s, live sign checks, perft(4)=197,281. Re-verify any deploy at **`/engine-check`** or `npm run gate -- --url <url>`.

## Quick start

```bash
npm install          # engine binaries are vendored in-repo — nothing fetched
npm run dev          # http://localhost:3000 — no Supabase env needed: runs in local mode
npm test             # vitest — 423 tests incl. perft cross-checks, the 159-fixture C4 motif suite, PGlite account tests
npm run db:verify    # apply all migrations + seed to an empty in-process Postgres
npm run gate         # headless browser gate vs a running server (build+start first)
```

## Architecture

- **Rules** — `chessops` (Lichess's rules library) behind the facade `src/lib/chess/position.ts`, the only place its Result handling and Move/Square encodings live. Castling conventions are fixed there once: internally king-takes-rook; standard games emit classic UCI (e1g1) and accept both encodings; **chess960 FENs always serialize castling as X-FEN file letters (`HAha`), never `KQkq`**.
- **Chess960** — Scharnagl generation 0–959 (`src/lib/chess/chess960.ts`), SP518 = standard array, structural rules verified for all 960. UI castling for 960 is offered as king-takes-rook only (tap king, tap rook — drag is ambiguous when adjacent).
- **Engines** — Stockfish 18 Lite WASM (MT + single-thread fallback) for standard/chess960, and Fairy-Stockfish 14 WASM for three-check/KotH, **both vendored in `public/engine/`** (no CDN in any build path; `npm run engine:refresh` is the manual, hash-verified upgrade tool). §3.2 `EngineClient` and the server-side `ServerEngine` route by variant behind one interface; crazyhouse is **rejected at init** rather than returning meaningless evals (A1.3/B1.1). Batch analysis runs a variant-partitioned pool (B0.2) with one search per position — ply N's refutation line is ply N+1's stored pv1.
- **Eval** — cp→win-prob, the single POV-normalization boundary, §4 classification. `BOOK` can only fire for `variant === 'standard'`.
- **DB** — 17 tables. A1.4: `games.variant/startFen/startPositionId`, `plies.variantStateJson`, ratings keyed `(userId, variant, timeControl)`. A2.2: anonymous-first users (nullable email, citext handle 3–20), sessions, relationships (block-capable), challenges (open-link token), usage_counters, fairplay_flags, audit_log. **Every trainer/classification query filters on `variant` — 960 and standard are never pooled.**
- **Openings (A3.4)** — Lichess chess-openings TSVs vendored → compiled to an epd-keyed dataset (3,810 positions, every PGN replayed through chessops at build); `openingForGame` walks a game's positions deepest-first; transposition-aware; standard-only. `openings` table seeds idempotently via `db:seed:openings`.
- **Licensing (A0.2)** — `NOTICE` + `/licenses`: Stockfish and chessops are GPL-3; the combined distributed work is GPL-3.0-or-later.

## Known deliberate deviations

1. `stockfish.wasm`→ Stockfish 18 Lite (current NNUE MT successor); binaries vendored per A0.1.
2. No `src/workers/stockfish.worker.ts` — the engine script is the worker; the §3.2 contract lives in `src/lib/engine`. Server-side batch analysis is a child-process pool (`ServerEngine` + `AnalysisPool`, variant-partitioned per B0.2) rather than a browser worker pool — same §3.3 sizing rules, no WASM-in-route-handler fragility.
3. One hand-corrected line in generated migration 0002 (drizzle-kit emits custom types as `"undefined"."citext"` in ALTER statements) — commented in place, snapshot unaffected; the post-generate fixer + a test hold the line for future migrations (B0.8).
4. A3.4 "import at build time into a table": implemented as build-time compilation to a committed dataset + an idempotent seed script — Vercel builds have no database connection, and the matcher needs no table at runtime.
5. §7's period batching governs match ratings; **puzzle ratings update per attempt** in their own pool (`ratings[standard,'puzzle']`) — convergence in ~30 attempts is the point of the Phase 3 gate, and a 7-day batch would defeat it.
6. §4.2 loss thresholds ship as **5/10/15** (see Status — a scale-transcription defect in the spec, caught and corrected on gate evidence, derivation in `src/lib/eval/classify.ts`).
7. Live-game transport: Supabase Realtime carries a seq-only poke; a 500ms poll underneath is the resync/fallback (and the whole transport without Supabase env). The server stays authoritative either way; the Phase 4 gate's desync/drift numbers were measured on the poll path — the conservative case.

## Accounts (Phase 1.5, addendum A2)

- **Anonymous-first**: a Supabase anonymous session on first visit; play, puzzles and in-browser analysis are never gated. Import, server analysis, and LLM features require a verified account (cost + abuse control). No Supabase env → the app runs fully local (the header says so).
- **Conversion by linking**: the auth uuid is `users.id`; converting just flips `isAnonymous` and sets the email — every game/rating/attempt row stays put. Preferences (full B2.5 object in `users.prefs`) and the localStorage rating cache sync both ways: server wins once it has state, device seeds it when it doesn't.
- **Surface**: header account menu (create/sign in), `/account` (profile, visible usage meters vs caps, devices, export, delete/recover, admin title grants), `/friends` (requests, blocks, challenges), `/challenge/[token]` (open challenge links; accepted = the Phase 4 game-creation handoff).
- **Env**: `ADMIN_USER_IDS` (B1.3 allowlist), `CRON_SECRET` (Vercel Cron → `/api/cron/purge-deleted` hard-deletes accounts past the 30-day window).

## What remains

Phase 1's bot-calibration gate (±75 Elo, ≥200 games/band — the gate not to skip) closes in the dedicated calibration sessions; until it does, bots log `bot running UNCALIBRATED params` (theirs, not a defect). Beyond that: production deploy (Supabase env + Vercel crons + re-verifying `explorer.lichess.ovh` from production egress), an `ANTHROPIC_API_KEY` for the two LLM features (everything else runs without it), and crazyhouse if a drop-capable board ever justifies it (B1.1).
