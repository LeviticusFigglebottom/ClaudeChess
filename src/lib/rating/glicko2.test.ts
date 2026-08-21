import { describe, expect, it } from "vitest";
import { updateRating } from "./glicko2";

describe("Glicko-2 against Glickman's worked example (spec §10 Testing)", () => {
  // Paper: player rated 1500, RD 200, σ 0.06, τ 0.5 plays three games:
  // beats 1400 (RD 30), loses to 1550 (RD 100), loses to 1700 (RD 300)
  // → new rating 1464.06, new RD 151.52, σ' ≈ 0.05999.
  it("reproduces 1464.06 / 151.52", () => {
    const updated = updateRating(
      { rating: 1500, rd: 200, volatility: 0.06 },
      [
        { opponentRating: 1400, opponentRd: 30, score: 1 },
        { opponentRating: 1550, opponentRd: 100, score: 0 },
        { opponentRating: 1700, opponentRd: 300, score: 0 },
      ],
      0.5
    );
    expect(updated.rating).toBeCloseTo(1464.06, 1);
    expect(updated.rd).toBeCloseTo(151.52, 1);
    expect(updated.volatility).toBeCloseTo(0.05999, 4);
  });

  it("no games in a period: rating holds, RD grows", () => {
    const updated = updateRating({ rating: 1500, rd: 200, volatility: 0.06 }, []);
    expect(updated.rating).toBe(1500);
    expect(updated.rd).toBeGreaterThan(200);
    expect(updated.volatility).toBe(0.06);
  });

  it("beating a much lower-rated bot with tight RD moves the rating only slightly", () => {
    const updated = updateRating({ rating: 1800, rd: 60, volatility: 0.06 }, [
      { opponentRating: 1000, opponentRd: 30, score: 1 },
    ]);
    expect(updated.rating).toBeGreaterThan(1800);
    expect(updated.rating).toBeLessThan(1810);
  });
});
