/**
 * Post-exchange FORK_ALLOWED fixtures — the widening that catches a fork
 * arriving through a null-net forced exchange (their capture on S, our
 * recapture on S, THEIR fork). One real gate-dataset case + a color-flipped
 * handcrafted mirror. Same standard as every fixture: verified rank-1
 * before writing; a miss prints the detection list and fails.
 *
 *   npx tsx scripts/build-fork-fixtures.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { GamePosition } from "../src/lib/chess/position";
import { detectMotifs, type MotifDetectionInput } from "../src/lib/motifs/detect";

interface Draft {
  id: string;
  motif: string;
  source: string;
  note: string;
  fenBefore: string;
  movedUci: string;
  bestPv?: string[];
  refutationPv: string[];
  wpLoss: number;
}

const DRAFTS: Draft[] = [
  {
    id: "fork_allowed-11",
    motif: "FORK_ALLOWED",
    source: "gate-phase2 UNCLEAR review (real imported game)",
    note: "Post-exchange fork: Bd3 leaves a3; BxB NxB is a null-net exchange, then Qa5+ forks the e1 king and the loose a3 knight.",
    fenBefore: "rnb1k1nr/2qp1ppp/p3p3/1pb5/4P3/BP3N2/P1P2PPP/RN1QKB1R w KQkq - 0 7",
    movedUci: "f1d3",
    refutationPv: ["c5a3", "b1a3", "c7a5", "d1d2", "a5a3", "d2c3"],
    wpLoss: 22,
  },
  {
    id: "fork_allowed-12",
    motif: "FORK_ALLOWED",
    source: "handcrafted (post-exchange fork, color mirror)",
    note: "Black-side mirror: ...Bd6 leaves a6; BxB NxB nets zero, then Qa4+ forks the e8 king and the loose a6 knight.",
    fenBefore: "rn1qkb1r/p1p2ppp/bp3n2/4p3/1PB5/P7/2QP1PPP/RNB1K1NR b KQkq - 0 7",
    movedUci: "f8d6",
    refutationPv: ["c4a6", "b8a6", "c2a4", "d8d7", "a4a6", "d7c6"],
    wpLoss: 22,
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
    source: draft.source,
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
