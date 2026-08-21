import { describe, expect, it } from "vitest";
import { gameAccuracy, moveAccuracy, volatilityWeights } from "./accuracy";

describe("moveAccuracy (spec §4.5)", () => {
  it("zero loss ≈ 100", () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 1);
  });

  it("is monotonically decreasing in loss", () => {
    let previous = 101;
    for (const loss of [0, 1, 2, 5, 10, 20, 30, 50, 80]) {
      const acc = moveAccuracy(loss);
      expect(acc).toBeLessThan(previous);
      previous = acc;
    }
  });

  it("clamps to [0, 100]", () => {
    expect(moveAccuracy(-5)).toBeLessThanOrEqual(100);
    expect(moveAccuracy(1000)).toBeGreaterThanOrEqual(0);
  });
});

describe("volatility weighting (spec §4.5)", () => {
  it("flat win-prob series gets the floor weight everywhere", () => {
    const weights = volatilityWeights([50, 50, 50, 50, 50, 50]);
    expect(weights).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it("volatile stretches weigh more than quiet ones", () => {
    const series = [50, 50, 50, 80, 20, 70, 50, 50, 50, 50, 50, 50];
    const weights = volatilityWeights(series);
    const volatileWeight = weights[4] as number;
    const quietWeight = weights[10] as number;
    expect(volatileWeight).toBeGreaterThan(quietWeight);
  });

  it("a dead-drawn tail cannot inflate game accuracy past the volatile moment", () => {
    // One catastrophic move (acc 20) during a volatile stretch, then 20
    // perfect moves in a flat endgame. Unweighted mean would be ≈ 96.
    const accuracies = [20, ...Array(20).fill(100)] as number[];
    const weights = [8, ...Array(20).fill(0.5)] as number[];
    const weighted = gameAccuracy(accuracies, weights);
    const unweighted = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    expect(weighted).toBeLessThan(unweighted - 20);
  });
});
