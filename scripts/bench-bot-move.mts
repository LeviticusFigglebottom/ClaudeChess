/**
 * Benchmark: cost of one bot move (shallow d6 MPV5 + deep d18 MPV5) through
 * the vendored single-threaded engine, on realistic positions — sizes the
 * calibration arena before committing to a run plan.
 */
import { NodeEngine } from "../src/lib/engine/node-engine";
import { BOT_SEARCH } from "../src/lib/engine/bot";
import { GamePosition, START_FEN } from "../src/lib/chess";

const POSITIONS: { name: string; moves: string[] }[] = [
  { name: "startpos", moves: [] },
  { name: "italian move 6", moves: "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6".split(" ") },
  {
    name: "closed middlegame",
    moves:
      "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5 g1f3 c7c5 e1g1 b8c6 a2a3 b4c3 b2c3 d5c4 d3c4 d8c7".split(
        " "
      ),
  },
  {
    name: "open tactical",
    moves: "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1g5 e7e6 f2f4 f8e7 d1f3 d8c7".split(
      " "
    ),
  },
];

const engine = new NodeEngine();
await engine.init({ chess960: false, hashMb: 64 });

// Also capture the engine's UCI_Elo bounds for the reference-opponent plan.
console.log("warming up...");
await engine.analyze(START_FEN, [], { depth: 10, multipv: 1 });

let totalMs = 0;
for (const position of POSITIONS) {
  // Validate the move list through the facade first.
  const game = GamePosition.initial();
  for (const uci of position.moves) {
    if (!game.moveUci(uci)) throw new Error(`bad bench move ${uci} in ${position.name}`);
  }

  const t0 = performance.now();
  await engine.analyze(START_FEN, position.moves, BOT_SEARCH.shallow);
  const tShallow = performance.now();
  const deep = await engine.analyze(START_FEN, position.moves, BOT_SEARCH.deep);
  const tDeep = performance.now();

  const shallowMs = Math.round(tShallow - t0);
  const deepMs = Math.round(tDeep - tShallow);
  totalMs += tDeep - t0;
  const top = deep.infos[0];
  console.log(
    `${position.name.padEnd(18)} shallow ${String(shallowMs).padStart(5)}ms  deep ${String(deepMs).padStart(6)}ms  (d${top?.depth} nodes ${top?.nodes} nps ${top?.nps})`
  );
}

console.log(`\navg per bot move: ${Math.round(totalMs / POSITIONS.length)}ms`);
engine.quit();
process.exit(0);
