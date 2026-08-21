import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeEngine } from "@/lib/engine/node-engine";
import { chess960BackRank, chess960StartFen, STANDARD_SP_INDEX } from "./chess960";
import { GamePosition } from "./position";

/**
 * Gate G2 (Phase 0.5): perft(4) for SP518 plus five randomly chosen 960
 * start positions, with castling exercised in each.
 *
 * "Passes" is defined as agreement between two independent implementations
 * on identical FENs: chessops' move generator (via the facade) vs Stockfish
 * 18's own `go perft` with UCI_Chess960 set. For each SP we check the true
 * start position AND a castle-ready position (back ranks reduced to
 * king + both rooks) whose depth-1 move list provably contains castling —
 * castling generation is inside the perft tree, not just assumed.
 *
 * The five SPs were drawn once with shuf(1) over 0..959 and pinned here.
 */
const RANDOM_SPS = [266, 642, 144, 636, 773];

/** Start FEN with both back ranks reduced to king + rooks: castling is live. */
function castleReadyFen(sp: number): string {
  const backRank = chess960BackRank(sp);
  const reduced = [...backRank].map((piece) => (piece === "r" || piece === "k" ? piece : null));
  let rankFen = "";
  let run = 0;
  for (const piece of reduced) {
    if (piece === null) run++;
    else {
      if (run > 0) rankFen += String(run);
      rankFen += piece;
      run = 0;
    }
  }
  if (run > 0) rankFen += String(run);
  const castling = chess960StartFen(sp).split(" ")[2] as string;
  return `${rankFen}/pppppppp/8/8/8/8/PPPPPPPP/${rankFen.toUpperCase()} w ${castling} - 0 1`;
}

describe("gate G2 — chess960 perft(4), chessops vs Stockfish", () => {
  const engine = new NodeEngine();

  beforeAll(async () => {
    await engine.init({ chess960: true });
  }, 60_000);

  afterAll(() => {
    engine.quit();
  });

  it("SP518 start position: perft(4) = 197,281 on both implementations", async () => {
    const fen = chess960StartFen(STANDARD_SP_INDEX);
    const facadeNodes = GamePosition.fromFen(fen, "chess960").perft(4);
    const engineNodes = await engine.perft(fen, 4);
    expect(facadeNodes).toBe(197_281);
    expect(engineNodes).toBe(197_281);
  }, 120_000);

  for (const sp of RANDOM_SPS) {
    it(`SP${sp}: start + castle-ready perft(4) agree, castling in the tree`, async () => {
      const startFen = chess960StartFen(sp);
      const startFacade = GamePosition.fromFen(startFen, "chess960").perft(4);
      const startEngine = await engine.perft(startFen, 4);
      expect(startFacade, `SP${sp} start: facade ${startFacade} vs engine ${startEngine}`).toBe(
        startEngine
      );

      const readyFen = castleReadyFen(sp);
      const readyPosition = GamePosition.fromFen(readyFen, "chess960");

      // Castling must actually be available at the root of this tree: the
      // king's destinations include at least one own-rook square.
      const backRank = chess960BackRank(sp);
      const kingFile = backRank.indexOf("k");
      const kingSquare = `${"abcdefgh"[kingFile]}1`;
      const rookSquares = [...backRank].flatMap((piece, file) =>
        piece === "r" ? [`${"abcdefgh"[file]}1`] : []
      );
      const kingDests = readyPosition.destsFrom(kingSquare);
      const castleOffers = rookSquares.filter((square) => kingDests.includes(square));
      expect(castleOffers.length, `SP${sp} castle-ready position offers castling`).toBeGreaterThan(0);

      // And the castle actually plays as one.
      const probe = GamePosition.fromFen(readyFen, "chess960");
      const castle = probe.move({ from: kingSquare, to: castleOffers[0] as string });
      expect(castle?.san, `SP${sp} castling SAN`).toMatch(/^O-O(-O)?$/);

      const readyFacade = readyPosition.perft(4);
      const readyEngine = await engine.perft(readyFen, 4);
      expect(readyFacade, `SP${sp} castle-ready: facade ${readyFacade} vs engine ${readyEngine}`).toBe(
        readyEngine
      );
    }, 300_000);
  }
});
