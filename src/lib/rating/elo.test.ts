import { describe, expect, it } from "vitest";
import { combineEstimates, eloDiffFromScore, eloFromMatch, expectedScore } from "./elo";

describe("Elo estimation math (calibration gate)", () => {
  it("expectedScore and eloDiffFromScore are inverses", () => {
    expect(expectedScore(0)).toBeCloseTo(0.5, 10);
    expect(eloDiffFromScore(0.5)).toBeCloseTo(0, 10);
    for (const diff of [-300, -120, -50, 75, 200, 400]) {
      expect(eloDiffFromScore(expectedScore(diff))).toBeCloseTo(diff, 6);
    }
  });

  it("a 50% score against a known opponent measures at their rating", () => {
    const estimate = eloFromMatch(1400, 100, 200);
    expect(estimate.elo).toBeCloseTo(1400, 6);
    // se(s) = sqrt(.25/200) ≈ 3.54% → ±~48 Elo at 95%.
    expect(estimate.ci95).toBeGreaterThan(40);
    expect(estimate.ci95).toBeLessThan(60);
  });

  it("a 24% score against a 200-higher anchor measures ~even", () => {
    // expectedScore(-200) ≈ 0.2402
    const estimate = eloFromMatch(1000, 48, 200);
    expect(estimate.elo).toBeGreaterThan(780);
    expect(estimate.elo).toBeLessThan(820);
  });

  it("combineEstimates tightens the interval and respects anchor uncertainty", () => {
    const combined = combineEstimates([
      { elo: 810, ci95: 60 },
      { elo: 790, ci95: 60 },
    ]);
    expect(combined.elo).toBeCloseTo(800, 6);
    expect(combined.ci95).toBeCloseTo(60 / Math.SQRT2, 1);

    const withAnchor = combineEstimates([
      { elo: 810, ci95: 60, anchorCi95: 45 },
      { elo: 790, ci95: 60 },
    ]);
    // The anchored estimate is downweighted → pulled toward 790.
    expect(withAnchor.elo).toBeLessThan(800);
  });
});
