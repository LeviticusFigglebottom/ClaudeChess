/**
 * Canonical fixtures for the STRUCTURAL detector class — one designed
 * position per motif (plus real-sample additions made separately). Each is
 * verified to fire its motif at RANK 1 before being written; a miss prints
 * the full detection list and fails the build.
 *
 *   npx tsx scripts/build-structural-fixtures.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { GamePosition } from "../src/lib/chess/position";
import { detectMotifs, type MotifDetectionInput } from "../src/lib/motifs/detect";

interface Draft {
  id: string;
  motif: string;
  note: string;
  fenBefore: string;
  movedUci: string;
  bestPv?: string[];
  refutationPv: string[];
  wpLoss: number;
}

const DRAFTS: Draft[] = [
  {
    id: "hole_created-1",
    motif: "HOLE_CREATED",
    note: "g4 gives up the last pawn cover of f4 (no e-pawn); the knight plants there.",
    fenBefore: "6k1/ppp2ppp/6n1/8/8/3P4/PPP2PPP/6K1 w - - 0 20",
    movedUci: "g2g4",
    refutationPv: ["g6f4"],
    wpLoss: 16,
  },
  {
    id: "outpost_conceded-1",
    motif: "OUTPOST_CONCEDED",
    note: "d4 passes e4 by — f5 defends it, no white pawn can ever contest it, and the knight lands.",
    fenBefore: "6k1/ppp3pp/3n4/5p2/8/8/PPPP2PP/6K1 w - - 0 22",
    movedUci: "d2d4",
    refutationPv: ["d6e4"],
    wpLoss: 15,
  },
  {
    id: "bishop_pair_surrendered-1",
    motif: "BISHOP_PAIR_SURRENDERED",
    note: "Bxc6 gives up the pair for a knight in a wide-open position.",
    fenBefore: "2b3k1/pp4pp/2n5/8/8/5B2/PP4PP/2B3K1 w - - 4 18",
    movedUci: "f3c6",
    refutationPv: ["b7c6"],
    wpLoss: 15,
  },
  {
    id: "structure_damaged-1",
    motif: "STRUCTURE_DAMAGED",
    note: "f4 turns e3 into a backward pawn (f-pawn can no longer support it; e4 is enemy-controlled) with nothing in return.",
    fenBefore: "1n4k1/p5pp/8/5p2/8/4P3/P4PPP/1N4K1 w - - 0 19",
    movedUci: "f2f4",
    refutationPv: ["g8f8", "g1f1", "f8e7", "f1e2"],
    wpLoss: 15,
  },
  {
    id: "bad_piece_placement-1",
    motif: "BAD_PIECE_PLACEMENT",
    note: "Nh4 buries the knight on the rim (scope 6 → 3) and the refutation never lets it back.",
    fenBefore: "rnbqkbnr/pppppp1p/6p1/8/8/5N2/PPP1P1PP/RNBQ1RK1 w kq - 0 8",
    movedUci: "f3h4",
    refutationPv: ["g8f6", "a2a3", "f6e4", "a3a4"],
    wpLoss: 15,
  },
  {
    id: "file_opened_toward_own_king-1",
    motif: "FILE_OPENED_TOWARD_OWN_KING",
    note: "f4 steps off the long diagonal — the b7 queen now stares at g2 next to the king.",
    fenBefore: "6k1/pq4pp/8/8/8/5P2/P6P/5RK1 w - - 2 24",
    movedUci: "f3f4",
    refutationPv: ["a7a6"],
    wpLoss: 15,
  },
  {
    id: "space_conceded-1",
    motif: "SPACE_CONCEDED",
    note: "dxc5 trades the last central pawn — c5 and e5 can never be pawn-contested again.",
    fenBefore: "6k1/pp4pp/8/2p5/3P4/8/P6P/6K1 w - - 0 21",
    movedUci: "d4c5",
    refutationPv: ["g8f8"],
    wpLoss: 15,
  },
  {
    id: "good_piece_traded-1",
    motif: "GOOD_PIECE_TRADED",
    note: "The octopus knight on d5 trades itself for the entombed e7 bishop.",
    fenBefore: "4k3/p3b2p/3p1p2/3N4/8/8/P6P/6K1 w - - 6 26",
    movedUci: "d5e7",
    refutationPv: ["e8e7"],
    wpLoss: 15,
  },
  {
    id: "pawn_break_missed-1",
    motif: "PAWN_BREAK_MISSED",
    note: "f5 was the break against e6; after the quiet knight move, ...e5 closes it for good.",
    fenBefore: "6k1/p6p/4p3/8/5P2/8/P6P/1N4K1 w - - 0 23",
    movedUci: "b1c3",
    bestPv: ["f4f5"],
    refutationPv: ["e6e5", "a2a3", "h7h6", "a3a4"],
    wpLoss: 15,
  },
  {
    id: "king_walk-1",
    motif: "KING_WALK",
    note: "Kf1 walks toward the open e-file — zone pressure rises, escape squares drop, pieces still on.",
    fenBefore: "4r1k1/pp4pp/1qn5/2b5/8/8/PP4PP/RN1Q2K1 w - - 4 20",
    movedUci: "g1f1",
    refutationPv: ["b6b4"],
    wpLoss: 16,
  },
  {
    id: "hole_created-2",
    motif: "HOLE_CREATED",
    note: "Black-side: ...b5 gives up the last cover of c6; the e5 knight lands there.",
    fenBefore: "1n4k1/ppp3pp/8/4N3/8/8/PP4PP/6K1 b - - 0 20",
    movedUci: "b7b5",
    refutationPv: ["e5c6"],
    wpLoss: 15,
  },
  {
    id: "outpost_conceded-2",
    motif: "OUTPOST_CONCEDED",
    note: "Black-side: ...f5 passes e5 by — d4 defends it and the f3 knight jumps in.",
    fenBefore: "6k1/pp3pp1/8/8/3P4/5N2/PP4PP/6K1 b - - 0 18",
    movedUci: "f7f5",
    refutationPv: ["f3e5"],
    wpLoss: 15,
  },
  {
    id: "bishop_pair_surrendered-2",
    motif: "BISHOP_PAIR_SURRENDERED",
    note: "Black-side: ...Bxf3 gives up the pair for the knight in an open position.",
    fenBefore: "3b2k1/pp4pp/8/8/6b1/5N2/PP3PPP/6K1 b - - 4 18",
    movedUci: "g4f3",
    refutationPv: ["g2f3"],
    wpLoss: 15,
  },
  {
    id: "structure_damaged-2",
    motif: "STRUCTURE_DAMAGED",
    note: "Black-side: ...f5 makes e6 backward against the f4 pawn, nothing gained.",
    fenBefore: "6k1/p4ppp/4p3/8/5P2/8/P5PP/1N4K1 b - - 0 19",
    movedUci: "f7f5",
    refutationPv: ["g1f2", "g8f7", "f2e3", "f7e7"],
    wpLoss: 15,
  },
  {
    id: "bad_piece_placement-2",
    motif: "BAD_PIECE_PLACEMENT",
    note: "Black-side: ...Na5 rims the knight (scope 6 → 3) with no way back.",
    fenBefore: "r1bqk2r/pppp1ppp/2n2n2/8/8/5N2/PPPP1PPP/RNBQ1RK1 b kq - 0 8",
    movedUci: "c6a5",
    refutationPv: ["d2d4", "h7h6", "f1e1", "d8e7"],
    wpLoss: 15,
  },
  {
    id: "file_opened_toward_own_king-2",
    motif: "FILE_OPENED_TOWARD_OWN_KING",
    note: "Black-side: ...f5 steps off the long diagonal — the b2 queen bears on g7 by the king.",
    fenBefore: "6k1/p6p/5p2/8/8/8/PQ5P/5RK1 b - - 2 24",
    movedUci: "f6f5",
    refutationPv: ["h2h3"],
    wpLoss: 15,
  },
  {
    id: "space_conceded-2",
    motif: "SPACE_CONCEDED",
    note: "Black-side: ...exd4 trades the central pawn — d4 and f4 permanently conceded.",
    fenBefore: "6k1/p6p/8/4p3/3P4/8/P6P/6K1 b - - 0 21",
    movedUci: "e5d4",
    refutationPv: ["g1f2"],
    wpLoss: 15,
  },
  {
    id: "good_piece_traded-2",
    motif: "GOOD_PIECE_TRADED",
    note: "Black-side: the octopus d4 knight trades itself for the hemmed e2 bishop.",
    fenBefore: "4k3/p6p/8/8/3n4/3P1P2/P3B2P/4K3 b - - 6 26",
    movedUci: "d4e2",
    refutationPv: ["e1e2"],
    wpLoss: 15,
  },
  {
    id: "pawn_break_missed-2",
    motif: "PAWN_BREAK_MISSED",
    note: "Black-side: ...b4 was the break against c3; after the quiet knight move, c4 closes it.",
    fenBefore: "1n4k1/p6p/8/1p6/8/2P5/P6P/6K1 b - - 0 23",
    movedUci: "b8c6",
    bestPv: ["b5b4"],
    refutationPv: ["c3c4", "c6e5", "g1f2", "e5d7"],
    wpLoss: 15,
  },
  {
    id: "king_walk-2",
    motif: "KING_WALK",
    note: "Black-side: ...Kf8 walks onto the open e-file's pressure with fewer escapes.",
    fenBefore: "1r4k1/pp4pp/2nb4/8/8/1Q6/PP4PP/RN2R1K1 b - - 4 20",
    movedUci: "g8f8",
    refutationPv: ["b3f3"],
    wpLoss: 15,
  },
];


const path = "src/lib/motifs/fixtures.json";
const fixtures = JSON.parse(readFileSync(path, "utf8")) as { id: string }[];
let failures = 0;
const additions: unknown[] = [];

for (const draft of DRAFTS) {
  const position = GamePosition.fromFen(draft.fenBefore, "standard");
  const move = position.moveUci(draft.movedUci);
  if (!move) {
    console.log(`ILLEGAL move ${draft.movedUci} in ${draft.id}`);
    failures++;
    continue;
  }
  const input: MotifDetectionInput = {
    variant: "standard",
    fenBefore: draft.fenBefore,
    fenAfter: position.fen(),
    movedUci: draft.movedUci,
    movedSan: move.san,
    bestPv: draft.bestPv ?? [],
    refutationPv: draft.refutationPv,
    wpLoss: draft.wpLoss,
    clockMsRemaining: null,
    tbBefore: null,
    tbBeforeHit: false,
    tbAfter: null,
    priorForcingRun: false,
    recentOwnSans: [],
  };
  const detections = detectMotifs(input);
  if (detections[0]?.motif !== draft.motif) {
    console.log(
      `MISS ${draft.id}: expected ${draft.motif}, got [${detections
        .map((d) => `${d.motif}@${d.confidence}`)
        .join(", ")}]`
    );
    failures++;
    continue;
  }
  if (fixtures.some((f) => f.id === draft.id)) {
    console.log(`skip ${draft.id} (exists)`);
    continue;
  }
  additions.push({
    id: draft.id,
    motif: draft.motif,
    source: "handcrafted (structural class)",
    themes: [],
    note: draft.note,
    input,
  });
  console.log(`OK ${draft.id} rank-1 ${draft.motif}`);
}

if (failures > 0) {
  console.log(`\n${failures} drafts failed — nothing written`);
  process.exit(1);
}
writeFileSync(path, JSON.stringify([...fixtures, ...additions], null, 1));
console.log(`\nwrote ${additions.length} fixtures (total ${fixtures.length + additions.length})`);
