# GAMBIT — Addendum B

**Extends:** `GAMBIT_BOOTSTRAP.md`, `GAMBIT_ADDENDUM_A.md`
**Status:** Phase 0.5 accepted, all six gates verified. This document adjudicates the Phase 0.5 pushback, closes remaining gaps, and specifies the presentation layer.

---

## B0. Adjudication of Phase 0.5 findings

Numbering follows the Phase 0.5 report.

**B0.1 — Tablebase: ACCEPTED, as argued.** Do not overwrite `evalAfterCp`. The reasoning is correct and the consequence is worse than stated: §9.1's calibration curve compares a human's predicted win probability against the engine's, and a fabricated 0/50/100 cliff at the 7-piece boundary would score the user as badly miscalibrated precisely where they were right. §4.5's volatility weighting would also read the synthetic cliff as genuine sharpness and overweight it.

Add to `plies`: `tbWdl` (−2..2), `tbDtz`, `tbHit` (boolean), `tbProbedAt`. Classification and win-probability functions consult tablebase when `tbHit`; the eval graph plots engine cp and marks the tablebase region with a distinct treatment rather than a value jump. Land the columns before Phase 2 writes rows.

**B0.2 — `UCI_Chess960` is per-instance: ACCEPTED.** The addendum was wrong. Downstream consequence not yet surfaced: the §3.3 engine pool must **partition workers by variant**, or a mixed import (standard + 960 in one batch) will thrash re-initializing. Partition the job queue by variant and maintain a pool per active variant, capped in total. Phase 2 concern; note it in `CLAUDE.md` now.

**B0.3 — ECO build-time DB assumption: ACCEPTED.** Vercel builds have no database. Compile-to-committed-dataset plus idempotent seed is correct and hermetic. Signed off.

**B0.4 — `llmCostCents` → millicents: ACCEPTED, and change it now.** Flagging it and leaving it as-is was the wrong call — the table is empty, this is free today and a data migration later. Go further than proposed: store `llmInputTokens`, `llmOutputTokens`, `llmCostMicros`, and `model`. Token counts are stable facts; cost is a function of pricing that will change under you. Recording both means §A3.8's affordability question stays answerable after a repricing.

**B0.5 — Tab-blur scoped and disclosed: ACCEPTED, extended.** Correct instinct. One addition that turns a defensive measure into a differentiator: make every fair-play signal **visible to the user about themselves**, in their own account. chess.com's system is a black box that occasionally bans people with no explanation, which is its single most-resented property. Showing a player their own engine-correlation and timing distributions is more honest, costs nothing extra, and doubles as a §9.3 input the player actually wants.

**B0.6 — cm-chess rationale overstated: ACCEPTED, no action.** Correct.

**B0.7 — Repo `LICENSE` file: APPROVED.** Add `LICENSE` at root, GPL-3.0-or-later. Stockfish is bundled and chessops is compiled into the bundle; the combined work is already GPL-3 whether or not the file exists. Adding it makes the repo's state honest rather than changing it.

**B0.8 — Migration 0002 hand-edit: accepted, but it needs a guard.** A hand-corrected line survives only until the next `drizzle-kit generate` re-emits `"undefined"."citext"` into a new migration, at which point invalid SQL ships silently. Add a post-generate script that rewrites the pattern, plus a test asserting no migration file contains `"undefined".`. Documenting the exception in `CLAUDE.md` is necessary but not sufficient.

**B0.9 — Perft methodology: credited.** Cross-implementation agreement against Stockfish's own `go perft` under `UCI_Chess960`, on doctored castle-ready reductions, is a stronger validation than a reference table would have been, and correctly identified that no reference table exists for those positions. Keep `perft960.test.ts` permanently in CI.

**B0.10 — Performance drift: investigate cheaply.** Depth-20 startpos moved 1062ms → 1636ms between Phase 0 and Phase 0.5. Most likely container load, but the facade sits in no part of that path, so it should not have moved at all. Record the number on every gate run and fail the gate above 2500ms. Discovering a 50% engine regression at Phase 2 scale, across an 80-ply batch job, is expensive.

---

## B1. Remaining gaps

**B1.1 — Board component: stay on `react-chessboard` for Phase 1.** chessops is explicitly compatible with chessground, which is what Lichess uses and which handles drop moves for Crazyhouse. That makes chessground the coherent long-term pair. It does not justify a second library swap in consecutive phases. Revisit only if `FF_VARIANTS` ships Crazyhouse; standard and 960 are pure FEN and react-chessboard handles both.

**B1.2 — Puzzle theme ↔ motif taxonomy mapping.** §9.2's drill deck pulls Lichess puzzles matching the user's top motifs, but the §9.2 motif enum and Lichess's puzzle `themes` vocabulary are different vocabularies. Write an explicit `MOTIF_TO_PUZZLE_THEMES` map now, while the enum is fresh, and mark motifs with no puzzle equivalent (`PASSIVITY`, `TUNNEL_VISION_POST_FORCING`, `TIME_PRESSURE`) as drill-unavailable rather than silently returning nothing. Blocks Phase 3.

**B1.3 — `users.title` has no grant path.** Either build a minimal admin route or drop the column until there is one. A field only an admin can set, with no admin, is dead schema.

---

## B2. Design direction

### B2.1 The position

chess.com's genuine strengths are polish: piece and board customization with live preview, move animation that feels physical, sound design that carries most of the game's tactility, and classification icons readable at a glance. Its genuine weakness is clutter — interstitials, upsell modals, streak popups, banner ads, three competing calls to action per screen. Lichess is the inverse: uncluttered to the point of being visually anonymous.

**GAMBIT's position: chess.com's polish, Lichess's restraint.** No interstitials, no modal upsells, one primary action per screen.

### B2.2 The thesis

This product is not a game lobby. It is **a diagnostic instrument for your own play** — calibration curves, motif distributions, time-allocation curves. The visual language should come from measurement and from chess's own analytical notation, not from cozy-wooden-board or sleek-dark-gaming.

The structural fact that everything derives from: **every measurement in GAMBIT is a signed deviation from a center.** Evaluation is white-positive/black-negative around 0.00. Calibration error is over- or under-confident around calibrated. Time allocation is too-fast or too-slow around the personal optimum. Motif frequency is over- or under-represented against baseline. The design should encode that, because it's true.

### B2.3 Tokens

**Color.** Built as a bipolar scale with a neutral center rather than a background plus accent. Center tone is drawn from a DGT tournament clock's LCD field — a desaturated grey-green that is unmistakably from chess's own material world.

```
--field      #171A19   analysis surface (ink, faintly green-shifted)
--paper      #E6E7E1   light surface (cool bone — deliberately not cream)
--lcd        #9EAF96   neutral center of every signed axis
--white-adv  #D9DCD2   positive pole
--black-adv  #23282E   negative pole
--flag       #C8452D   clock-flag red
--brilliant  #2FA8A0   the one cool signal
```

`--flag` is the analog clock's falling flag. It appears in exactly two places in the entire product: flagfall, and `BLUNDER`. Its scarcity is what makes it mean something. Any third use is a bug.

**Type.** Invert the normal hierarchy. In chess, notation is the primary text and prose is commentary — so the monospace is the display face and the sans is support.

```
display / notation   Martian Mono   evals, move numbers, ratings, clocks
body / commentary    Inter Tight    prose, coach output, labels
figurine             inline SVG from the user's active piece set
```

Figurine notation rendered from the user's own piece set means the move list is drawn in the pieces they chose. Small, cheap, and nobody does it.

**Signature: the ribbon.** One horizontal signed-axis primitive, one component, used at every scale:

- Beside the board, tall and narrow, as the eval bar
- In §9.1, as the deviation band under the calibration curve
- In §9.3, as the per-move time-misallocation strip across the game
- In §9.2, as motif over/under-representation against baseline
- In the review header, compressed to a single row summarizing the whole game

Spend the boldness here and keep everything around it quiet.

### B2.4 Classification icons — use Informant notation

chess.com invented proprietary icons. Chess already has a annotation vocabulary players have read in books for sixty years, and it is shape-distinct by construction, which satisfies the §A3.7 requirement that classifications differ by shape and not only by color.

```
BRILLIANT   !!      GREAT       !       BEST        ⩲
EXCELLENT   (none)  GOOD        (none)  BOOK        ⌸
INACCURACY  ?!      MISTAKE     ?       BLUNDER     ??
MISS        ⊘
```

Ship a "shape-only" accessibility mode that drops color entirely and keeps the glyphs. In that mode nothing is lost, which is the test of whether the icon set was designed right.

### B2.5 Customization surface

| Axis | Options |
|---|---|
| Board | theme (color pair or texture), coordinates on/off/inside/outside, highlight style |
| Pieces | set, scale |
| Sound | set, master volume, per-event mute |
| Animation | instant / fast / normal / slow |
| Move list | SAN or figurine, single or two-column |
| Eval | bar on/off, cp / win% / both, orientation follows board |
| Accessibility | shape-only classifications, high-contrast board, reduce motion, keyboard move entry |

**Storage.** Anonymous → `localStorage`. Signed in → DB, synced, with `localStorage` as the offline cache. Preferences must survive the anonymous→permanent account conversion in §A2.1 — they're often the first thing a person customizes, before they'd ever consider signing up.

**Licensing.** Piece sets and board textures are not free-floating assets. Source from Lichess's asset repository, which ships many sets with documented licenses (cburnett is CC-BY-SA, and others vary). Record `name`, `author`, `license`, `sourceUrl` per set in a manifest, surface it on `/licenses`, and reject any set into the repo without a manifest entry.

### B2.6 Sound

The most underrated half of chess.com's feel. Required events:

```
move · capture · castle · check · promote · premove-set · illegal
low-time tick · game-start · game-end-win / draw / loss
classification reveal (distinct per class, review only)
```

Constraints: sub-30ms latency from input to audio or it feels broken; preload and decode on first interaction; hard-respect a mute toggle and system reduced-motion as a proxy for reduced-sensory preference; never autoplay before user gesture.

Lichess's sound sets are openly licensed and are the pragmatic default. **A synthesized original set would be the single highest-flair-per-hour thing in this project** — the event list is eleven short sounds, the tonal palette is already yours, and it is the one piece of the product that cannot be attributed to any library.

### B2.7 Motion

```
piece move       140ms  ease-out
capture          incoming arrives, captured fades 80ms
check            king square pulse, 1 cycle, 200ms
premove          distinct highlight, executes instantly on opponent move
eval bar         200ms ease-out, never spring
classification   review only, 120ms stagger down the move list
```

`prefers-reduced-motion` replaces every one of these with an instant state change and no fade. Not a reduced duration — an instant change.

---

## B3. Revised phase order

```
Phase 0     ✅   Phase 0.5  ✅
Phase 1          Bots + Chess960 play. B0 pre-flight rides along.
                 Board/piece/sound/animation system (B2) lands here — Phase 1
                 is where the board gets heavy use and the tokens should exist
                 before that code calcifies.
                 Gate: bot calibration, unchanged.
Phase 1.5        Accounts, anonymous-first, preference sync, challenge links
Phase 2          Import + review. tablebase (B0.1), variant-partitioned pool (B0.2)
Phase 2.5        Analysis board + variation tree
Phase 3          Puzzles + explorer. Requires B1.2 motif↔theme map.
Phase 4          Multiplayer. Premoves, clock semantics, fair-play signals.
Phase 4.5        Variants beyond 960 (FF_VARIANTS), Fairy-Stockfish
Phase 5          Trainers. Still the product.
```
