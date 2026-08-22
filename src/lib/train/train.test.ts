import { describe, expect, it } from "vitest";
import { bandsForRating, empiricalWhiteWp } from "@/lib/explorer";
import { parseJsonResponse } from "@/lib/llm/client";
import { computePositionTags } from "./position-tags";
import { sm2Next } from "./repertoire";
import { flatPointOf } from "./tempo";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("positionTags (§9.1 — deterministic geometry)", () => {
  it("start position: opening, closed-ish material even, nobody attacking", () => {
    const tags = computePositionTags(START);
    expect(tags.phase).toBe("opening");
    expect(tags.materialBalance).toBe(0);
    expect(tags.sideAttacking).toBe("none");
    expect(tags.hasImbalance).toBe(false);
  });

  it("bare-kings-and-pawns endgame reads endgame with open files", () => {
    const tags = computePositionTags("8/5k2/8/8/8/8/2K2P2/8 w - - 0 40");
    expect(tags.phase).toBe("endgame");
    expect(tags.openness).toBe("open");
    expect(tags.materialBalance).toBe(100);
  });

  it("locked full center with no open files reads closed", () => {
    const tags = computePositionTags(
      "rnbqkbnr/pp4pp/8/2pppp2/2PPPP2/8/PP4PP/RNBQKBNR w KQkq - 0 8"
    );
    expect(tags.openness).toBe("closed");
  });

  it("bishop-pair-vs-knights imbalance is flagged", () => {
    const tags = computePositionTags(
      "r2qk2r/pppppppp/2n2n2/8/8/2B2B2/PPPPPPPP/R2QK2R w KQkq - 0 12"
    );
    expect(tags.hasImbalance).toBe(true);
  });
});

describe("SM-2 (§9.4)", () => {
  it("follows the classic interval ladder on quality 5", () => {
    let state = { easeFactor: 2.5, intervalDays: 0, repetitions: 0 };
    state = sm2Next(state, 5);
    expect(state).toMatchObject({ intervalDays: 1, repetitions: 1 });
    state = sm2Next(state, 5);
    expect(state).toMatchObject({ intervalDays: 6, repetitions: 2 });
    state = sm2Next(state, 5);
    expect(state.repetitions).toBe(3);
    expect(state.intervalDays).toBeGreaterThanOrEqual(15); // 6 × ~2.6
  });

  it("a failed recall resets repetitions but keeps (lowered) ease", () => {
    const state = sm2Next({ easeFactor: 2.5, intervalDays: 6, repetitions: 2 }, 1);
    expect(state.repetitions).toBe(0);
    expect(state.intervalDays).toBe(1);
    expect(state.easeFactor).toBeLessThan(2.5);
  });

  it("ease never drops below 1.3", () => {
    let state = { easeFactor: 1.31, intervalDays: 1, repetitions: 0 };
    for (let i = 0; i < 5; i++) state = sm2Next(state, 0);
    expect(state.easeFactor).toBe(1.3);
  });
});

describe("tempo flat point (§9.3)", () => {
  it("finds where the routine curve stops improving", () => {
    const curve = [
      { fromSeconds: 1, n: 100, meanWpLoss: 4.0 },
      { fromSeconds: 2, n: 100, meanWpLoss: 3.0 },
      { fromSeconds: 4, n: 100, meanWpLoss: 2.2 },
      { fromSeconds: 8, n: 100, meanWpLoss: 2.0 }, // gain 0.2 < 0.5 → flat at 4
      { fromSeconds: 16, n: 100, meanWpLoss: 1.9 },
    ];
    expect(flatPointOf(curve)).toBe(4);
  });

  it("ignores thin buckets and can find no flat point", () => {
    expect(
      flatPointOf([
        { fromSeconds: 1, n: 100, meanWpLoss: 5 },
        { fromSeconds: 2, n: 5, meanWpLoss: 5 },
        { fromSeconds: 4, n: 100, meanWpLoss: 3 },
      ])
    ).toBe(null);
  });
});

describe("explorer helpers", () => {
  it("bandsForRating brackets the rating with its neighbours", () => {
    expect(bandsForRating(1500)).toEqual(["1200", "1400", "1600"]);
    expect(bandsForRating(300)).toEqual(["400", "1000"]);
    expect(bandsForRating(2600)).toEqual(["2200", "2500"]);
  });

  it("empirical WP is white score share, null when the sample is thin", () => {
    expect(
      empiricalWhiteWp({ white: 500, draws: 200, black: 300, moves: [], opening: null })
    ).toBeCloseTo(60);
    expect(
      empiricalWhiteWp({ white: 10, draws: 0, black: 10, moves: [], opening: null })
    ).toBe(null);
  });
});

describe("LLM response hardening (§10)", () => {
  it("strips markdown fences and prose around the JSON", () => {
    expect(
      parseJsonResponse<{ a: number }>('```json\n{"a": 1}\n```')
    ).toEqual({ a: 1 });
    expect(parseJsonResponse<{ a: number }>('Sure! {"a": 2}')).toEqual({ a: 2 });
  });

  it("throws on JSON-free responses", () => {
    expect(() => parseJsonResponse("no json here")).toThrow();
  });
});
