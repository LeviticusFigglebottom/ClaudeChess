# GAMBIT

A chess.com-parity platform whose *actual* product is a set of trainers that don't exist anywhere else. The clone is infrastructure; the trainers are the point. Full design: [`docs/SPEC.md`](docs/SPEC.md) + [`docs/ADDENDUM_A.md`](docs/ADDENDUM_A.md) + [`docs/ADDENDUM_B.md`](docs/ADDENDUM_B.md).

## Status: Phase 1.5 complete ✅ (Phase 0 ✅ · 0.5 ✅ · 1 built, calibration finals in flight)

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
npm test             # vitest — 196 tests incl. chessops⇄Stockfish perft cross-checks + PGlite account tests
npm run db:verify    # apply all migrations + seed to an empty in-process Postgres
npm run gate         # headless browser gate vs a running server (build+start first)
```

## Architecture

- **Rules** — `chessops` (Lichess's rules library) behind the facade `src/lib/chess/position.ts`, the only place its Result handling and Move/Square encodings live. Castling conventions are fixed there once: internally king-takes-rook; standard games emit classic UCI (e1g1) and accept both encodings; **chess960 FENs always serialize castling as X-FEN file letters (`HAha`), never `KQkq`**.
- **Chess960** — Scharnagl generation 0–959 (`src/lib/chess/chess960.ts`), SP518 = standard array, structural rules verified for all 960. UI castling for 960 is offered as king-takes-rook only (tap king, tap rook — drag is ambiguous when adjacent).
- **Engine** — Stockfish 18 Lite WASM (MT + single-thread fallback), **vendored in `public/engine/`** (no CDN in any build path; `npm run engine:refresh` is the manual, hash-verified upgrade tool). §3.2 `EngineClient` contract; `init()` takes `variant` — chess960 sets `UCI_Chess960`, variants vanilla Stockfish can't evaluate (KotH, three-check, crazyhouse) are **rejected at init** rather than returning meaningless evals; Fairy-Stockfish lands behind that same interface in Phase 4.5.
- **Eval** — cp→win-prob, the single POV-normalization boundary, §4 classification. `BOOK` can only fire for `variant === 'standard'`.
- **DB** — 17 tables. A1.4: `games.variant/startFen/startPositionId`, `plies.variantStateJson`, ratings keyed `(userId, variant, timeControl)`. A2.2: anonymous-first users (nullable email, citext handle 3–20), sessions, relationships (block-capable), challenges (open-link token), usage_counters, fairplay_flags, audit_log. **Every trainer/classification query filters on `variant` — 960 and standard are never pooled.**
- **Openings (A3.4)** — Lichess chess-openings TSVs vendored → compiled to an epd-keyed dataset (3,810 positions, every PGN replayed through chessops at build); `openingForGame` walks a game's positions deepest-first; transposition-aware; standard-only. `openings` table seeds idempotently via `db:seed:openings`.
- **Licensing (A0.2)** — `NOTICE` + `/licenses`: Stockfish and chessops are GPL-3; the combined distributed work is GPL-3.0-or-later.

## Known deliberate deviations

1. `stockfish.wasm`→ Stockfish 18 Lite (current NNUE MT successor); binaries vendored per A0.1.
2. No `src/workers/stockfish.worker.ts` — the engine script is the worker; the §3.2 contract lives in `src/lib/engine`. Engine pool + `analysis.worker.ts` land with Phase 2.
3. One hand-corrected line in generated migration 0002 (drizzle-kit emits custom types as `"undefined"."citext"` in ALTER statements) — commented in place, snapshot unaffected.
4. A3.4 "import at build time into a table": implemented as build-time compilation to a committed dataset + an idempotent seed script — Vercel builds have no database connection, and the matcher needs no table at runtime.

## Accounts (Phase 1.5, addendum A2)

- **Anonymous-first**: a Supabase anonymous session on first visit; play, puzzles and in-browser analysis are never gated. Import, server analysis, and LLM features require a verified account (cost + abuse control). No Supabase env → the app runs fully local (the header says so).
- **Conversion by linking**: the auth uuid is `users.id`; converting just flips `isAnonymous` and sets the email — every game/rating/attempt row stays put. Preferences (full B2.5 object in `users.prefs`) and the localStorage rating cache sync both ways: server wins once it has state, device seeds it when it doesn't.
- **Surface**: header account menu (create/sign in), `/account` (profile, visible usage meters vs caps, devices, export, delete/recover, admin title grants), `/friends` (requests, blocks, challenges), `/challenge/[token]` (open challenge links; accepted = the Phase 4 game-creation handoff).
- **Env**: `ADMIN_USER_IDS` (B1.3 allowlist), `CRON_SECRET` (Vercel Cron → `/api/cron/purge-deleted` hard-deletes accounts past the 30-day window).

## Roadmap (addendum A4)

Phase 1's bot-calibration gate (±75 Elo, ≥200 games/band — the gate not to skip) closes in the dedicated calibration sessions. Then: 2 import+review (+tablebase B0.1, variant-partitioned pool B0.2), 2.5 analysis board + variation tree, 3 puzzles/explorer, 4 multiplayer (premoves A3.5, clock semantics A3.6, fair-play A2.3/B0.5), 4.5 variants w/ Fairy-Stockfish (`FF_VARIANTS`), 5 the trainers.
