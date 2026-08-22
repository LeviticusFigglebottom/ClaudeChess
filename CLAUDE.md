# GAMBIT — working notes for agents

Read `docs/SPEC.md`, `docs/ADDENDUM_A.md`, `docs/ADDENDUM_B.md`, and `docs/ADDENDUM_C.md` before changing anything. They govern every decision; phase gates are falsifiable and must not be skipped. Current status: **Phases 0–5 all built and gate-verified (0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 4.5, 5). Phase 1's bot-calibration finals run in dedicated sessions (their files: `src/lib/engine` bot policy, `bot-calibration.json`, `data/calibration/`, `scripts/arena*`, `scripts/calibrate*` — do not touch). Gate evidence: README tables + `scripts/gate-*.mts`.**

One criterion is knowingly red: C4's UNCLEAR bar (spec < 15%, voided post-gate; revised target < 18% after the ten-motif structural class in `src/lib/motifs/structural.ts` was commissioned and landed) measures **24.0%** (43/179 blunders; was 26.8% pre-structural). The survivors are quiet-both-sides positional slides plus a few missed-cashing tactics whose punishment is the forgone win (analysis in `scripts/dbg-unclear-swing.mts`, full account in README). Do not chase the number with soft detectors; the fixture suite's rank-1 guarantee (181 fixtures) is the thing to protect. Two corrections made on gate evidence, both documented in code:
- **§4.2 loss thresholds are 5/10/15 wp, not 10/20/30** — the spec transcribed Lichess's 0.1/0.2/0.3 winning-chances deltas ([−1,1] scale) onto 0–100 without halving. Caught by the Phase 2 agreement gate (~4–5× fewer blunders than Lichess on identical evals); corrected in `src/lib/eval/classify.ts` (long comment there), plus a **borderline verification pass** (`verifyBorderline`, depth 24) refining plies whose loss lands near the 10/15 boundaries.
- **`explorer.lichess.ovh` refuses some egress networks** (nginx 401 while `tablebase.lichess.ovh` answers 200 — the dev container is affected). `EXPLORER_BASE_URL` points the shared client (`src/lib/explorer`) at a stand-in; `scripts/mock-explorer.mjs` serves deterministic synthetic payloads for gates. §9.1's empirical score and §9.4's tree builds degrade gracefully (surfaced `upstreamError`, never a crash).

## Commands

```bash
npm run dev              # dev server (localhost:3000)
npm test                 # vitest — 445 tests incl. chessops⇄Stockfish perft cross-checks, the C4 motif fixture suite (181, every fixture rank-1), and PGlite account-system tests
npm run build            # production build (lint + typecheck included)
npm run gate             # browser gate vs http://localhost:3000 (needs `npm run start` first)
npm run gate -- --url <url>     # gate vs a deployed preview; appends docs/gate-history.jsonl
npm run db:generate      # drizzle-kit generate + post-generate fixer (B0.8 — never skip the fixer)
npm run db:verify        # apply ALL migrations + openings seed to an empty in-process Postgres (gate G5)
npm run openings:build   # recompile src/db/seed/openings.json from data/chess-openings TSVs
npm run db:seed:openings # upsert openings into a real DB (needs DATABASE_URL)
npm run engine:refresh   # manual engine upgrade only — NEVER in any install/build path (A0.1)
node scripts/perft960-report.mjs   # G2 evidence table (chessops vs Stockfish perft)
node scripts/build-sounds.mjs      # regenerate the synthesized sound set (committed)
node scripts/e2e-phase1.mjs        # Phase 1 secondary gates (960 castling e2e, shape-only parity)
npx tsx scripts/arena.mts ...      # calibration self-play (see scripts/calibration-*.sh)
npx tsx scripts/calibrate-fit.mts --propose|--finalize   # fit → bot-calibration.json
npx tsx scripts/gate-phase2-report.mts   # Phase 2 gate: completeness + Lichess agreement + detector stats
npx tsx scripts/gate-phase3.mts          # puzzle convergence + explorer warm p95 (dev server up)
npx tsx scripts/gate-phase4.mts          # two-browser Playwright 3+0 gate (dev server + dev-auth)
npx tsx scripts/gate-phase45.mts         # variant perft cross-check + Fairy routing smoke
npx tsx scripts/gate-phase45-live.mts    # three-check live game through the real APIs
npx tsx scripts/gate-phase5.mts          # all five trainers over the real gate dataset
node scripts/mock-explorer.mjs           # local explorer stand-in (see EXPLORER_BASE_URL note above)
```

Local gate infrastructure: PostgreSQL 16 on 127.0.0.1:5432 (`gambit`/`gambit`), dev-auth (`GAMBIT_DEV_AUTH=1` + `NEXT_PUBLIC_GAMBIT_DEV_AUTH=1` + cookie `gambit-dev-user=<uuid>` = verified user; never in production), gate dataset = user `gate-phase2` (50 analyzed Lichess games).

## Invariants — violating any of these is a bug

1. **POV normalization happens exactly once.** Raw `EngineInfo` (and everything in `src/lib/engine`) speaks side-to-move POV, as UCI does. `src/lib/eval/pov.ts` is the only conversion point to White-POV. Never add a compensating negation anywhere else. DB stores White-POV cp/mate; win probabilities are mover-POV.
2. **UCI strings never leave `src/lib/engine`.** The rest of the app talks to `EngineClient` (spec §3.2) only. This now includes test tooling: the Node cross-check harness lives at `src/lib/engine/node-engine.ts` (child-process CLI mode; never import from app code).
3. **chessops never leaves `src/lib/chess/position.ts`.** The facade is the single home of Result handling and Move/Square encodings; everything else consumes plain strings. Castling conventions are fixed there: internal king-takes-rook; standard emits classic UCI (e1g1) and accepts both encodings; **chess960 FENs always serialize castling as X-FEN file letters (HAha), never KQkq**.
4. **Every analysis, classification, and trainer query filters on `variant`** (A1.4). A 960 blunder and a standard blunder are different populations — never pooled. `BOOK` fires only for `variant === 'standard'` (enforced in classify.ts); §9.4 repertoire and A3.4 opening matching are standard-only.
5. **The engine refuses variants it cannot evaluate.** Vanilla Stockfish serves standard/chess960 (`UCI_Chess960` at init — an engine-instance option, not per-position); the vendored Fairy-Stockfish build (`public/engine/fairy/`) serves threecheck/koth (Phase 4.5, `FAIRY_ENGINE_VARIANTS`); crazyhouse still throws (no drop UI — B1.1). Standard/960 must NEVER route to Fairy (weaker there). A meaningless eval silently corrupts every trainer (A1.3).
6. **Never classify on raw centipawns** — convert through `winProb` first (spec §4.1). Thresholds live in `src/lib/eval/classify.ts`, pinned by tests.
7. **Original trainers ship flag-gated, default off** (`src/lib/flags`, spec §9).
8. **Cross-origin isolation must hold** (`next.config.ts` COOP/COEP). Any new external resource must be self-hosted or proxied. If `/engine-check` shows red on a deploy, fix that before feature work.
9. **Glicko-2 updates are batched per rating period** (12 games / 7 days), never per game (spec §7).
10. **Rating pools never blend** (Phase 2): GAMBIT's Glicko lives on the Stockfish UCI_Elo scale (that's what the bots are calibrated against); imported chess.com and Lichess ratings are two *other* pools. Any UI showing more than one labels each with its pool — never average, compare, or convert between them.
10. **Engine binaries are vendored** (`public/engine/`, committed). No build or install step may fetch them (A0.1). GPL notices: `NOTICE` + `/licenses` — update both when engine or rules deps change.
11. **Account conversion links, never copies** (A2.1): the Supabase auth id IS the users.id, so anonymous→permanent must only flip flags on the same row. Any code path that creates a second user row or rewrites child FKs during conversion is a bug (pinned by `src/lib/account/account.test.ts`).
12. **Every LLM and analysis route consumes through `src/lib/account/usage.ts`** (A2.4): `consumeUsage` before/after paid work, or `checkUsage` + the `guarded-stub` chain (401 → 403 unverified → 429 capped) for routes whose bodies haven't landed. `/api/import`, `/api/analyze`, `/api/coach`, `/api/classify-blunder` all carry the guards ahead of their real bodies (guards were never loosened when the 501 stubs were replaced); LLM routes consume a unit only on real model calls — cache hits are free. Anonymous caps are all zero; client-side engine use is deliberately unmetered.
13. **Account domain logic lives in `src/lib/account/*` and takes a `Db` handle** — no HTTP, no Supabase, no `next/server` imports (api.ts and guarded-stub.ts are the only route-facing adapters, and stay out of `index.ts`). This is what lets the whole account system be tested against in-process PGlite (`test-db.ts` applies the real migration chain).
14. **Supabase env is optional**: absent → the app runs local-only (localStorage prefs/ratings, no persistence, "local mode" chip); present → anonymous session on first visit (A2.1). Nothing may hard-require an account service to play, do puzzles, or analyze locally. Server rating state is authoritative once a session exists — it runs the same `src/lib/rating/period.ts` the client runs, and client caches are overwritten by server responses.
15. **Motif detection is deterministic code, never a model** (C0/C2/C5): detectors in `src/lib/motifs/detect.ts` are pure predicates over stored analysis; every fixture in `src/lib/motifs/fixtures.json` must return its expected motif at rank 1 (a miss is a bug with a repro, not a statistic). The LLM only writes prose over proven evidence (`/api/classify-blunder` explanations, cached by `(motifChain, evidenceHash)`) or judges free-prose input (`/api/coach`, §9.5) — it can be wrong about wording, never about chess. Everything in `src/lib/llm` is server-side; the model id is spec-pinned in `client.ts`.
16. **The server is authoritative on live games** (Phase 4): every action replays through the facade inside an advisory-lock transaction (`withGame`); premoves get FULL validation (A3.5); clocks are charged by `src/lib/clock/clock.ts` and flag claims are verified server-side, with the SIGNED remaining (`remainingRawMs`) recorded in the end event — the Phase 4 drift evidence. State reads lazily finalize flagged games so a stalled client can never wedge one. The Realtime channel carries a seq-only poke; nothing trusts channel payloads.
17. **Trainer flags resolve env OR per-user prefs.labs** (`useFlag`) — overrides can only turn features ON. Trainer reports all filter on one `variant` (invariant 4 applies to §9 too; `calibration_attempts.variant` exists for exactly this).

## Layout facts

- Rules: `chessops` (GPL-3.0-or-later). chess.js is gone — do not reintroduce it. Chess960 generation is `src/lib/chess/chess960.ts` (Scharnagl 0–959, SP518 = standard).
- There is no `src/workers/stockfish.worker.ts`: the engine script itself is the worker. Server-side batch analysis is `src/lib/engine/server.ts` (child-process CLI over the vendored builds) driven by `src/lib/analysis/pool.ts`. **The pool partitions workers by variant** (B0.2): `UCI_Chess960` is a per-instance option, so a mixed standard+960 import batch on one pool would thrash re-initializing — partition the job queue by variant, one sub-pool per active variant, capped in total.
- `react-chessboard` is pinned to v4 (spec §1). v5 is a breaking rewrite — don't bump casually.
- Migrations in `src/db/migrations` are generated — edit `src/db/schema.ts`, run `npm run db:generate`, then `npm run db:verify`. Exception on record: one hand-corrected line in 0002 (drizzle-kit emits custom types as `"undefined"."citext"` in ALTER statements); if that recurs on future citext ALTERs, correct it the same way with a comment. Schema enums are literal (drizzle-kit runs schema.ts standalone) and pinned to their domain constants by `src/db/schema.test.ts`.
- `src/db/seed/openings.json` is generated-but-committed (hermetic builds); regenerate via `openings:build` when `data/chess-openings/*.tsv` change — the script hard-fails if any PGN stops replaying.
- `public/sounds/gambit` is generated-but-committed from `scripts/build-sounds.mjs`; `public/pieces/*` are vendored with licenses. **Every asset directory must have an entry in `src/lib/assets/manifest.ts`** (B2.5) — a test enforces it, `/licenses` renders it.
- Design tokens (B2.3) live in `globals.css`. **`--flag` appears in exactly two places: flagfall and BLUNDER.** A third use is a bug, and there is a test pinning BLUNDER as its only classification. `prefers-reduced-motion` means instant state changes, not shortened animations.
- Bot policy is `src/lib/engine/bot.ts` (pure; §6 exactly); shipping params come from `src/lib/engine/bot-calibration.json` — **uncalibrated constants do not ship** (Phase 1 gate). The calibration arena/fit pipeline is `scripts/arena.mts`, `scripts/calibration-*.sh`, `scripts/calibrate-fit.mts`; evidence JSONLs live in `data/calibration/`.
- Bot games charge real wall time to the bot's clock; there is deliberately no 1+0 vs bots (the deep pass costs seconds) — bullet arrives with premoves in Phase 4.
- Accounts (Phase 1.5): domain layer `src/lib/account/` (users/usage/relationships/challenges/games/export/admin), route adapters in `src/app/api/**`, session refresh in `src/middleware.ts`. `users.prefs` holds the full B2.5 object (the two named columns mirror it); `ratings.period` holds the Glicko-2 pending batch; challenge lifecycle is `challenges.status` + `acceptedByUserId`. Admin = `ADMIN_USER_IDS` env allowlist (B1.3); account purge runs via Vercel Cron (`vercel.json` → `/api/cron/purge-deleted`, `CRON_SECRET`). Blocks are real: they sever friendship, void open challenges, and `canPair` (which matchmaking calls) refuses the pair.
- Phase 2 pipeline: import `src/lib/import/` (linked_accounts per user, incremental cursors, chunked `/api/import`); analysis `src/lib/analysis/` (variant-partitioned `AnalysisPool`, `analyzeGameChunk` one search per position — ply N's refutation = ply N+1's stored pv1, `verifyBorderline` d24 refinement at the 10/15 boundaries, `finalizeDerived` = volatility isCritical + motifs + fair-play signals); tablebase client consults `tablebase.lichess.ovh` for wp only (B0.1 — never overwrites evals). PGN reading is `src/lib/chess/pgn-read.ts` (headers, %clk, %eval, NAGs, variations skipped).
- Phase 4 live play: `src/lib/play/` (live.ts server-authoritative games + archive-on-finish into the review pipeline, matchmaking.ts widening window + `canPair`, fairplay.ts A2.3 signals — self-visible on `/account` per B0.5). Transport = Supabase Realtime poke + 500ms poll fallback; without Supabase the poll IS the transport. Daily timeouts via `/api/cron/daily-timeouts`.
- Phase 5 trainers: domain `src/lib/train/` (calibration/tempo/fingerprint/repertoire/postmortem + position-tags), routes `/api/train/*` + the two metered LLM routes, pages `/train/*` behind flags. Explorer client `src/lib/explorer` (shared by panel, §9.1 empirical, §9.4 tree; `EXPLORER_BASE_URL`). `llm_cache` holds every model response; repertoire SM-2 state lives on `repertoire_nodes`.

## Testing expectations

New eval/classification/rating logic needs unit tests pinned to spec numbers. Rules-engine claims get cross-implementation verification where possible (see `perft960.test.ts`: chessops vs Stockfish `go perft` on identical FENs). Gate evidence lives in README.md — update it when gates are re-run on new infrastructure. Playwright drives `/engine-check` for anything needing a real browser + real engine; unit tests never touch the WASM engine except through the Node child-process harness.
