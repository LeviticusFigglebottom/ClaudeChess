# GAMBIT — working notes for agents

Read `docs/SPEC.md` before changing anything. It governs every decision; phase gates are falsifiable and must not be skipped. Current status: **Phase 0 complete and gate-verified. Next: Phase 1 (play vs bot), which ends at the bot-calibration gate — the one the spec says you will want to skip. Don't.**

## Commands

```bash
npm run dev          # dev server (localhost:3000)
npm test             # vitest — 57 tests, includes perft(4) (~10s)
npm run build        # production build (lint + typecheck included)
npm run gate         # Phase 0 gate, headless vs http://localhost:3000 (needs `npm run start` first)
npm run gate -- --url <url>   # gate vs a deployed preview
npm run db:generate  # drizzle-kit generate after editing src/db/schema.ts
npm run engine:fetch # re-fetch Stockfish WASM into public/engine (postinstall does this)
```

## Invariants — violating any of these is a bug

1. **POV normalization happens exactly once.** Raw `EngineInfo` (and everything in `src/lib/engine`) speaks side-to-move POV, as UCI does. `src/lib/eval/pov.ts` is the only conversion point to White-POV. Never add a compensating negation anywhere else; if signs look wrong, the bug is at a call site bypassing `normalizeInfo`. DB stores White-POV cp/mate; win probabilities are mover-POV.
2. **UCI strings never leave `src/lib/engine`.** The rest of the app talks to `EngineClient` (spec §3.2) only.
3. **Never classify on raw centipawns** — convert through `winProb` first (spec §4.1). Classification thresholds live in `src/lib/eval/classify.ts` and are pinned by tests.
4. **Original trainers ship flag-gated, default off** (`src/lib/flags`, spec §9). The clone half must remain shippable with all flags off.
5. **Don't invent abstractions for the clone layer** (spec §0). Boring libraries, wired directly.
6. **Cross-origin isolation must hold** (`next.config.ts` COOP/COEP). Any new external resource (image, font, embed) must be self-hosted or proxied — COEP blocks it otherwise. If `/engine-check` shows red on a deploy, fix that before any feature work.
7. **Glicko-2 updates are batched per rating period** (12 games / 7 days), never per game (spec §7).

## Layout facts (where things deviate from spec §2, and why)

- Engine binaries: `public/engine/` is **gitignored**; `scripts/fetch-engine.mjs` (postinstall) fetches Stockfish 18 Lite (multi-threaded + single-threaded fallback) from the npm CDN with pinned sha256. The npm `stockfish` package is NOT a dependency (its tarball is ~250MB).
- There is no `src/workers/stockfish.worker.ts`: the engine script itself is the worker; the multithreaded emscripten build spawns its own pthread sub-workers. `src/workers/analysis.worker.ts` + the engine pool (spec §3.3) land with Phase 2, which is what exercises them.
- `react-chessboard` is pinned to v4 (spec §1). v5 is a breaking rewrite — don't bump casually.
- Migrations in `src/db/migrations` are generated — edit `src/db/schema.ts` and run `npm run db:generate`; never hand-edit generated SQL.

## Testing expectations

New eval/classification/rating logic needs unit tests pinned to spec numbers (see existing tests for the pattern). The Phase 0 gate evidence lives in README.md — update it if you re-run gates on new infrastructure. Playwright drives the `/engine-check` page for anything that needs a real browser + real engine; unit tests never touch the WASM.
