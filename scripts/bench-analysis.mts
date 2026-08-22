/**
 * Sizing probe for the Phase 2 batch pipeline: depth-18 MultiPV-3 wall time
 * per position on this hardware, single-threaded CLI engine (the pool unit).
 *
 *   npx tsx scripts/bench-analysis.mts
 */
import { NodeEngine } from "../src/lib/engine/node-engine";

const POSITIONS: [string, string][] = [
  ["startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
  // Open Sicilian middlegame (branchy)
  ["sicilian-mg", "r1bqk2r/1pp1bppp/p1np1n2/4p3/B3P3/2NP1N2/PPP2PPP/R1BQ1RK1 w kq - 0 8"],
  // Sharp tactical middlegame
  ["tactical-mg", "r2q1rk1/pp1nbppp/2p1pn2/3p2B1/2PP4/2NBPN2/PP3PPP/R2Q1RK1 w - - 0 9"],
  // Rook endgame
  ["rook-endgame", "8/5pk1/6p1/8/1r6/6P1/5PK1/1R6 w - - 0 40"],
];

const engine = new NodeEngine();
await engine.init({ chess960: false, hashMb: 128 });

for (const [name, fen] of POSITIONS) {
  const t0 = Date.now();
  const result = await engine.analyze(fen, [], { depth: 18, multipv: 3 });
  const ms = Date.now() - t0;
  const top = result.infos[0];
  console.log(
    `${name.padEnd(14)} ${String(ms).padStart(6)}ms  depth=${top?.depth} cp=${top?.scoreCp} nodes=${top?.nodes}`
  );
}
engine.quit();
process.exit(0);
