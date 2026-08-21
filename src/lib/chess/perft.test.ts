import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { perft } from "./perft";

// Phase 0 gate: legal move generation matches the standard perft numbers
// from the start position; perft(4) = 197,281 (spec §8).
describe("perft from the start position", () => {
  it("perft(1) = 20", () => {
    expect(perft(new Chess(), 1)).toBe(20);
  });

  it("perft(2) = 400", () => {
    expect(perft(new Chess(), 2)).toBe(400);
  });

  it("perft(3) = 8,902", () => {
    expect(perft(new Chess(), 3)).toBe(8_902);
  });

  it("perft(4) = 197,281 (gate)", () => {
    expect(perft(new Chess(), 4)).toBe(197_281);
  });
});
