# GAMBIT — Addendum C

**Extends:** `GAMBIT_BOOTSTRAP.md`, `ADDENDUM_A.md`, `ADDENDUM_B.md`
**Supersedes:** §9.2's LLM classification pipeline, and its 70%-agreement validation gate.

---

## C0. LLM usage policy

The original spec reached for a language model wherever the output was a human teaching concept. That conflated two different things: *deciding* what happened, and *describing* it. Deciding is chess geometry and belongs in code. Describing is prose and is the only place a model is warranted.

Revised policy — a language model is permitted only where the **input** is unstructured natural language, or the **output** is prose whose correctness has already been established by code.

| Use | Verdict |
|---|---|
| §9.2 motif classification | **Removed.** Computed deterministically. See C2. |
| §9.2 explanation text | Permitted — describes an already-proven motif, cannot invent one |
| §9.5 post-mortem | **Required.** Input is the user's free-form prose about their own thinking. No parser handles that. |
| §6 coach commentary | Permitted, optional. Prose by definition. |

Consequence: the LLM can no longer be *wrong about chess*. It can only be wrong about wording, over a mechanism that was proven before the call was made. That removes the failure mode where a confident fabricated motif sends the user drilling a weakness they don't have.

Second consequence: the §9.2 gate changes from "hand-label 50 blunders, floor 70% agreement" to a unit-tested detector suite. Detection becomes verifiable rather than sampled.

---

## C1. Account and import model

One pipeline, two sources.

- Games played in GAMBIT write to `games` and `plies` at completion, `source: 'local' | 'online'`.
- Import backfills chess.com and Lichess history into the same tables, `source: 'chesscom' | 'lichess'`, deduplicated on `(source, externalId)`.
- Import is re-runnable and incremental: track `lastImportedAt` per source per user, request only newer archives. Optional weekly cron.
- All §9 trainers query the union, filtered by `variant` per A1.4. A `source` filter is offered in the UI but defaults to off — a blunder is a blunder regardless of which site hosted it.

Not a live sync. chess.com's public API serves monthly archives over REST with no push mechanism; polling is the only option available and hourly would be abusive. Daily or weekly is correct.

---

## C2. Deterministic motif detection

### C2.1 The core idea

A motif is not a property of the position. It is a property of the **refutation** — the engine's punishing line after the mistake. Run analysis at the blunder ply to get:

```
posBefore        position before the user's move
movePlayed       what they played
posAfter         position after
refutationPv     opponent's best line from posAfter (MultiPV 1, depth 18)
bestPv           what the user should have played (pv1 from posBefore)
```

Motifs are then patterns over `refutationPv` combined with board geometry from `posBefore`/`posAfter`. Every rule below is decidable.

### C2.2 Primitives

chessops supplies bitboard attack generation, ray and between geometry, and SquareSet operations. Build these on top, in `src/lib/motifs/primitives.ts`:

```ts
attackersOf(pos, square, color): SquareSet
defendersOf(pos, square, color): SquareSet     // attackersOf for the owning side
see(pos, move): number                          // static exchange evaluation, centipawns
pinInfo(pos, square): { pinned: boolean; behind: Square | null; pinner: Square | null }
  // remove piece at `square`, test whether an enemy slider then attacks a
  // higher-value piece along ray(pinner, square). Absolute pin if behind is the king.
discoveredBy(pos, move): { attacker: Square; target: Square } | null
  // moving off ray(behind, target) reveals `behind`'s attack on `target`
mobility(pos, color): number                    // legal move count, for activity deltas
kingZoneAttackers(pos, color): number           // weighted attacker count on the 3x3 king zone plus advance squares
safeSquares(pos, square): SquareSet             // destinations where see >= 0 and not undefended-attacked
isForcing(move, pos): boolean                   // check, capture, or promotion
```

`see` is the standard swap-off algorithm: repeatedly take the least valuable attacker, alternating sides, return the net material. It is the single most load-bearing primitive here — it decides "hanging" versus "defended" without guessing.

### C2.3 Motif rules

Each detector is a pure predicate returning `{ fired: boolean; confidence: number; evidence: Evidence }`. Evidence carries the squares and PV indices that triggered it, which C3 renders.

**Tablebase-proven** (`confidence 1.0` — exact, not inferred)

- `ENDGAME_TECHNIQUE` — `tbHit` on both plies and WDL degraded (win→draw, win→loss, draw→loss).
- `OPPOSITION_LOST` — as above, `pieceCount <= 5`, king-and-pawn only, and the move played was a king move.
- `PAWN_RACE_MISCOUNT` — as above, both sides have passed pawns, and the refutation is a promotion race.

**Mate-proven** (`0.95`)

- `BACK_RANK` — refutation ends in mate; the mating square is on the king's own back rank; the king's forward escape squares are occupied by its own pawns.
- Generic mate patterns that aren't back-rank fall through to whichever other detector fires; mate alone is not a motif.

**SEE-proven** (`0.9`)

- `HANGING_PIECE` — a piece of yours on square S has `attackersOf(them, S)` non-empty, `see` of their capture on S is positive, `defendersOf(you, S)` is **empty**, and `refutationPv[0]` captures on S.
- `MATERIALISM` — your move was a capture, `wpLoss >= 20`, and no material is recovered anywhere in the refutation. You took the pawn and the position collapsed.

**Geometric** (`0.85`)

- `OVERLOADED_DEFENDER` — identify the piece D that moves at `refutationPv[1]` (your forced reply). If, in `posAfter`, D was a defender of both the square captured at `refutationPv[0]` **and** the square captured at `refutationPv[2]`, D was overloaded. This is the mechanism, read directly out of the line.
- `REMOVING_THE_DEFENDER` — `refutationPv[0]` captures or deflects a piece that was in `defendersOf` a square captured later in the line.
- `PINNED_PIECE_MOVED` — `pinInfo(posBefore, from).pinned` is true for the piece you moved, and `refutationPv[0]` captures the piece behind it on the pin ray.
- `FORK_ALLOWED` — `refutationPv[0]` lands on square F where `attacks(F)` hits two or more of your pieces of value ≥ knight (or your king plus anything), each with `see >= 0` for the attacker.
- `SKEWER_ALLOWED` — `refutationPv[0]` attacks along a ray hitting P1 then P2 with `value(P1) > value(P2)`, and P1 is forced to move.
- `DISCOVERED_ATTACK_MISSED` — `discoveredBy(refutationPv[0])` is non-null and its target is worth more than anything the moving piece threatens directly.
- `TRAPPED_PIECE` — some piece of yours has `safeSquares` empty in `posAfter`, and the refutation wins it within four plies.
- `KING_SAFETY_COLLAPSE` — `kingZoneAttackers` against you rises by ≥ 2 weighted units across your move, and the refutation targets the king zone.

**Data-computed** (`1.0` — read from the record, not inferred)

- `TIME_PRESSURE` — `clockMsRemaining < 15000` and no motif above fires at ≥ 0.7.
- `TUNNEL_VISION_POST_FORCING` — the previous three or more plies were all forcing.

**Heuristic** (`0.6`, the only genuinely soft ones)

- `ZWISCHENZUG_MISSED` — `bestPv[0]` is forcing, the move you played was the natural recapture on the square just captured, and `bestPv` delays that recapture by two or more plies.
- `PREMATURE_ATTACK` — your move raised `kingZoneAttackers` against them while your own back rank still holds two or more undeveloped minor pieces, or your king is uncastled with rights intact.
- `PASSIVITY` — `mobility` for you dropped over a run of three or more non-forcing moves ending at this ply, with no material or structural compensation.

**Fallback**

- `UNCLEAR` — nothing fired at ≥ 0.6. Log the position. A rising `UNCLEAR` rate is the signal that the detector set needs extending, and unlike a model's error rate it points at specific positions you can read.

### C2.4 Precedence and multiplicity

Rank by evidence class: tablebase > mate > SEE > geometric > data-computed > heuristic. Within a class, rank by confidence, then by material at stake.

Store the **top motif plus all others that fired above 0.6** — real blunders are frequently two things at once, and "overloaded defender leading to back-rank mate" is more useful than either alone. `blunder_tags` becomes one row per fired motif with a `rank` column, rather than one primary and one secondary.

---

## C3. Mechanism chains — the depth advantage

chess.com gives one tag per mistake. Because the detectors read the refutation line, GAMBIT can emit the whole causal chain, and it is derived rather than described:

```
Move 24. Nxb6??  (−34 WP)

  OVERLOADED_DEFENDER  →  BACK_RANK

  The knight on d7 was defending both b6 and f6.
  24...Rxb6 deflects it; 25.Nxb6 Qxf6 wins the rook, and with the
  h-pawn unmoved 26...Re1 is mate.

  Evidence: d7 defends {b6, f6} in posAfter · refutation Rxb6 / Nxb6 / Qxf6
            king g1, escape squares f2 g2 h2 all occupied by own pawns
```

Every clause traces to a detector's evidence object. The LLM's only job is turning that structured evidence into a readable sentence — it cannot introduce a mechanism the geometry did not prove, because the mechanism is an input to the call, not an output.

Cache explanations by `(motifChain, evidenceHash)`. The same overload pattern recurs constantly across a user's games and across users, so the cache hit rate should be high and the cost near zero at steady state.

---

## C4. Validation — replacing the hand-labeling gate

The old §9.2 gate asked the user to hand-label 50 blunders and required 70% model agreement. Delete it. Deterministic detectors are unit-testable against known positions, which is stronger and requires no human afternoon.

**Build a fixture suite:** 8–12 curated positions per motif, each a FEN plus the blundering move plus the expected motif, sourced from tactics collections and from Lichess puzzles carrying the corresponding theme tag. Roughly 200 fixtures total.

**Gate:**
- Every fixture returns its expected motif as rank-1. A miss is a bug with a reproducible position, not a statistic.
- `UNCLEAR` rate below 15% on a 500-blunder sample from real imported games.
- No detector fires on more than 40% of blunders — a detector that fires constantly is matching something other than what it names.
- SEE validated against a reference implementation on 1000 random capture positions.

**The user's remaining involvement: reading the `UNCLEAR` sample.** Not labeling, not scoring. If a recurring pattern shows up there, it becomes a new detector. That is a five-minute look at a list, and it is optional.

---

## C5. Revised §9.2 pipeline

```
ply where classification ∈ {MISTAKE, BLUNDER, MISS}
  → analysis already has refutationPv, bestPv, tb data (Phase 2)
  → run all detectors (pure functions, no I/O, sub-millisecond)
  → rank, store every motif above 0.6 into blunder_tags with rank
  → explanation: cache lookup by (motifChain, evidenceHash)
      hit  → done, zero cost
      miss → one LLM call with the proven chain and evidence as input
```

Motif detection now runs entirely inside the Phase 2 analysis pass with no network calls and no per-blunder cost. The drill deck, the motif distribution, and the trend-over-time chart all become available without any LLM involvement at all — explanations are a presentation layer on top of a complete dataset, and the feature degrades to fully functional if the LLM is unavailable.

---

## C6. Amendments to prior addenda

- **B1.2** — `MOTIF_TO_PUZZLE_THEMES` stands, and gains value: the mapping now runs both directions. Lichess theme tags become a fixture source for C4's suite.
- **A2.2 / B0.4** — `usage_counters` LLM projections drop substantially. §9.2 was the dominant cost driver at ~3000 calls per 500-game import; it now costs zero on the detection path and near-zero on explanations after cache warm-up.
- **§9.2's motif enum** — unchanged as a vocabulary, but every member now has a detector or is explicitly marked heuristic. Nothing in the enum is model-judged.
