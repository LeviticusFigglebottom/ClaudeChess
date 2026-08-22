# GAMBIT — working notes for agents

Read `docs/SPEC.md` and `docs/ADDENDUM_A.md` before changing anything. They govern every decision; phase gates are falsifiable and must not be skipped. Current status: **Phase 0 and Phase 0.5 complete and gate-verified. Next: Phase 1 (play vs bot, now including Chess960), which ends at the bot-calibration gate — the one the spec says you will want to skip. Don't.**

## Commands

```bash
npm run dev              # dev server (localhost:3000)
npm test                 # vitest — 145 tests incl. chessops⇄Stockfish perft cross-checks
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
```

## Invariants — violating any of these is a bug

1. **POV normalization happens exactly once.** Raw `EngineInfo` (and everything in `src/lib/engine`) speaks side-to-move POV, as UCI does. `src/lib/eval/pov.ts` is the only conversion point to White-POV. Never add a compensating negation anywhere else. DB stores White-POV cp/mate; win probabilities are mover-POV.
2. **UCI strings never leave `src/lib/engine`.** The rest of the app talks to `EngineClient` (spec §3.2) only. This now includes test tooling: the Node cross-check harness lives at `src/lib/engine/node-engine.ts` (child-process CLI mode; never import from app code).
3. **chessops never leaves `src/lib/chess/position.ts`.** The facade is the single home of Result handling and Move/Square encodings; everything else consumes plain strings. Castling conventions are fixed there: internal king-takes-rook; standard emits classic UCI (e1g1) and accepts both encodings; **chess960 FENs always serialize castling as X-FEN file letters (HAha), never KQkq**.
4. **Every analysis, classification, and trainer query filters on `variant`** (A1.4). A 960 blunder and a standard blunder are different populations — never pooled. `BOOK` fires only for `variant === 'standard'` (enforced in classify.ts); §9.4 repertoire and A3.4 opening matching are standard-only.
5. **The engine refuses variants it cannot evaluate.** `init({variant})` throws for threecheck/koth/crazyhouse until Fairy-Stockfish lands (Phase 4.5) — a meaningless eval silently corrupts every trainer (A1.3). chess960 sets `UCI_Chess960` at init (an engine-instance option, not per-position).
6. **Never classify on raw centipawns** — convert through `winProb` first (spec §4.1). Thresholds live in `src/lib/eval/classify.ts`, pinned by tests.
7. **Original trainers ship flag-gated, default off** (`src/lib/flags`, spec §9).
8. **Cross-origin isolation must hold** (`next.config.ts` COOP/COEP). Any new external resource must be self-hosted or proxied. If `/engine-check` shows red on a deploy, fix that before feature work.
9. **Glicko-2 updates are batched per rating period** (12 games / 7 days), never per game (spec §7).
10. **Rating pools never blend** (Phase 2): GAMBIT's Glicko lives on the Stockfish UCI_Elo scale (that's what the bots are calibrated against); imported chess.com and Lichess ratings are two *other* pools. Any UI showing more than one labels each with its pool — never average, compare, or convert between them.
10. **Engine binaries are vendored** (`public/engine/`, committed). No build or install step may fetch them (A0.1). GPL notices: `NOTICE` + `/licenses` — update both when engine or rules deps change.
11. **Calibration fit invariant (from the 2000-band blowout):** the measured-strength curve is only invertible within a shared search *shape*, and shape means **truth depth AND MultiPV together** — MultiPV varies per band (§6a), so cross-band inversion inside a depth segment is still cross-shape. Cross-band fits produce first proposals only; every band's params must pass its own-shape 20-game checkpoint (nominal inside the 95% CI) before finals count. **No interpolation anywhere in d18 — option (c) is closed permanently.** Also: SF18-Lite's UCI_Elo **1400 label is defective at 400ms** (~160 Elo weak, three-way corroborated — `data/calibration/ruler-checks.txt`); never anchor on SF@1400 — band 1400 anchors on SF@1320.

## Layout facts

- Rules: `chessops` (GPL-3.0-or-later). chess.js is gone — do not reintroduce it. Chess960 generation is `src/lib/chess/chess960.ts` (Scharnagl 0–959, SP518 = standard).
- There is no `src/workers/stockfish.worker.ts`: the engine script itself is the worker. `src/workers/analysis.worker.ts` + the engine pool (spec §3.3) land with Phase 2. **The pool must partition workers by variant** (B0.2): `UCI_Chess960` is a per-instance option, so a mixed standard+960 import batch on one pool would thrash re-initializing — partition the job queue by variant, one sub-pool per active variant, capped in total.
- `react-chessboard` is pinned to v4 (spec §1). v5 is a breaking rewrite — don't bump casually.
- Migrations in `src/db/migrations` are generated — edit `src/db/schema.ts`, run `npm run db:generate`, then `npm run db:verify`. Exception on record: one hand-corrected line in 0002 (drizzle-kit emits custom types as `"undefined"."citext"` in ALTER statements); if that recurs on future citext ALTERs, correct it the same way with a comment. Schema enums are literal (drizzle-kit runs schema.ts standalone) and pinned to their domain constants by `src/db/schema.test.ts`.
- `src/db/seed/openings.json` is generated-but-committed (hermetic builds); regenerate via `openings:build` when `data/chess-openings/*.tsv` change — the script hard-fails if any PGN stops replaying.
- `public/sounds/gambit` is generated-but-committed from `scripts/build-sounds.mjs`; `public/pieces/*` are vendored with licenses. **Every asset directory must have an entry in `src/lib/assets/manifest.ts`** (B2.5) — a test enforces it, `/licenses` renders it.
- Design tokens (B2.3) live in `globals.css`. **`--flag` appears in exactly two places: flagfall and BLUNDER.** A third use is a bug, and there is a test pinning BLUNDER as its only classification. `prefers-reduced-motion` means instant state changes, not shortened animations.
- Bot policy is `src/lib/engine/bot.ts` (pure; §6 exactly); shipping params come from `src/lib/engine/bot-calibration.json` — **uncalibrated constants do not ship** (Phase 1 gate). The calibration arena/fit pipeline is `scripts/arena.mts`, `scripts/calibration-*.sh`, `scripts/calibrate-fit.mts`; evidence JSONLs live in `data/calibration/`.
- Bot games charge real wall time to the bot's clock; there is deliberately no 1+0 vs bots (the deep pass costs seconds) — bullet arrives with premoves in Phase 4.
- **Remote-container constraint (measured 2026-08-22):** the remote session's container freezes within minutes of the session going idle, and background process trees can be killed by worker restarts — long arena runs only progress while the session holds active foreground waits (sanctioned `until …; do sleep 30; done` loops; bare leading `sleep` is blocked). The arena checkpoints every game (JSONL append) and resumes from the shard's line count, so an interruption costs only the in-flight games.

## Testing expectations

New eval/classification/rating logic needs unit tests pinned to spec numbers. Rules-engine claims get cross-implementation verification where possible (see `perft960.test.ts`: chessops vs Stockfish `go perft` on identical FENs). Gate evidence lives in README.md — update it when gates are re-run on new infrastructure. Playwright drives `/engine-check` for anything needing a real browser + real engine; unit tests never touch the WASM engine except through the Node child-process harness.
