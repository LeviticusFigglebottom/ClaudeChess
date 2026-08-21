# GAMBIT

A chess.com-parity platform whose *actual* product is a set of trainers that don't exist anywhere else. The clone is infrastructure; the trainers are the point. Full design: [`docs/SPEC.md`](docs/SPEC.md) + [`docs/ADDENDUM_A.md`](docs/ADDENDUM_A.md).

## Status: Phase 0.5 complete ✅ (Phase 0 ✅)

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
npm run dev          # http://localhost:3000
npm test             # vitest — 92 tests incl. chessops⇄Stockfish perft cross-checks
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

## Roadmap (addendum A4)

Phase 1 (next): play vs Tier-A bots **including Chess960**; stops at the bot-calibration gate (±75 Elo, ≥200 games/band — the gate not to skip). Then 1.5 accounts (anonymous-first), 2 import+review (+tablebase), 2.5 analysis board, 3 puzzles/explorer, 4 multiplayer, 4.5 variants w/ Fairy-Stockfish (`FF_VARIANTS`), 5 the trainers.
