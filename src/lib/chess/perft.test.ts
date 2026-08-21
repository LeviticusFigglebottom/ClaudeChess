import { describe, expect, it } from "vitest";
import { GamePosition } from "./position";
import { perft } from "./perft";

// Phase 0 gate: legal move generation matches the standard perft numbers
// from the start position; perft(4) = 197,281 (spec §8). Ported unchanged to
// the chessops facade (Phase 0.5 gate G1).
describe("perft from the start position", () => {
  it("perft(1) = 20", () => {
    expect(perft(GamePosition.initial(), 1)).toBe(20);
  });

  it("perft(2) = 400", () => {
    expect(perft(GamePosition.initial(), 2)).toBe(400);
  });

  it("perft(3) = 8,902", () => {
    expect(perft(GamePosition.initial(), 3)).toBe(8_902);
  });

  it("perft(4) = 197,281 (gate)", () => {
    expect(perft(GamePosition.initial(), 4)).toBe(197_281);
  });
});
