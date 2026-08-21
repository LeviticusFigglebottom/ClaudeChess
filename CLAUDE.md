# GAMBIT — working notes for agents

Read `docs/SPEC.md` and `docs/ADDENDUM_A.md` before changing anything. They govern every decision; phase gates are falsifiable and must not be skipped. Current status: **Phase 0 and Phase 0.5 complete and gate-verified. Next: Phase 1 (play vs bot, now including Chess960), which ends at the bot-calibration gate — the one the spec says you will want to skip. Don't.**

## Commands

```bash
npm run dev              # dev server (localhost:3000)
npm test                 # vitest — 92 tests incl. chessops⇄Stockfish perft cross-checks
npm run build            # production build (lint + typecheck included)
npm run gate             # browser gate vs http://localhost:3000 (needs `npm run start` first)
npm run gate -- --url <url>     # gate vs a deployed preview
npm run db:generate      # drizzle-kit generate after editing src/db/schema.ts
npm run db:verify        # apply ALL migrations + openings seed to an empty in-process Postgres (gate G5)
npm run openings:build   # recompile src/db/seed/openings.json from data/chess-openings TSVs
npm run db:seed:openings # upsert openings into a real DB (needs DATABASE_URL)
npm run engine:refresh   # manual engine upgrade only — NEVER in any install/build path (A0.1)
node scripts/perft960-report.mjs  # G2 evidence table (chessops vs Stockfish perft)
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
10. **Engine binaries are vendored** (`public/engine/`, committed). No build or install step may fetch them (A0.1). GPL notices: `NOTICE` + `/licenses` — update both when engine or rules deps change.

## Layout facts

- Rules: `chessops` (GPL-3.0-or-later). chess.js is gone — do not reintroduce it. Chess960 generation is `src/lib/chess/chess960.ts` (Scharnagl 0–959, SP518 = standard).
- There is no `src/workers/stockfish.worker.ts`: the engine script itself is the worker. `src/workers/analysis.worker.ts` + the engine pool (spec §3.3) land with Phase 2.
- `react-chessboard` is pinned to v4 (spec §1). v5 is a breaking rewrite — don't bump casually.
- Migrations in `src/db/migrations` are generated — edit `src/db/schema.ts`, run `npm run db:generate`, then `npm run db:verify`. Exception on record: one hand-corrected line in 0002 (drizzle-kit emits custom types as `"undefined"."citext"` in ALTER statements); if that recurs on future citext ALTERs, correct it the same way with a comment. Schema enums are literal (drizzle-kit runs schema.ts standalone) and pinned to their domain constants by `src/db/schema.test.ts`.
- `src/db/seed/openings.json` is generated-but-committed (hermetic builds); regenerate via `openings:build` when `data/chess-openings/*.tsv` change — the script hard-fails if any PGN stops replaying.

## Testing expectations

New eval/classification/rating logic needs unit tests pinned to spec numbers. Rules-engine claims get cross-implementation verification where possible (see `perft960.test.ts`: chessops vs Stockfish `go perft` on identical FENs). Gate evidence lives in README.md — update it when gates are re-run on new infrastructure. Playwright drives `/engine-check` for anything needing a real browser + real engine; unit tests never touch the WASM engine except through the Node child-process harness.
