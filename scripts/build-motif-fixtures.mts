/**
 * C4 fixture-suite builder: harvests curated per-motif positions from the
 * Lichess puzzle database (C6 — theme tags are the label source) plus
 * handcrafted cases for motifs puzzles cannot express, freezing them into
 * src/lib/motifs/fixtures.json.
 *
 * Puzzle semantics: FEN = position before the SETUP move; Moves[0] is the
 * blunder; Moves[1..] is the crowd+engine-verified refutation — exactly the
 * detector's input shape.
 *
 * Curation rules (transparent, per C4 "curated"):
 *  - quality floor: popularity ≥ 90, ≥ 800 plays;
 *  - a geometric PRE-FILTER per motif (built from the primitives, not the
 *    full ranking) that confirms the theme's mechanism is actually present;
 *  - acceptance requires the expected motif to rank 1 under C2.4 — dual-
 *    mechanism puzzles (e.g. a fork that is also a clean hang) are excluded
 *    rather than fighting the precedence rules;
 *  - per-theme fire rates are REPORTED so weak detectors are visible, not
 *    hidden by selection.
 *
 * Tablebase motifs get real WDL values probed from tablebase.lichess.ovh at
 * build time and frozen into the fixture.
 *
 *   npx tsx scripts/build-motif-fixtures.mts
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { GamePosition } from "../src/lib/chess/position";
import {
  detectMotifs,
  type MotifDetectionInput,
  type MotifName,
} from "../src/lib/motifs/detect";
import {
  defendersOf,
  kingZoneAttackers,
  pinInfo,
  posFromFen,
  sq,
} from "../src/lib/motifs/primitives";

const CSV = path.resolve("data/puzzles-raw/lichess_db_puzzle.csv");
const OUT = path.resolve("src/lib/motifs/fixtures.json");
const PER_MOTIF = 10;

interface PuzzleRow {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  popularity: number;
  plays: number;
  themes: Set<string>;
}

export interface Fixture {
  id: string;
  motif: MotifName;
  source: string;
  themes: string[];
  input: MotifDetectionInput;
}

/** Builds the detector input for a puzzle (setup move = the blunder). */
function toInput(row: PuzzleRow): MotifDetectionInput | null {
  const position = GamePosition.fromFen(row.fen, "standard");
  const moved = position.moveUci(row.moves[0]!);
  if (!moved) return null;
  const fenAfter = position.fen();
  // Refutation replay must be fully legal.
  const probe = GamePosition.fromFen(fenAfter, "standard");
  for (const uci of row.moves.slice(1)) {
    if (!probe.moveUci(uci)) return null;
  }
  return {
    variant: "standard",
    fenBefore: row.fen,
    fenAfter,
    movedUci: moved.uci,
    movedSan: moved.san,
    bestPv: [],
    refutationPv: row.moves.slice(1),
    wpLoss: 35,
    clockMsRemaining: null,
    tbBefore: null,
    tbBeforeHit: false,
    tbAfter: null,
    priorForcingRun: false,
    recentOwnSans: [],
  };
}

function pieceCountOf(fen: string): number {
  return ((fen.split(" ")[0] ?? "").match(/[a-zA-Z]/g) ?? []).length;
}

/**
 * Geometric pre-filters: mechanism presence, independent of full ranking.
 * Specs with `geometricFill` run their geometry DURING the scan so their
 * candidate buckets only hold qualifying rows (the mechanisms too rare to
 * find through theme tags alone).
 */
const HARVEST: {
  motif: MotifName;
  themes: string[];
  prefilter?: (row: PuzzleRow, input: MotifDetectionInput) => boolean;
  geometricFill?: (row: PuzzleRow) => boolean;
}[] = [
  { motif: "HANGING_PIECE", themes: ["hangingPiece"] },
  { motif: "FORK_ALLOWED", themes: ["fork"] },
  { motif: "SKEWER_ALLOWED", themes: ["skewer"] },
  { motif: "BACK_RANK", themes: ["backRankMate"] },
  { motif: "DISCOVERED_ATTACK_MISSED", themes: ["discoveredAttack"] },
  { motif: "TRAPPED_PIECE", themes: ["trappedPiece"] },
  { motif: "REMOVING_THE_DEFENDER", themes: ["capturingDefender", "deflection"] },
  {
    motif: "OVERLOADED_DEFENDER",
    themes: ["deflection", "capturingDefender", "sacrifice", "crushing"],
    geometricFill: (row) => {
      // Overload shape: ref[0] and ref[2] capture; the forced reply's piece
      // defended both capture squares in the post-blunder position.
      if (row.moves.length < 4) return false;
      try {
        const position = GamePosition.fromFen(row.fen, "standard");
        if (!position.moveUci(row.moves[0]!)) return false;
        const afterFen = position.fen();
        const after = posFromFen(afterFen);
        const mover = after.turn === "white" ? "black" : "white"; // blunderer
        const [r0, r1, r2] = row.moves.slice(1);
        const r0to = sq(r0!.slice(2, 4));
        const r2to = sq(r2!.slice(2, 4));
        if (!after.board.occupied.has(r0to)) return false;
        const defender = sq(r1!.slice(0, 2));
        const piece = after.board.get(defender);
        if (!piece || piece.color !== mover) return false;
        return (
          defendersOf(after.board, r0to, mover).has(defender) &&
          defendersOf(after.board, r2to, mover).has(defender)
        );
      } catch {
        return false;
      }
    },
  },
  {
    motif: "PINNED_PIECE_MOVED",
    themes: [], // any theme — the geometry is the filter
    geometricFill: (row) => {
      if (row.moves.length < 2) return false;
      try {
        const before = posFromFen(row.fen);
        const from = sq(row.moves[0]!.slice(0, 2));
        const pin = pinInfo(before, from);
        if (!pin.pinned || pin.behind === null) return false;
        // The refutation's first move must capture the piece behind the pin.
        return sq(row.moves[1]!.slice(2, 4)) === pin.behind;
      } catch {
        return false;
      }
    },
  },
  {
    motif: "KING_SAFETY_COLLAPSE",
    themes: ["exposedKing", "kingsideAttack", "attackingF2F7", "queensideAttack"],
    geometricFill: (row) => {
      if (row.moves.length < 2) return false;
      try {
        const before = posFromFen(row.fen);
        const mover = before.turn;
        const position = GamePosition.fromFen(row.fen, "standard");
        if (!position.moveUci(row.moves[0]!)) return false;
        const after = posFromFen(position.fen());
        return kingZoneAttackers(after, mover) - kingZoneAttackers(before, mover) >= 2;
      } catch {
        return false;
      }
    },
  },
  {
    motif: "MATERIALISM",
    themes: ["crushing", "sacrifice"],
    prefilter: (row, input) => {
      // Setup move was a greedy capture.
      return input.movedSan.includes("x");
    },
  },
  {
    motif: "PAWN_STRUCTURE_COLLAPSE",
    themes: [], // any theme — structural damage is the filter
    geometricFill: (row) => {
      if (row.moves.length < 3) return false;
      try {
        const before = posFromFen(row.fen);
        const mover = before.turn;
        const replay = GamePosition.fromFen(row.fen, "standard");
        for (const uci of row.moves.slice(0, 3)) {
          if (!replay.moveUci(uci)) return false;
        }
        const end = posFromFen(replay.fen());
        const defects = (pos: ReturnType<typeof posFromFen>) => {
          const pawns = pos.board.pawn.intersect(pos.board[mover]);
          const files = new Array(8).fill(0) as number[];
          for (const pawn of pawns) files[pawn % 8]!++;
          let count = 0;
          for (let file = 0; file < 8; file++) {
            const n = files[file]!;
            if (n >= 2) count += n - 1;
            if (n > 0 && (file === 0 ? 0 : files[file - 1]!) === 0 && (file === 7 ? 0 : files[file + 1]!) === 0) count++;
          }
          return count;
        };
        return defects(end) - defects(before) >= 2;
      } catch {
        return false;
      }
    },
  },
  {
    motif: "ENDGAME_TECHNIQUE",
    themes: ["pawnEndgame", "rookEndgame", "knightEndgame", "bishopEndgame", "queenEndgame"],
    prefilter: (row) => pieceCountOf(row.fen) <= 7,
  },
  {
    motif: "OPPOSITION_LOST",
    themes: ["pawnEndgame"],
    prefilter: (row, input) => {
      if (pieceCountOf(row.fen) > 5) return false;
      const board = row.fen.split(" ")[0] ?? "";
      if (!/^[kpKP1-8/]+$/.test(board)) return false;
      try {
        const before = posFromFen(input.fenBefore);
        return before.board.king.has(sq(input.movedUci.slice(0, 2)));
      } catch {
        return false;
      }
    },
  },
  {
    motif: "PAWN_RACE_MISCOUNT",
    themes: ["pawnEndgame", "promotion"],
    prefilter: (row, input) => {
      if (pieceCountOf(row.fen) > 7) return false;
      return input.refutationPv.some((uci) => uci.length === 5);
    },
  },
];

const TB_MOTIFS = new Set<MotifName>([
  "ENDGAME_TECHNIQUE",
  "OPPOSITION_LOST",
  "PAWN_RACE_MISCOUNT",
]);

const CATEGORY_WDL: Record<string, number> = {
  win: 2,
  "maybe-win": 2,
  "cursed-win": 1,
  draw: 0,
  "blessed-loss": -1,
  "maybe-loss": -2,
  loss: -2,
};

async function probeTb(fen: string): Promise<{ wdl: number; dtz: number | null } | null> {
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const response = await fetch(
      `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen.replaceAll(" ", "_"))}`,
      { headers: { Accept: "application/json" } }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { category?: string; dtz?: number | null };
    const wdl = body.category !== undefined ? CATEGORY_WDL[body.category] : undefined;
    return wdl === undefined ? null : { wdl, dtz: body.dtz ?? null };
  } catch {
    return null;
  }
}

async function main() {
  const candidates = new Map<MotifName, PuzzleRow[]>();
  for (const spec of HARVEST) candidates.set(spec.motif, []);
  // Geometry-qualified buckets need fewer candidates (already mechanism-true).
  const capFor = (spec: (typeof HARVEST)[number]) => (spec.geometricFill ? 60 : 400);
  const SCAN_CAP = 3_000_000;

  const reader = createInterface({ input: createReadStream(CSV), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of reader) {
    if (lines++ === 0) continue; // header
    if (lines > SCAN_CAP) break;
    if (HARVEST.every((spec) => candidates.get(spec.motif)!.length >= capFor(spec))) break;
    const cols = line.split(",");
    const [id, fen, moves, rating, rd, popularity, plays, themes] = cols;
    if (!id || !fen || !moves || !themes) continue;
    void rd;
    const pop = Number(popularity);
    const nbPlays = Number(plays);
    if (pop < 90 || nbPlays < 800) continue;
    const themeSet = new Set(themes.split(" "));
    const row: PuzzleRow = {
      id,
      fen,
      moves: moves.split(" "),
      rating: Number(rating),
      popularity: pop,
      plays: nbPlays,
      themes: themeSet,
    };
    for (const spec of HARVEST) {
      const bucket = candidates.get(spec.motif)!;
      if (bucket.length >= capFor(spec)) continue;
      if (spec.themes.length > 0 && !spec.themes.some((theme) => themeSet.has(theme))) continue;
      if (spec.geometricFill && !spec.geometricFill(row)) continue;
      bucket.push(row);
    }
    if (lines % 500_000 === 0) console.log(`…scanned ${lines} rows`);
  }
  reader.close();
  console.log(`scanned ${lines} puzzle rows`);

  const fixtures: Fixture[] = [];
  const report: string[] = [];

  for (const spec of HARVEST) {
    const bucket = candidates.get(spec.motif)!;
    let inspected = 0;
    let mechanismPresent = 0;
    let accepted = 0;
    for (const row of bucket) {
      if (accepted >= PER_MOTIF) break;
      inspected++;
      let input: MotifDetectionInput | null;
      try {
        input = toInput(row);
      } catch {
        continue;
      }
      if (!input) continue;
      if (spec.prefilter && !spec.prefilter(row, input)) continue;

      if (TB_MOTIFS.has(spec.motif)) {
        if (pieceCountOf(input.fenBefore) > 7 || pieceCountOf(input.fenAfter) > 7) continue;
        const before = await probeTb(input.fenBefore);
        const after = await probeTb(input.fenAfter);
        if (!before || !after) continue;
        input.tbBefore = before;
        input.tbBeforeHit = true;
        input.tbAfter = after;
        // The blunder must actually degrade the tablebase result.
        const cls = (wdl: number) => (wdl >= 2 ? 2 : wdl <= -2 ? 0 : 1);
        if (cls(-after.wdl) >= cls(before.wdl)) continue;
      }

      const detections = detectMotifs(input);
      if (detections.some((d) => d.motif === spec.motif)) mechanismPresent++;
      if (detections[0]?.motif !== spec.motif) continue;
      accepted++;
      fixtures.push({
        id: `${spec.motif.toLowerCase()}-${accepted}`,
        motif: spec.motif,
        source: `lichess-puzzle:${row.id}`,
        themes: [...row.themes],
        input,
      });
    }
    report.push(
      `${spec.motif.padEnd(26)} candidates=${bucket.length} inspected=${inspected} mechanismFired=${mechanismPresent} accepted=${accepted}`
    );
  }

  // --- Handcrafted fixtures for motifs puzzles cannot express ---

  const crafted: Fixture[] = [];
  const craft = (
    motif: MotifName,
    id: string,
    input: Partial<MotifDetectionInput> & Pick<MotifDetectionInput, "fenBefore" | "fenAfter" | "movedUci" | "movedSan">
  ) => {
    crafted.push({
      id,
      motif,
      source: "handcrafted",
      themes: [],
      input: {
        variant: "standard",
        bestPv: [],
        refutationPv: [],
        wpLoss: 35,
        clockMsRemaining: null,
        tbBefore: null,
        tbBeforeHit: false,
        tbAfter: null,
        priorForcingRun: false,
        recentOwnSans: [],
        ...input,
      },
    });
  };

  // ZWISCHENZUG_MISSED: natural recapture instead of a forcing in-between
  // move. The recapture itself must be sound (else HANGING correctly outranks
  // it) — the loss is the missed extra, so the refutation is quiet.
  craft("ZWISCHENZUG_MISSED", "zwischenzug-1", {
    // White knight just captured on d5; Black recaptures exd5 at once,
    // missing ...Bb4+ first (d2 is vacated, so it really checks).
    fenBefore: "rnbqkb1r/ppp2ppp/4p3/3N4/3P4/8/PPP1PPPP/R1BQKBNR b KQkq - 0 4",
    fenAfter: "rnbqkb1r/ppp2ppp/8/3p4/3P4/8/PPP1PPPP/R1BQKBNR w KQkq - 0 5",
    movedUci: "e6d5",
    movedSan: "exd5",
    bestPv: ["f8b4", "c1d2", "e6d5"],
    refutationPv: ["g1f3"],
    playedIsRecapture: true,
  });
  craft("ZWISCHENZUG_MISSED", "zwischenzug-2", {
    // White bishop just captured on c6; ...Nxc6 at once misses ...Qa5+ first
    // (the a5–e1 diagonal is open; a piece recapture keeps the pawns intact).
    fenBefore: "rn1qkbnr/pp2pppp/2B5/4P3/3P4/8/PPP2PPP/RNBQK1NR b KQkq - 0 5",
    fenAfter: "r2qkbnr/pp2pppp/2n5/4P3/3P4/8/PPP2PPP/RNBQK1NR w KQkq - 1 6",
    movedUci: "b8c6",
    movedSan: "Nxc6",
    bestPv: ["d8a5", "b1c3", "b8c6"],
    refutationPv: ["g1f3"],
    playedIsRecapture: true,
  });

  // PREMATURE_ATTACK: launching at the king with the army asleep. The
  // refutation is developing, not winning material — nothing hangs.
  craft("PREMATURE_ATTACK", "premature-1", {
    fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    fenAfter: "rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2",
    movedUci: "d1h5",
    movedSan: "Qh5",
    refutationPv: ["b8c6", "f1c4", "g7g6"],
    wpLoss: 22,
  });
  craft("PREMATURE_ATTACK", "premature-2", {
    fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5Q2/PPPP1PPP/RNB1KBNR b KQkq - 1 2",
    movedUci: "d1f3",
    movedSan: "Qf3",
    refutationPv: ["g8f6"],
    wpLoss: 20,
  });

  // PASSIVITY: quiet retreats draining mobility; refutation quiet too.
  craft("PASSIVITY", "passivity-1", {
    // Knight retreat with the run-level mobility trend supplied by the
    // adapter (the single-move delta is noisy in openings).
    fenBefore: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 0 4",
    fenAfter: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 1 5",
    movedUci: "f6g8",
    movedSan: "Ng8",
    refutationPv: ["e1g1"],
    recentOwnSans: ["a6", "h6", "Ng8"],
    runMobility: { start: 33, end: 29 },
    wpLoss: 14,
  });
  craft("PASSIVITY", "passivity-2", {
    fenBefore: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 4",
    fenAfter: "r1bqk1nr/pppp1ppp/2n5/2b1p3/4P3/3P1N2/PPP2PPP/RNBQKB1R b KQkq - 1 4",
    movedUci: "c4f1",
    movedSan: "Bf1",
    refutationPv: ["g8f6"],
    recentOwnSans: ["a3", "h3", "Bf1"],
    wpLoss: 13,
  });

  // TIME_PRESSURE / TUNNEL_VISION: data-computed, synthetic by definition.
  craft("TIME_PRESSURE", "timepressure-1", {
    fenBefore: "r4rk1/ppp2ppp/2n5/3p4/3P4/2N5/PPP2PPP/R4RK1 w - - 0 12",
    fenAfter: "r4rk1/ppp2ppp/2n5/3p4/3P4/2N4P/PPP2PP1/R4RK1 b - - 0 12",
    movedUci: "h2h3",
    movedSan: "h3",
    clockMsRemaining: 6_000,
    wpLoss: 21,
  });
  craft("TIME_PRESSURE", "timepressure-2", {
    fenBefore: "r4rk1/ppp2ppp/2n5/3p4/3P4/2N5/PPP2PPP/R4RK1 b - - 0 12",
    fenAfter: "r4rk1/ppp2pp1/2n4p/3p4/3P4/2N5/PPP2PPP/R4RK1 w - - 0 13",
    movedUci: "h7h6",
    movedSan: "h6",
    clockMsRemaining: 9_500,
    wpLoss: 24,
  });
  craft("TUNNEL_VISION_POST_FORCING", "tunnelvision-1", {
    fenBefore: "r4rk1/ppp2ppp/2n5/3p4/3P4/2N5/PPP2PPP/R4RK1 w - - 0 12",
    fenAfter: "r4rk1/ppp2ppp/2n5/3p4/P2P4/2N5/1PP2PPP/R4RK1 b - - 0 12",
    movedUci: "a2a4",
    movedSan: "a4",
    priorForcingRun: true,
    wpLoss: 20,
  });
  craft("TUNNEL_VISION_POST_FORCING", "tunnelvision-2", {
    fenBefore: "2r2rk1/pp3ppp/8/3p4/3P4/8/PP3PPP/2R2RK1 b - - 0 16",
    fenAfter: "2r2r1k/pp3ppp/8/3p4/3P4/8/PP3PPP/2R2RK1 w - - 1 17",
    movedUci: "g8h8",
    movedSan: "Kh8",
    priorForcingRun: true,
    wpLoss: 18,
  });

  // Validate every handcrafted fixture ranks as intended before freezing.
  const craftedValid: Fixture[] = [];
  for (const fixture of crafted) {
    const detections = detectMotifs(fixture.input);
    if (detections[0]?.motif === fixture.motif) {
      craftedValid.push(fixture);
    } else {
      report.push(
        `HANDCRAFT REJECT ${fixture.id}: expected ${fixture.motif}, got ${detections
          .map((d) => d.motif)
          .join(",")}`
      );
    }
  }

  const all = [...fixtures, ...craftedValid];
  writeFileSync(OUT, JSON.stringify(all, null, 1));
  console.log("\n--- harvest report ---");
  for (const line of report) console.log(line);
  console.log(`\nwrote ${all.length} fixtures (${fixtures.length} harvested + ${craftedValid.length} handcrafted) → ${OUT}`);
}

await main();
