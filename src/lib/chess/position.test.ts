import { describe, expect, it } from "vitest";
import { GamePosition, isValidFen } from "./position";
import { START_FEN } from "./fen";

describe("GamePosition facade — standard chess", () => {
  it("starts at the standard position", () => {
    const position = GamePosition.initial();
    expect(position.fen()).toBe(START_FEN);
    expect(position.turn).toBe("w");
    expect(position.legalMoveCount()).toBe(20);
  });

  it("plays moves with SAN and classic UCI output", () => {
    const position = GamePosition.initial();
    const move = position.move({ from: "e2", to: "e4" });
    expect(move).toEqual({ san: "e4", uci: "e2e4", from: "e2", to: "e4" });
    expect(position.turn).toBe("b");
    expect(position.fen()).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  });

  it("rejects illegal moves with null (no exception escapes the facade)", () => {
    const position = GamePosition.initial();
    expect(position.move({ from: "e2", to: "e5" })).toBeNull();
    expect(position.move({ from: "e7", to: "e5" })).toBeNull(); // not your turn
    expect(position.moveUci("zzzz")).toBeNull();
  });

  it("undo restores position and history", () => {
    const position = GamePosition.initial();
    position.move({ from: "e2", to: "e4" });
    position.move({ from: "e7", to: "e5" });
    expect(position.historySan()).toEqual(["e4", "e5"]);
    expect(position.undo()).toBe(true);
    expect(position.historySan()).toEqual(["e4"]);
    expect(position.undo()).toBe(true);
    expect(position.fen()).toBe(START_FEN);
    expect(position.undo()).toBe(false);
  });

  it("standard castling: accepts both encodings, emits classic UCI and O-O SAN", () => {
    const setup = () => {
      const position = GamePosition.initial();
      for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"]) {
        expect(position.moveUci(uci)).not.toBeNull();
      }
      return position;
    };

    const viaClassic = setup();
    const classicMove = viaClassic.move({ from: "e1", to: "g1" });
    expect(classicMove?.san).toBe("O-O");
    expect(classicMove?.uci).toBe("e1g1");

    const viaKingTakesRook = setup();
    const krMove = viaKingTakesRook.move({ from: "e1", to: "h1" });
    expect(krMove?.san).toBe("O-O");
    expect(krMove?.uci).toBe("e1g1");

    expect(viaClassic.fen()).toBe(viaKingTakesRook.fen());
    // Both castling encodings offered as UI destinations in standard.
    const targets = setup().destsFrom("e1");
    expect(targets).toContain("g1");
    expect(targets).toContain("h1");
  });

  it("auto-queens promotions and honors explicit underpromotion", () => {
    const position = GamePosition.fromFen("8/4P3/8/8/8/2k5/8/4K3 w - - 0 1");
    const move = position.move({ from: "e7", to: "e8" });
    expect(move?.san).toBe("e8=Q");
    expect(move?.uci).toBe("e7e8q");

    const position2 = GamePosition.fromFen("8/4P3/8/8/8/2k5/8/4K3 w - - 0 1");
    const knight = position2.move({ from: "e7", to: "e8", promotion: "n" });
    expect(knight?.san).toBe("e8=N");
  });

  it("detects checkmate and outcome", () => {
    const position = GamePosition.initial();
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) position.moveUci(uci);
    expect(position.isCheckmate()).toBe(true);
    expect(position.isGameOver()).toBe(true);
    expect(position.outcome()).toBe("black");
  });

  it("detects threefold repetition", () => {
    const position = GamePosition.initial();
    for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) {
      position.moveUci(uci);
    }
    expect(position.isThreefold()).toBe(true);
    expect(position.outcome()).toBe("draw");
  });

  it("validates FENs", () => {
    expect(isValidFen(START_FEN)).toBe(true);
    expect(isValidFen("not a fen")).toBe(false);
    expect(isValidFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBe(false); // no kings
  });
});

describe("GamePosition facade — chess960", () => {
  it("initial() refuses chess960 (must pick an index)", () => {
    expect(() => GamePosition.initial("chess960")).toThrow(/fromChess960/);
  });

  it("960 castling: king-takes-rook input, X-FEN preserved after moves", () => {
    // King g1 flanked by rooks f1 and h1 — BOTH adjacent, the exact drag
    // ambiguity A1.2 calls out. Back ranks cleared so castling is live.
    // Kingside (h-rook) is still illegal here: its rook target f1 is occupied
    // by the queenside rook. Queenside (f-rook → king c1, rook d1) is legal.
    const position = GamePosition.fromFen(
      "5rkr/pppppppp/8/8/8/8/PPPPPPPP/5RKR w HFhf - 0 1",
      "chess960"
    );
    const kingTargets = position.destsFrom("g1");
    expect(kingTargets).toContain("f1"); // queenside castle, offered as the rook's square
    expect(kingTargets).not.toContain("h1"); // kingside blocked by the f1 rook

    const castle = position.move({ from: "g1", to: "f1" });
    expect(castle?.san).toBe("O-O-O");
    // chess960 emits king-takes-rook UCI, matching UCI_Chess960.
    expect(castle?.uci).toBe("g1f1");
    // King lands on c1, rook on d1.
    expect(position.fen().split(" ")[0]?.endsWith("2KR3R")).toBe(true);
    // White's rights consumed, black's remain, still file letters.
    expect(position.fen().split(" ")[2]).toBe("hf");
  });
});
