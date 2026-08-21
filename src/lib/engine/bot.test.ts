import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/lib/rng";
import type { EngineInfo } from "./types";
import { formulaParams, phaseFactor, selectBotMove, type BotSearchSnapshot } from "./bot";

function info(uci: string, multipv: number, scoreCp: number | null, mateIn: number | null = null): EngineInfo {
  return { depth: 18, multipv, scoreCp, mateIn, pv: [uci], nodes: 0, nps: 0 };
}

/** Deep list with mover-POV cp per candidate; shallow list is just an ordering. */
function snapshot(
  deepCp: [string, number][],
  shallowOrder: string[],
  extras: Partial<BotSearchSnapshot> = {}
): BotSearchSnapshot {
  return {
    deep: deepCp.map(([uci, cp], index) => info(uci, index + 1, cp)),
    shallow: shallowOrder.map((uci, index) => info(uci, index + 1, 0)),
    legalMoveCount: 30,
    inCheck: false,
    ...extras,
  };
}

describe("formulaParams (spec §6.4)", () => {
  it("matches the spec formulas at the band edges", () => {
    expect(formulaParams(600)).toEqual({ pBlunder: 0.45, temperature: 6.0 });
    expect(formulaParams(1400).pBlunder).toBeCloseTo(0.45 - 800 / 3000, 10);
    expect(formulaParams(1400).temperature).toBeCloseTo(6.0 - 800 / 300, 10);
    expect(formulaParams(2200)).toEqual({ pBlunder: 0.02, temperature: 6.0 - 1600 / 300 });
    // Clamps hold beyond the band range.
    expect(formulaParams(3000).pBlunder).toBe(0.02);
    expect(formulaParams(3000).temperature).toBe(0.15);
  });
});

describe("phaseFactor (spec §6.5)", () => {
  it("raises 1.4x in complex middlegames, halves in forced sequences", () => {
    expect(phaseFactor(40, false)).toBe(1.4);
    expect(phaseFactor(20, false)).toBe(1);
    expect(phaseFactor(4, false)).toBe(0.5);
    expect(phaseFactor(30, true)).toBe(0.5);
  });
});

describe("selectBotMove — shallow-good/deep-bad blunder branch", () => {
  // Deep truth: best +100cp; "e2e4" loses ~25wp (plausible blunder);
  // "h2h4" loses ~60wp (absurd); both look good shallow.
  const base = snapshot(
    [
      ["g1f3", 100],
      ["d2d4", 80],
      ["e2e4", -220], // ≈25wp loss vs +100
      ["c2c4", 40],
      ["h2h4", -700], // ≈57wp loss — outside the 45 cap
    ],
    ["e2e4", "h2h4", "g1f3", "d2d4", "c2c4"]
  );

  it("plays the plausible blunder when the roll hits", () => {
    const rng = () => 0; // roll < pBlunder, then irrelevant
    const choice = selectBotMove({ pBlunder: 0.4, temperature: 1 }, base, rng);
    expect(choice?.uci).toBe("e2e4");
    expect(choice?.playedBlunder).toBe(true);
    expect(choice?.wpLoss).toBeGreaterThanOrEqual(15);
    expect(choice?.wpLoss).toBeLessThanOrEqual(45);
  });

  it("never plays an absurd (>45wp) move as the blunder even at shallow rank 1", () => {
    const absurdOnly = snapshot(
      [
        ["g1f3", 100],
        ["h2h4", -700],
      ],
      ["h2h4", "g1f3"]
    );
    for (let seed = 0; seed < 50; seed++) {
      const choice = selectBotMove(
        { pBlunder: 0.9, temperature: 0.15 },
        absurdOnly,
        mulberry32(seed)
      );
      expect(choice?.uci).toBe("g1f3");
      expect(choice?.playedBlunder).toBe(false);
    }
  });

  it("ignores blunder candidates outside the shallow top-3", () => {
    const deepBad = snapshot(
      [
        ["g1f3", 100],
        ["e2e4", -220],
      ],
      ["a2a3", "a2a4", "b2b3", "e2e4"] // e2e4 ranks 4th shallow
    );
    const choice = selectBotMove({ pBlunder: 0.9, temperature: 0.15 }, deepBad, () => 0);
    expect(choice?.playedBlunder).toBe(false);
  });

  it("forced positions halve the effective blunder rate", () => {
    const inCheck = { ...base, inCheck: true };
    const choice = selectBotMove({ pBlunder: 0.4, temperature: 1 }, inCheck, () => 0.3);
    // 0.3 >= 0.4 * 0.5 → blunder branch must NOT fire.
    expect(choice?.playedBlunder).toBe(false);
    expect(choice?.effectivePBlunder).toBeCloseTo(0.2, 10);
  });
});

describe("selectBotMove — softmax sampling", () => {
  const losses = snapshot(
    [
      ["a1", 100],
      ["b1", 20], // ~9wp loss
      ["c1", -60], // ~14wp
      ["d1", -180], // ~24wp
      ["e1", -400], // ~36wp
    ],
    ["a1", "b1", "c1", "d1", "e1"]
  );

  it("near-zero temperature collapses to the best move", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const choice = selectBotMove({ pBlunder: 0, temperature: 0.15 }, losses, rng);
      expect(choice?.uci).toBe("a1");
    }
  });

  it("high temperature spreads across the MultiPV", () => {
    const rng = mulberry32(7);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(selectBotMove({ pBlunder: 0, temperature: 6 }, losses, rng)?.uci ?? "");
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("handles mate scores as wp endpoints", () => {
    const mating: BotSearchSnapshot = {
      deep: [
        { ...info("h5f7", 1, null, 1) },
        info("d1h5", 2, 300),
      ],
      shallow: [info("h5f7", 1, null, 1)],
      legalMoveCount: 30,
      inCheck: false,
    };
    const choice = selectBotMove({ pBlunder: 0, temperature: 0.15 }, mating, mulberry32(1));
    expect(choice?.uci).toBe("h5f7");
    expect(choice?.wpLoss).toBe(0);
  });

  it("returns null with no legal continuations", () => {
    expect(
      selectBotMove({ pBlunder: 0.2, temperature: 1 }, snapshot([], []), mulberry32(1))
    ).toBeNull();
  });
});
