import { describe, expect, it } from "vitest";
import { chess960BackRank, chess960StartFen, STANDARD_SP_INDEX } from "./chess960";
import { GamePosition } from "./position";
import { START_FEN } from "./fen";

/**
 * The 20 randomly drawn Scharnagl indices reported for gate G3 (drawn once
 * with shuf, then pinned). The full-coverage loops below go further and check
 * all 960, but these are the named evidence set.
 */
const G3_SAMPLE = [
  37, 54, 87, 163, 181, 269, 278, 293, 350, 395, 455, 456, 675, 694, 745, 790, 878, 884, 893, 901,
];

function kingAdjacentToRook(backRank: string): boolean {
  const king = backRank.indexOf("k");
  return backRank[king - 1] === "r" || backRank[king + 1] === "r";
}

describe("Scharnagl generation (addendum A1.2)", () => {
  it("SP518 is the standard array", () => {
    expect(chess960BackRank(STANDARD_SP_INDEX)).toBe("rnbqkbnr");
    expect(chess960StartFen(STANDARD_SP_INDEX)).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1"
    );
    // Identical piece placement to the standard start, only the castling
    // field differs (X-FEN letters instead of KQkq).
    expect(chess960StartFen(STANDARD_SP_INDEX).split(" ")[0]).toBe(START_FEN.split(" ")[0]);
  });

  it("all 960 positions satisfy the structural rules", () => {
    const seen = new Set<string>();
    for (let sp = 0; sp < 960; sp++) {
      const rank = chess960BackRank(sp);
      seen.add(rank);

      const files = (piece: string) => [...rank].flatMap((p, i) => (p === piece ? [i] : []));
      const [bishop1, bishop2] = files("b") as [number, number];
      expect((bishop1 + bishop2) % 2, `SP${sp} bishops must be on opposite colors`).toBe(1);

      const [rook1, rook2] = files("r") as [number, number];
      const king = files("k")[0] as number;
      expect(rook1 < king && king < rook2, `SP${sp} king must stand between the rooks`).toBe(true);

      expect(files("q").length).toBe(1);
      expect(files("n").length).toBe(2);
    }
    expect(seen.size, "all 960 back ranks are distinct").toBe(960);
  });

  it("rejects out-of-range indices", () => {
    expect(() => chess960BackRank(-1)).toThrow();
    expect(() => chess960BackRank(960)).toThrow();
    expect(() => chess960BackRank(1.5)).toThrow();
  });
});

describe("X-FEN castling round-trip — gate G3", () => {
  it("start FENs use file letters, never KQkq", () => {
    for (let sp = 0; sp < 960; sp++) {
      const castling = chess960StartFen(sp).split(" ")[2] as string;
      expect(castling).toMatch(/^[A-H]{2}[a-h]{2}$/);
    }
  });

  it("the 20 sampled positions round-trip through the facade with no rights lost", () => {
    for (const sp of G3_SAMPLE) {
      const fen = chess960StartFen(sp);
      const roundTripped = GamePosition.fromFen(fen, "chess960").fen();
      expect(roundTripped, `SP${sp}`).toBe(fen);
    }
  });

  it("all 960 start positions round-trip (superset of the gate)", () => {
    let adjacentCovered = 0;
    for (let sp = 0; sp < 960; sp++) {
      const fen = chess960StartFen(sp);
      const position = GamePosition.fromFen(fen, "chess960");
      expect(position.fen(), `SP${sp}`).toBe(fen);
      if (kingAdjacentToRook(chess960BackRank(sp))) adjacentCovered++;
    }
    // The gate explicitly requires adjacent king/rook coverage.
    expect(adjacentCovered).toBeGreaterThan(100);
  });

  it("re-parsing the facade's serialization preserves rights again (double round-trip)", () => {
    for (const sp of G3_SAMPLE) {
      const once = GamePosition.fromFen(chess960StartFen(sp), "chess960").fen();
      const twice = GamePosition.fromFen(once, "chess960").fen();
      expect(twice, `SP${sp}`).toBe(once);
    }
  });

  it("sampled set includes adjacent king/rook positions", () => {
    const adjacent = G3_SAMPLE.filter((sp) => kingAdjacentToRook(chess960BackRank(sp)));
    expect(adjacent.length, `adjacent SPs in sample: ${adjacent.join(", ")}`).toBeGreaterThan(0);
  });
});
