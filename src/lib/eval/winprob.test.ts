import { describe, expect, it } from "vitest";
import { winProb, winProbFromEval } from "./winprob";

describe("winProb (spec §4.1)", () => {
  it("is 50% at equality", () => {
    expect(winProb(0)).toBeCloseTo(50, 10);
  });

  it("is symmetric: winProb(cp) + winProb(-cp) = 100", () => {
    for (const cp of [50, 137, 300, 512, 900, 2000]) {
      expect(winProb(cp) + winProb(-cp)).toBeCloseTo(100, 8);
    }
  });

  it("is strictly monotonic within the ±1000cp clamp range", () => {
    let previous = -1;
    for (let cp = -1000; cp <= 1000; cp += 100) {
      const wp = winProb(cp);
      expect(wp).toBeGreaterThan(previous);
      previous = wp;
    }
  });

  it("clamps beyond ±1000cp (no further change)", () => {
    expect(winProb(1000)).toBeCloseTo(winProb(5000), 10);
    expect(winProb(-1000)).toBeCloseTo(winProb(-99999), 10);
  });

  it("matches the logistic at a known point (+100cp ≈ 59%)", () => {
    // 50 + 50 * (2/(1+e^-0.368208) - 1) = 59.1...
    expect(winProb(100)).toBeGreaterThan(58);
    expect(winProb(100)).toBeLessThan(60);
  });

  it("maps mate scores to 0/100", () => {
    expect(winProbFromEval({ cp: null, mateIn: 3 })).toBe(100);
    expect(winProbFromEval({ cp: null, mateIn: -1 })).toBe(0);
  });
});
