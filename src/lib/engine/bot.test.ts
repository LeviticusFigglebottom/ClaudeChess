import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/lib/rng";
import type { EngineInfo } from "./types";
import {
  bandSearchSettings,
  blunderWindow,
  formulaParams,
  phaseFactor,
  pRandom,
  selectBotMove,
  type BotSearchSnapshot,
  selectOrganicMove,
} from "./bot";

function info(uci: string, multipv: number, scoreCp: number | null, mateIn: number | null = null): EngineInfo {
  return { depth: 14, multipv, scoreCp, mateIn, pv: [uci], nodes: 0, nps: 0 };
}

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
    randomSafeMoves: [],
    ...extras,
  };
}

describe("revised per-band search shapes (revision a+b)", () => {
  it("MultiPV scales 600→24, 1400→16, 2200→8; clamped [4,24]", () => {
    expect(bandSearchSettings(600).deep.multipv).toBe(24);
    expect(bandSearchSettings(1000).deep.multipv).toBe(20);
    expect(bandSearchSettings(1400).deep.multipv).toBe(16);
    expect(bandSearchSettings(2200).deep.multipv).toBe(8);
    expect(bandSearchSettings(3000).deep.multipv).toBe(4);
    expect(bandSearchSettings(0).deep.multipv).toBe(24);
  });

  it("truth depth is 14 below 1600, 18 at or above", () => {
    expect(bandSearchSettings(600).deep.depth).toBe(14);
    expect(bandSearchSettings(1400).deep.depth).toBe(14);
    expect(bandSearchSettings(1600).deep.depth).toBe(18);
    expect(bandSearchSettings(2200).deep.depth).toBe(18);
  });

  it("shallow keeps a 12-ply gap (floor 2) and mirrors the truth MultiPV", () => {
    expect(bandSearchSettings(600).shallow).toEqual({ depth: 2, multipv: 24 });
    expect(bandSearchSettings(1400).shallow).toEqual({ depth: 2, multipv: 16 });
    expect(bandSearchSettings(1600).shallow).toEqual({ depth: 6, multipv: 14 });
    expect(bandSearchSettings(2200).shallow).toEqual({ depth: 6, multipv: 8 });
  });
});

describe("revised blunder window (revision c)", () => {
  it("widens at low bands: 600→[15,125], 1400→[15,85], 2200→[15,45]", () => {
    expect(blunderWindow(600)).toEqual({ min: 15, max: 125 });
    expect(blunderWindow(1400)).toEqual({ min: 15, max: 85 });
    expect(blunderWindow(2200)).toEqual({ min: 15, max: 45 });
  });
});

describe("near-random floor (revision e)", () => {
  it("pRandom: 600→0.2, 800→0.1, 1000→0, clamped", () => {
    expect(pRandom(600)).toBeCloseTo(0.2, 10);
    expect(pRandom(800)).toBeCloseTo(0.1, 10);
    expect(pRandom(1000)).toBe(0);
    expect(pRandom(2200)).toBe(0);
    expect(pRandom(0)).toBe(0.2);
  });

  it("fires before the blunder branch and samples the safe list uniformly-ish", () => {
    const base = snapshot(
      [
        ["g1f3", 100],
        ["e2e4", -220],
      ],
      ["e2e4", "g1f3"],
      { randomSafeMoves: ["a2a3", "h2h4", "b1c3"] }
    );
    const seen = new Set<string>();
    const rng = mulberry32(3);
    for (let i = 0; i < 400; i++) {
      const choice = selectBotMove(600, { pBlunder: 1, temperature: 1 }, base, rng);
      if (choice?.kind === "random") seen.add(choice.uci);
    }
    // pRandom(600)=0.2 → ~80 random picks over 400 — all from the safe list.
    expect(seen.size).toBe(3);
    for (const uci of seen) expect(["a2a3", "h2h4", "b1c3"]).toContain(uci);
  });

  it("never fires when the safe list is empty or the band is ≥1000", () => {
    const base = snapshot([["g1f3", 100]], ["g1f3"], { randomSafeMoves: [] });
    for (let seed = 0; seed < 30; seed++) {
      expect(
        selectBotMove(600, { pBlunder: 0, temperature: 0.15 }, base, mulberry32(seed))?.kind
      ).toBe("sampled");
    }
    const withSafe = snapshot([["g1f3", 100]], ["g1f3"], { randomSafeMoves: ["a2a3"] });
    for (let seed = 0; seed < 30; seed++) {
      expect(
        selectBotMove(1400, { pBlunder: 0, temperature: 0.15 }, withSafe, mulberry32(seed))?.kind
      ).toBe("sampled");
    }
  });
});

describe("blunder branch under the widened window", () => {
  // ~57wp loss: absurd for 2200 ([15,45]) but inside 600's window ([15,125]).
  const hangs = snapshot(
    [
      ["g1f3", 100],
      ["h2h4", -700],
    ],
    ["h2h4", "g1f3"]
  );

  it("a queen-hang-sized loss is a valid blunder at 600 but not at 2200", () => {
    const at600 = selectBotMove(600, { pBlunder: 1, temperature: 0.15 }, hangs, () => 0.5);
    expect(at600?.kind).toBe("blunder");
    expect(at600?.uci).toBe("h2h4");

    for (let seed = 0; seed < 30; seed++) {
      const at2200 = selectBotMove(
        2200,
        { pBlunder: 1, temperature: 0.15 },
        hangs,
        mulberry32(seed)
      );
      expect(at2200?.kind).toBe("sampled");
      expect(at2200?.uci).toBe("g1f3");
    }
  });

  it("reports blunder availability on every choice (revision d instrumentation)", () => {
    const available = selectBotMove(600, { pBlunder: 0, temperature: 0.15 }, hangs, () => 0.99);
    expect(available?.blunderAvailable).toBe(true);
    expect(available?.kind).toBe("sampled");

    const none = snapshot([["g1f3", 100], ["d2d4", 90]], ["g1f3", "d2d4"]);
    const unavailable = selectBotMove(600, { pBlunder: 1, temperature: 0.15 }, none, () => 0.5);
    expect(unavailable?.blunderAvailable).toBe(false);
  });

  it("ignores blunder candidates outside the shallow top-3", () => {
    const deepBad = snapshot(
      [
        ["g1f3", 100],
        ["e2e4", -220],
      ],
      ["a2a3", "a2a4", "b2b3", "e2e4"]
    );
    const choice = selectBotMove(1400, { pBlunder: 1, temperature: 0.15 }, deepBad, () => 0.5);
    expect(choice?.kind).toBe("sampled");
  });

  it("forced positions halve the effective blunder rate", () => {
    const base = snapshot(
      [
        ["g1f3", 100],
        ["e2e4", -220],
      ],
      ["e2e4", "g1f3"],
      { inCheck: true }
    );
    const choice = selectBotMove(1400, { pBlunder: 0.4, temperature: 1 }, base, () => 0.3);
    expect(choice?.kind).toBe("sampled"); // 0.3 >= 0.4 × 0.5
    expect(choice?.effectivePBlunder).toBeCloseTo(0.2, 10);
  });
});

describe("softmax fallthrough (revision d)", () => {
  const losses = snapshot(
    [
      ["a1", 100],
      ["b1", 20],
      ["c1", -60],
      ["d1", -180],
      ["e1", -400],
    ],
    ["a1", "b1", "c1", "d1", "e1"]
  );

  it("near-zero temperature collapses to the best move", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      expect(selectBotMove(2200, { pBlunder: 0, temperature: 0.15 }, losses, rng)?.uci).toBe("a1");
    }
  });

  it("high temperature spreads across the MultiPV", () => {
    const rng = mulberry32(7);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(selectBotMove(600, { pBlunder: 0, temperature: 6 }, losses, rng)?.uci ?? "");
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("handles mate scores and empty candidate lists", () => {
    const mating: BotSearchSnapshot = snapshot([], []);
    expect(selectBotMove(1400, { pBlunder: 0.2, temperature: 1 }, mating, mulberry32(1))).toBeNull();

    const withMate = snapshot([["h5f7", 0]], ["h5f7"]);
    withMate.deep[0] = { ...info("h5f7", 1, null, 1) };
    const choice = selectBotMove(1400, { pBlunder: 0, temperature: 0.15 }, withMate, mulberry32(1));
    expect(choice?.uci).toBe("h5f7");
    expect(choice?.wpLoss).toBe(0);
  });
});

describe("formula priors (unchanged calibrated-knob formulas)", () => {
  it("matches the spec formulas and clamps", () => {
    expect(formulaParams(600)).toEqual({ pBlunder: 0.45, temperature: 6.0 });
    expect(formulaParams(1400).temperature).toBeCloseTo(3.333, 3);
    expect(formulaParams(3000)).toEqual({ pBlunder: 0.02, temperature: 0.15 });
  });

  it("phaseFactor: 1.4 complex, 0.5 forced", () => {
    expect(phaseFactor(40, false)).toBe(1.4);
    expect(phaseFactor(20, false)).toBe(1);
    expect(phaseFactor(4, false)).toBe(0.5);
    expect(phaseFactor(30, true)).toBe(0.5);
  });
});

describe("policy v2: selectOrganicMove", () => {
  const info = (multipv: number, uci: string, scoreCp: number): EngineInfo => ({
    depth: 4,
    multipv,
    scoreCp,
    mateIn: null,
    pv: [uci],
    nodes: 1000,
    nps: 100000,
  });

  it("returns null with no usable lines", () => {
    expect(selectOrganicMove({ depth: 2, multipv: 4, temperature: 3 }, [], () => 0.5)).toBeNull();
  });

  it("near-zero temperature collapses to the top line", () => {
    const infos = [info(1, "e2e4", 50), info(2, "d2d4", 30), info(3, "g1f3", -200)];
    for (const roll of [0.05, 0.5, 0.95]) {
      const choice = selectOrganicMove(
        { depth: 2, multipv: 3, temperature: 0.05 },
        infos,
        () => roll
      );
      expect(choice?.uci).toBe("e2e4");
    }
  });

  it("high temperature spreads across candidates (rng-driven)", () => {
    const infos = [info(1, "e2e4", 50), info(2, "d2d4", 45), info(3, "g1f3", 40)];
    const picks = new Set(
      [0.05, 0.45, 0.92].map(
        (roll) =>
          selectOrganicMove({ depth: 2, multipv: 3, temperature: 50 }, infos, () => roll)?.uci
      )
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("never reports a blunder branch (v2 has none)", () => {
    const infos = [info(1, "e2e4", 50), info(2, "d2d4", -400)];
    const choice = selectOrganicMove({ depth: 2, multipv: 2, temperature: 2 }, infos, () => 0.1);
    expect(choice?.kind).toBe("sampled");
    expect(choice?.blunderAvailable).toBe(false);
    expect(choice?.effectivePBlunder).toBe(0);
  });
});
