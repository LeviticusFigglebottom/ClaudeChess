import { describe, expect, it } from "vitest";
import { classifyMove, type ClassifyInput } from "./classify";

function base(partial: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    variant: "standard",
    wpBefore: 55,
    wpAfter: 55,
    playedUci: "g1f3",
    bestUci: "e2e4",
    legalMoveCount: 30,
    ...partial,
  };
}

describe("loss bands (§4.2, thresholds corrected to Lichess's actual scale — see LOSS_THRESHOLDS)", () => {
  it("loss < 2 → EXCELLENT", () => {
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 53.5 }))).toBe("EXCELLENT");
  });

  it("loss in [2, 5) → GOOD", () => {
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 51 }))).toBe("GOOD");
  });

  it("loss in [5, 10) → INACCURACY (Lichess ?! at 0.1 winning-chances = 5wp)", () => {
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 48 }))).toBe("INACCURACY");
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 50 }))).toBe("INACCURACY"); // exactly 5
  });

  it("loss in [10, 15) → MISTAKE (Lichess ? at 0.2 = 10wp)", () => {
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 43 }))).toBe("MISTAKE");
    expect(classifyMove(base({ wpBefore: 55, wpAfter: 45 }))).toBe("MISTAKE"); // exactly 10
  });

  it("loss ≥ 15 → BLUNDER (Lichess ?? at 0.3 = 15wp)", () => {
    expect(classifyMove(base({ wpBefore: 60, wpAfter: 45 }))).toBe("BLUNDER"); // exactly 15
    expect(classifyMove(base({ wpBefore: 85, wpAfter: 20 }))).toBe("BLUNDER");
  });

  it("negative loss (engine liked the move more) → EXCELLENT, not an error", () => {
    expect(classifyMove(base({ wpBefore: 50, wpAfter: 54 }))).toBe("EXCELLENT");
  });
});

describe("BEST", () => {
  it("played == MultiPV-1 move → BEST regardless of small loss", () => {
    expect(
      classifyMove(base({ playedUci: "e2e4", bestUci: "e2e4", wpBefore: 55, wpAfter: 54 }))
    ).toBe("BEST");
  });
});

describe("BOOK wins over everything (spec order)", () => {
  it("book position → BOOK even for the engine-best move", () => {
    expect(classifyMove(base({ isBook: true, playedUci: "e2e4", bestUci: "e2e4" }))).toBe("BOOK");
  });

  it("BOOK can never fire outside standard (addendum A1.2/A1.4)", () => {
    expect(
      classifyMove(base({ isBook: true, variant: "chess960", playedUci: "e2e4", bestUci: "e2e4" }))
    ).toBe("BEST");
    expect(
      classifyMove(base({ isBook: true, variant: "koth", playedUci: "e2e4", bestUci: "e2e4" }))
    ).toBe("BEST");
  });
});

describe("GREAT — only-move (spec §4.4)", () => {
  it("pv1-pv2 gap ≥ 15 and player found pv1 → GREAT", () => {
    expect(
      classifyMove(
        base({
          playedUci: "e2e4",
          bestUci: "e2e4",
          multipv: { wpPv1: 60, wpPv2: 44 },
        })
      )
    ).toBe("GREAT");
  });

  it("gap below 15 → BEST, not GREAT", () => {
    expect(
      classifyMove(
        base({ playedUci: "e2e4", bestUci: "e2e4", multipv: { wpPv1: 60, wpPv2: 47 } })
      )
    ).toBe("BEST");
  });

  it("player did not find pv1 → not GREAT", () => {
    expect(
      classifyMove(
        base({
          playedUci: "d2d4",
          bestUci: "e2e4",
          wpBefore: 60,
          wpAfter: 52,
          multipv: { wpPv1: 60, wpPv2: 44 },
        })
      )
    ).toBe("INACCURACY");
  });

  it("only one legal move → excluded from GREAT", () => {
    expect(
      classifyMove(
        base({
          playedUci: "e2e4",
          bestUci: "e2e4",
          legalMoveCount: 1,
          multipv: { wpPv1: 60, wpPv2: 30 },
        })
      )
    ).toBe("BEST");
  });
});

describe("BRILLIANT (spec §4.3 — all conditions must hold)", () => {
  const brilliant = () =>
    base({
      playedUci: "e2e4",
      bestUci: "e2e4",
      wpBefore: 60,
      wpAfter: 62,
      sacrifice: { materialDeltaAfterBestReplyCp: -300, isRecapture: false },
    });

  it("sound sacrifice in a balanced position → BRILLIANT", () => {
    expect(classifyMove(brilliant())).toBe("BRILLIANT");
  });

  it("sacrifice too small (> -200cp) → not BRILLIANT", () => {
    const input = brilliant();
    input.sacrifice = { materialDeltaAfterBestReplyCp: -150, isRecapture: false };
    expect(classifyMove(input)).toBe("BEST");
  });

  it("unsound (loss ≥ 5) → not BRILLIANT", () => {
    const input = brilliant();
    input.wpBefore = 60;
    input.wpAfter = 54;
    input.playedUci = "b2b4";
    expect(classifyMove(input)).toBe("INACCURACY");
  });

  it("already trivially winning (wpBefore ≥ 85) → not BRILLIANT", () => {
    const input = brilliant();
    input.wpBefore = 90;
    input.wpAfter = 91;
    expect(classifyMove(input)).toBe("BEST");
  });

  it("position lost anyway (wpAfter ≤ 40) → not BRILLIANT", () => {
    const input = brilliant();
    input.wpBefore = 38;
    input.wpAfter = 39;
    expect(classifyMove(input)).toBe("BEST");
  });

  it("recapture → not BRILLIANT", () => {
    const input = brilliant();
    input.sacrifice = { materialDeltaAfterBestReplyCp: -300, isRecapture: true };
    expect(classifyMove(input)).toBe("BEST");
  });

  it("forced move → not BRILLIANT", () => {
    const input = brilliant();
    input.legalMoveCount = 1;
    expect(classifyMove(input)).toBe("BEST");
  });
});

describe("MISS (spec §4.2 row)", () => {
  it("best won ≥ +400cp, played kept under half → MISS even at GOOD-sized wp loss", () => {
    expect(
      classifyMove(
        base({
          wpBefore: 80,
          wpAfter: 72,
          miss: { bestEvalCp: 500, bestMateIn: null, playedEvalCp: 180, playedMateIn: null },
        })
      )
    ).toBe("MISS");
  });

  it("best was mate, played move let it slip to a middling eval → MISS", () => {
    expect(
      classifyMove(
        base({
          wpBefore: 100,
          wpAfter: 75,
          miss: { bestEvalCp: null, bestMateIn: 5, playedEvalCp: 250, playedMateIn: null },
        })
      )
    ).toBe("MISS");
  });

  it("played move captured ≥ half of the gain → not a MISS, falls to loss band", () => {
    expect(
      classifyMove(
        base({
          wpBefore: 80,
          wpAfter: 76,
          miss: { bestEvalCp: 500, bestMateIn: null, playedEvalCp: 300, playedMateIn: null },
        })
      )
    ).toBe("GOOD");
  });

  it("played move still forces mate → not a MISS", () => {
    expect(
      classifyMove(
        base({
          playedUci: "d2d4",
          bestUci: "e2e4",
          wpBefore: 100,
          wpAfter: 100,
          miss: { bestEvalCp: null, bestMateIn: 2, playedEvalCp: null, playedMateIn: 6 },
        })
      )
    ).toBe("EXCELLENT");
  });

  it("no big opportunity (< 400cp) → never MISS", () => {
    expect(
      classifyMove(
        base({
          wpBefore: 60,
          wpAfter: 48,
          miss: { bestEvalCp: 350, bestMateIn: null, playedEvalCp: 100, playedMateIn: null },
        })
      )
    ).toBe("MISTAKE");
  });

  it("MISS is checked before the loss bands (a blunder-sized miss reads MISS)", () => {
    expect(
      classifyMove(
        base({
          wpBefore: 95,
          wpAfter: 50,
          miss: { bestEvalCp: 900, bestMateIn: null, playedEvalCp: 0, playedMateIn: null },
        })
      )
    ).toBe("MISS");
  });
});
