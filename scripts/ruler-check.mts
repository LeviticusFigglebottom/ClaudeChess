/**
 * Ruler self-consistency check (calibration methodology): two
 * UCI_LimitStrength instances of the vendored engine play each other; the
 * observed score should match the Elo-model prediction for their label gap.
 * Internal consistency of the UCI_Elo ladder is a necessary (not
 * sufficient) condition for using it as the calibration anchor — the
 * external validity of the labels is Stockfish's own calibration.
 *
 *   npx tsx scripts/ruler-check.mts --a 1400 --b 2000 --games 30
 */
import { GamePosition, START_FEN } from "../src/lib/chess";
import { NodeEngine } from "../src/lib/engine/node-engine";
import { expectedScore } from "../src/lib/rating/elo";
import { mulberry32 } from "../src/lib/rng";
import openings from "../src/db/seed/openings.json";

const get = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${flag}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const eloA = Number(get("a", "1400"));
const eloB = Number(get("b", "2000"));
const games = Number(get("games", "30"));
const movetime = Number(get("movetime", "400"));

const BOOK = (openings as { pgn: string; ply: number }[]).filter((e) => e.ply >= 4 && e.ply <= 8);

async function playGame(index: number): Promise<number> {
  const rng = mulberry32(9000 + index);
  const engineA = new NodeEngine();
  const engineB = new NodeEngine();
  await engineA.init({ chess960: false, hashMb: 32, limitStrengthElo: eloA });
  await engineB.init({ chess960: false, hashMb: 32, limitStrengthElo: eloB });
  const aIsWhite = index % 2 === 0;

  const position = GamePosition.initial();
  const moves: string[] = [];
  const line = BOOK[Math.floor(rng() * BOOK.length)];
  if (line) {
    for (const token of line.pgn.split(/\s+/)) {
      if (/^\d+\.$/.test(token)) continue;
      const move = position.moveSan(token);
      if (!move) break;
      moves.push(move.uci);
    }
  }

  let result = 0.5;
  while (true) {
    if (position.isCheckmate()) {
      const whiteWon = position.turn === "b";
      result = whiteWon === aIsWhite ? 1 : 0;
      break;
    }
    if (
      position.isStalemate() ||
      position.isInsufficientMaterial() ||
      position.isThreefold() ||
      position.isFiftyMoves() ||
      moves.length >= 220
    ) {
      result = 0.5;
      break;
    }
    const whiteToMove = position.turn === "w";
    const engine = whiteToMove === aIsWhite ? engineA : engineB;
    const uci = await engine.bestMove(START_FEN, moves, movetime);
    if (!uci) {
      result = 0.5;
      break;
    }
    const played = position.moveUci(uci);
    if (!played) throw new Error(`illegal ruler move ${uci}`);
    moves.push(played.uci);
  }

  engineA.quit();
  engineB.quit();
  return result;
}

let points = 0;
for (let i = 0; i < games; i++) {
  const score = await playGame(i);
  points += score;
  process.stdout.write(`\r[${i + 1}/${games}] A-score ${points}`);
}
const observed = points / games;
const predicted = expectedScore(eloA - eloB);
console.log(
  `\nSF@${eloA} vs SF@${eloB} @${movetime}ms: observed ${observed.toFixed(3)} (${points}/${games}), Elo-model predicts ${predicted.toFixed(3)}`
);
