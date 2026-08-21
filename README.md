# GAMBIT

A chess.com-parity platform whose *actual* product is a set of trainers that don't exist anywhere else. The clone is infrastructure; the trainers are the point. Full design: [`docs/SPEC.md`](docs/SPEC.md).

## Status: Phase 0 complete ✅

Skeleton + engine (spec §8, Phase 0). Every gate condition verified against a production build (`next build && next start`) driven headlessly in Chromium:

| Gate (spec §8) | Result |
|---|---|
| `crossOriginIsolated === true` | ✅ true (local prod build; **re-verify on the Vercel preview** — see below) |
| Engine reaches depth 20 on startpos < 3s | ✅ **1062ms** — Stockfish 18 Lite WASM **multi-threaded**, 3 threads / 4 cores, ~2 Mnps |
| Sign-normalization unit test | ✅ plus a live engine check: black-to-move losing position, raw `cp -1130` (side-to-move POV) → White-POV wp 97.5% |
| perft(4) = 197,281 | ✅ (perft 1–4 all pinned in `src/lib/chess/perft.test.ts`) |

Also passing: Glicko-2 vs. Glickman's paper example (1464.06 / 151.52 / 0.05999), classification threshold suite (§4.2–4.4), UCI parser against captured engine output. 57/57 tests.

### Verifying the gate yourself

```bash
npm run build && npm run start &
npm run gate                                   # drives /engine-check headlessly, exits non-zero on failure
npm run gate -- --url https://<preview>.vercel.app   # same, against a deployed preview
```

Or just open **`/engine-check`** in a browser — every row must be green. The deployed-preview run is the one that actually closes the Phase 0 gate (§3.1); the headers are set in `next.config.ts` and apply on Vercel unchanged, but *prove it* on the preview URL before building Phase 1.

## Quick start

```bash
npm install        # postinstall fetches Stockfish WASM (~14.5MB) into public/engine
cp .env.example .env.local   # fill in when Supabase/DB work starts; not needed for Phase 0
npm run dev        # http://localhost:3000 — /play has the board + streaming analysis
npm test           # vitest: perft, POV signs, classification, Glicko-2, accuracy, UCI
```

`crossOriginIsolated` is logged to the console on boot and shown as a badge in the footer. If it ever reads false, stop and fix headers before anything else (spec §3.1).

## What's here

- **Engine** (`src/lib/engine`) — Stockfish 18 Lite (NNUE, multi-threaded WASM) behind the spec §3.2 `EngineClient` contract. UCI strings never leave this module. Single-threaded fallback auto-selected when isolation is missing (and surfaced loudly as a gate failure).
- **Eval** (`src/lib/eval`) — cp→win-prob logistic (§4.1), **the single side-to-move→White-POV normalization boundary** (§3.2 critical note), full move classification (§4.2–4.4: loss bands, BEST, GREAT, BRILLIANT, MISS, BOOK hook), accuracy + volatility weighting (§4.5), analysis presets (§4.6).
- **Chess utils** (`src/lib/chess`) — FEN helpers, static material count (feeds §4.3 sacrifice detection), perft, UCI-PV→SAN rendering.
- **Rating** (`src/lib/rating`) — Glicko-2 per the paper; τ=0.5; batch-per-period by design (wiring in Phase 1).
- **Flags** (`src/lib/flags`) — all six §9 trainer flags, env-driven, default off.
- **DB** (`src/db`) — full §5 Drizzle schema (10 tables, `plies` is the canonical analysis record) + generated SQL migration, including the partial index on MISTAKE/BLUNDER plies. Lazy Postgres client; nothing needs a live DB yet.
- **UI** — `/play`: free board (react-chessboard v4 + chess.js legality), drag **and** tap-tap input (§10 mobile), last-move/legal-target highlights, streaming depth-18 MultiPV-3 analysis with White-POV evals, eval bar, move list. `/engine-check`: the gate diagnostic page.

## Deliberate deviations from the spec (all boring-in-spirit)

1. **Engine binaries are fetched, not vendored**: the `stockfish` npm tarball is ~250MB (bundles 113MB full-net builds). `scripts/fetch-engine.mjs` (postinstall) pulls exactly the 4 lite-build files from the npm CDN with pinned sha256 hashes into `public/engine/` (gitignored). Stockfish **18** Lite is the current NNUE multi-threaded successor of the spec's `stockfish.wasm`.
2. **No `/src/workers/stockfish.worker.ts` wrapper**: the engine script itself is the worker (`new Worker('/engine/stockfish-18-lite.js')`) — it spawns its own pthread sub-workers. Wrapping it in a bundled TS worker adds a fragile layer to the highest-risk item for zero benefit; the §3.2 contract and UCI containment live in `src/lib/engine` instead. `analysis.worker.ts` (batch orchestration) arrives with Phase 2, where it has a job.
3. **Engine pool (§3.3) deferred to Phase 2** with the batch review pipeline that exercises it — no dead untested code in Phase 0.
4. **react-chessboard pinned to v4.7.3** per spec (v5 is a breaking rewrite; revisit only with a reason).

## Roadmap (spec §8)

- **Phase 1 — next**: play vs Tier-A bots (shallow-good/deep-bad sampling, §6), clocks, Glicko-2 wiring. Stops at the bot calibration gate (±75 Elo over ≥200 self-play games per band). *That gate is the one to not skip.*
- Phase 2: chess.com/Lichess import + batch review pipeline populating `plies`.
- Phase 3: puzzles + opening explorer proxy.
- Phase 4: multiplayer (Supabase Realtime, server-authoritative clock).
- Phase 5: the five trainers, flag-gated (§9) — the reason this repo exists.
