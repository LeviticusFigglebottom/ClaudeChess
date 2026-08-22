/**
 * Fixtures for the FORGONE detector class (Task 3) — the MISSED_ motifs
 * detected by running the existing geometric predicates against bestPv.
 * Eight white-side drafts are auto-mirrored to black (vertical flip +
 * color swap); MISSED_ZWISCHENZUG gets one white-side draft (the two
 * existing harvested fixtures are both black-side). Every fixture is
 * verified rank-1 before writing; a miss prints the detection list and
 * fails the build.
 *
 *   npx tsx scripts/build-forgone-fixtures.mts
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
  bestPv: string[];
  refutationPv: string[];
  wpLoss: number;
  bestEvalCp: number;
  playedIsRecapture?: boolean;
  mirror?: boolean; // default true — auto-generate the black-side twin
}

const DRAFTS: Draft[] = [
  {
    id: "missed_fork-1",
    motif: "MISSED_FORK",
    note: "Nc7+ forks king and rook; the quiet king move lets the knight moment pass.",
    fenBefore: "r3k3/p6p/8/3N4/8/8/P6P/6K1 w - - 4 30",
    movedUci: "g1f1",
    bestPv: ["d5c7", "e8d7", "c7a8"],
    refutationPv: ["e8d7", "f1g1"],
    wpLoss: 14,
    bestEvalCp: 500,
  },
  {
    id: "missed_pin-1",
    motif: "MISSED_PIN",
    note: "Bb5 absolutely pins the c6 knight to the king; the king shuffle forgoes it.",
    fenBefore: "4k3/pp5p/2n5/8/8/8/P6P/5BK1 w - - 3 25",
    movedUci: "g1g2",
    bestPv: ["f1b5", "a7a6", "b5c6", "b7c6"],
    refutationPv: ["e8d7", "g2g1"],
    wpLoss: 12,
    bestEvalCp: 320,
  },
  {
    id: "missed_skewer-1",
    motif: "MISSED_SKEWER",
    note: "Bg2+ skewers the centralized king against the a8 queen.",
    fenBefore: "q7/p6p/8/3k4/8/8/P6P/5BK1 w - - 6 40",
    movedUci: "g1f2",
    bestPv: ["f1g2", "d5d6", "g2a8"],
    refutationPv: ["d5e5", "f2g1"],
    wpLoss: 20,
    bestEvalCp: 900,
  },
  {
    id: "missed_discovered-1",
    motif: "MISSED_DISCOVERED_ATTACK",
    note: "Nc5 discovers Re1 onto the e7 queen (pinned to the king behind it).",
    fenBefore: "4k3/p3q2p/8/8/4N3/8/P6P/4R1K1 w - - 5 28",
    movedUci: "g1f1",
    bestPv: ["e4c5", "e8f8", "e1e7"],
    refutationPv: ["e7d6", "f1g1"],
    wpLoss: 15,
    bestEvalCp: 400,
  },
  {
    id: "missed_back_rank-1",
    motif: "MISSED_BACK_RANK",
    note: "Rd8# was on; after the king move Black gets ...Ra8 and the mate is gone.",
    fenBefore: "6k1/r4ppp/8/8/8/8/5PPP/3R2K1 w - - 8 35",
    movedUci: "g1f1",
    bestPv: ["d1d8"],
    refutationPv: ["a7a8", "f1g1"],
    wpLoss: 25,
    bestEvalCp: 10000,
  },
  {
    id: "missed_overload-1",
    motif: "MISSED_OVERLOAD",
    note: "The d7 queen guards both c6 and g4: Bxc6 QxBc6 then Nxg4 wins a piece.",
    fenBefore: "6k1/p2q1ppp/2n5/1B6/6b1/8/P4N1P/6K1 w - - 2 26",
    movedUci: "g1h1",
    bestPv: ["b5c6", "d7c6", "f2g4"],
    refutationPv: ["g8h8", "h1g1"],
    wpLoss: 12,
    bestEvalCp: 300,
  },
  {
    id: "missed_removing-1",
    motif: "MISSED_REMOVING_THE_DEFENDER",
    note: "Bxf6 removes the queen's only defender; Rxd7 follows.",
    fenBefore: "6k1/p2q1ppp/5n2/6B1/8/8/P6P/3R2K1 w - - 4 27",
    movedUci: "g1f1",
    bestPv: ["g5f6", "g7f6", "d1d7"],
    refutationPv: ["d7e6", "f1g1"],
    wpLoss: 22,
    bestEvalCp: 900,
  },
  {
    id: "missed_trapped-1",
    motif: "MISSED_TRAPPED_PIECE",
    note: "The a5 knight has no safe square; b4 wins it — the king move lets it slip.",
    fenBefore: "r5k1/1p3ppp/8/nP6/8/1P6/P6P/6K1 w - - 1 24",
    movedUci: "g1f1",
    bestPv: ["b3b4", "a8c8", "b4a5", "c8c2"],
    refutationPv: ["g8f8", "f1g1"],
    wpLoss: 12,
    bestEvalCp: 300,
  },
  {
    id: "missed_zwischenzug-3",
    motif: "MISSED_ZWISCHENZUG",
    note: "White-side: the immediate recapture cxd4 misses Bb5+ first (the two harvested fixtures are black-side).",
    fenBefore: "2b1k3/p6p/8/8/3n4/2P1P3/P6P/5BK1 w - - 0 22",
    movedUci: "c3d4",
    bestPv: ["f1b5", "c8d7", "c3d4"],
    refutationPv: ["a7a6", "g1g2"],
    wpLoss: 12,
    bestEvalCp: 350,
    playedIsRecapture: true,
    mirror: false,
  },
];

/** Vertical board flip + color swap; castling/ep are '-' in every draft. */
function mirrorFen(fen: string): string {
  const [board, turn, castling, ep, half, full] = fen.split(" ");
  const flipped = board!
    .split("/")
    .reverse()
    .map((rank) =>
      rank
        .split("")
        .map((ch) =>
          /[a-z]/.test(ch) ? ch.toUpperCase() : /[A-Z]/.test(ch) ? ch.toLowerCase() : ch
        )
        .join("")
    )
    .join("/");
  return `${flipped} ${turn === "w" ? "b" : "w"} ${castling} ${ep} ${half} ${full}`;
}

function mirrorUci(uci: string): string {
  const flipSq = (s: string) => `${s[0]}${9 - Number(s[1])}`;
  return `${flipSq(uci.slice(0, 2))}${flipSq(uci.slice(2, 4))}${uci.slice(4)}`;
}

function mirrored(draft: Draft): Draft {
  return {
    ...draft,
    id: draft.id.replace(/-1$/, "-2"),
    note: `Black-side mirror: ${draft.note}`,
    fenBefore: mirrorFen(draft.fenBefore),
    movedUci: mirrorUci(draft.movedUci),
    bestPv: draft.bestPv.map(mirrorUci),
    refutationPv: draft.refutationPv.map(mirrorUci),
  };
}

const all: Draft[] = DRAFTS.flatMap((draft) =>
  draft.mirror === false ? [draft] : [draft, mirrored(draft)]
);

const path = "src/lib/motifs/fixtures.json";
const fixtures = JSON.parse(readFileSync(path, "utf8")) as { id: string }[];
let failures = 0;
const additions: unknown[] = [];

for (const draft of all) {
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
    bestPv: draft.bestPv,
    refutationPv: draft.refutationPv,
    wpLoss: draft.wpLoss,
    clockMsRemaining: null,
    tbBefore: null,
    tbBeforeHit: false,
    tbAfter: null,
    priorForcingRun: false,
    recentOwnSans: [],
    classification: "MISS",
    bestEvalCp: draft.bestEvalCp,
    ...(draft.playedIsRecapture ? { playedIsRecapture: true } : {}),
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
    source: "handcrafted (forgone class)",
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
