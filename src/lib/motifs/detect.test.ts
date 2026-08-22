import { describe, expect, it } from "vitest";
import { detectMotifs, type MotifDetectionInput } from "./detect";

/**
 * Detector behavior on constructed positions. The C4 fixture suite
 * (fixtures.test.ts) covers breadth; these pin the mechanics and the C2.4
 * ranking rules directly.
 */

function base(overrides: Partial<MotifDetectionInput>): MotifDetectionInput {
  return {
    variant: "standard",
    fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    movedUci: "e2e4",
    movedSan: "e4",
    bestPv: [],
    refutationPv: [],
    wpLoss: 30,
    clockMsRemaining: null,
    tbBefore: null,
    tbBeforeHit: false,
    tbAfter: null,
    priorForcingRun: false,
    recentOwnSans: [],
    ...overrides,
  };
}

describe("HANGING_PIECE", () => {
  it("fires when the refutation takes an undefended piece", () => {
    // White just played Bc1–a3?? leaving the bishop en prise to Ra8.
    const detections = detectMotifs(
      base({
        fenBefore: "r3k3/8/8/8/8/8/8/2B1K3 w q - 0 1",
        fenAfter: "r3k3/8/8/8/8/B7/8/4K3 b q - 1 1",
        movedUci: "c1a3",
        movedSan: "Ba3",
        refutationPv: ["a8a3"],
      })
    );
    expect(detections[0]?.motif).toBe("HANGING_PIECE");
    expect(detections[0]?.confidence).toBe(0.9);
    expect(detections[0]?.evidence.square).toBe("a3");
    expect(detections[0]?.evidence.undefended).toBe(true);
  });

  it("downgrades confidence when defended but losing the exchange", () => {
    // White queen walks to d5 where Nc7... construct: queen to a4 defended? Use:
    // white Qd1–h5?? with black g6 pawn: Qh5 defended by nothing, gxh5 wins.
    const detections = detectMotifs(
      base({
        fenBefore: "4k3/8/6p1/8/8/8/6P1/3QK3 w - - 0 1",
        fenAfter: "4k3/8/6p1/7Q/8/8/6P1/4K3 b - - 1 1",
        movedUci: "d1h5",
        movedSan: "Qh5",
        refutationPv: ["g6h5"],
      })
    );
    expect(detections[0]?.motif).toBe("HANGING_PIECE");
  });
});

describe("BACK_RANK", () => {
  it("fires on a mating refutation to the pawn-sealed back rank", () => {
    const detections = detectMotifs(
      base({
        fenBefore: "4r1k1/8/8/8/8/8/R4PPP/6K1 w - - 0 1",
        fenAfter: "4r1k1/R7/8/8/8/8/5PPP/6K1 b - - 1 1",
        movedUci: "a2a7",
        movedSan: "Ra7",
        refutationPv: ["e8e1"],
      })
    );
    expect(detections[0]?.motif).toBe("BACK_RANK");
    expect(detections[0]?.evidence.matingSquare).toBe("e1");
  });

  it("does not fire when the king has luft", () => {
    const detections = detectMotifs(
      base({
        fenBefore: "4r1k1/8/8/8/8/7P/R4PP1/6K1 w - - 0 1",
        fenAfter: "4r1k1/R7/8/8/8/7P/5PP1/6K1 b - - 1 1",
        movedUci: "a2a7",
        movedSan: "Ra7",
        refutationPv: ["e8e1", "g1h2"],
      })
    );
    expect(detections.every((d) => d.motif !== "BACK_RANK")).toBe(true);
  });
});

describe("FORK_ALLOWED", () => {
  it("fires when the refutation lands a royal knight fork", () => {
    // Black Nd4–e2+ forks Kg1 and Qc1 after White's careless Rf1.
    const detections = detectMotifs(
      base({
        fenBefore: "6k1/8/8/8/3n4/8/8/2Q3KR w - - 0 1",
        fenAfter: "6k1/8/8/8/3n4/8/8/2Q2RK1 b - - 1 1",
        movedUci: "h1f1",
        movedSan: "Rf1",
        refutationPv: ["d4e2", "g1g2", "e2c1"],
      })
    );
    const fork = detections.find((d) => d.motif === "FORK_ALLOWED");
    expect(fork).toBeDefined();
    expect(fork?.evidence.forkSquare).toBe("e2");
  });
});

describe("PINNED_PIECE_MOVED", () => {
  it("fires when moving a relatively pinned knight drops the queen", () => {
    // Black Nd6 pinned against Qd8 by Rd1; black plays Nxe4?? and Rxd8.
    const detections = detectMotifs(
      base({
        fenBefore: "3qk3/8/3n4/8/4P3/8/8/3R2K1 b - - 0 1",
        fenAfter: "3qk3/8/8/8/4n3/8/8/3R2K1 w - - 0 1",
        movedUci: "d6e4",
        movedSan: "Nxe4",
        refutationPv: ["d1d8", "e8d8"],
      })
    );
    const pin = detections.find((d) => d.motif === "PINNED_PIECE_MOVED");
    expect(pin).toBeDefined();
    expect(pin?.evidence.behind).toBe("d8");
  });
});

describe("tablebase motifs", () => {
  it("OPPOSITION_LOST outranks ENDGAME_TECHNIQUE in K+P endings on a king move", () => {
    const detections = detectMotifs(
      base({
        variant: "standard",
        fenBefore: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
        fenAfter: "8/8/8/4k3/8/3K4/4P3/8 b - - 1 1",
        movedUci: "e3d3",
        movedSan: "Kd3",
        refutationPv: ["e5e4"],
        tbBefore: { wdl: 2, dtz: 20 },
        tbBeforeHit: true,
        tbAfter: { wdl: 0, dtz: null },
      })
    );
    expect(detections[0]?.motif).toBe("OPPOSITION_LOST");
    expect(detections.map((d) => d.motif)).toContain("ENDGAME_TECHNIQUE");
    expect(detections[0]?.confidence).toBe(1);
  });

  it("no tablebase motif without degradation", () => {
    const detections = detectMotifs(
      base({
        fenBefore: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
        fenAfter: "8/8/8/4k3/8/3K4/4P3/8 b - - 1 1",
        movedUci: "e3d3",
        movedSan: "Kd3",
        tbBefore: { wdl: 2, dtz: 20 },
        tbBeforeHit: true,
        tbAfter: { wdl: -2, dtz: null }, // opponent POV loss = mover still wins
      })
    );
    expect(detections.every((d) => d.evidenceClass !== 6)).toBe(true);
  });
});

describe("data-computed motifs", () => {
  it("TIME_PRESSURE fires under 15s when nothing substantive fired", () => {
    const detections = detectMotifs(
      base({ clockMsRemaining: 8_000, refutationPv: [] })
    );
    expect(detections.some((d) => d.motif === "TIME_PRESSURE")).toBe(true);
  });

  it("TIME_PRESSURE suppressed when a strong motif fired", () => {
    const detections = detectMotifs(
      base({
        fenBefore: "r3k3/8/8/8/8/8/8/2B1K3 w q - 0 1",
        fenAfter: "r3k3/8/8/8/8/B7/8/4K3 b q - 1 1",
        movedUci: "c1a3",
        movedSan: "Ba3",
        refutationPv: ["a8a3"],
        clockMsRemaining: 8_000,
      })
    );
    expect(detections.some((d) => d.motif === "HANGING_PIECE")).toBe(true);
    expect(detections.some((d) => d.motif === "TIME_PRESSURE")).toBe(false);
  });

  it("TUNNEL_VISION_POST_FORCING fires after a forcing run", () => {
    const detections = detectMotifs(base({ priorForcingRun: true }));
    expect(detections.some((d) => d.motif === "TUNNEL_VISION_POST_FORCING")).toBe(true);
  });
});

describe("fallback and ranking", () => {
  it("UNCLEAR when nothing fires", () => {
    const detections = detectMotifs(base({}));
    expect(detections).toHaveLength(1);
    expect(detections[0]?.motif).toBe("UNCLEAR");
  });

  it("ranks SEE-proven above geometric and heuristic (C2.4)", () => {
    // Hanging piece + tunnel vision together: hanging first.
    const detections = detectMotifs(
      base({
        fenBefore: "r3k3/8/8/8/8/8/8/2B1K3 w q - 0 1",
        fenAfter: "r3k3/8/8/8/8/B7/8/4K3 b q - 1 1",
        movedUci: "c1a3",
        movedSan: "Ba3",
        refutationPv: ["a8a3"],
        priorForcingRun: true,
      })
    );
    expect(detections[0]?.motif).toBe("HANGING_PIECE");
    expect(detections.map((d) => d.motif)).toContain("TUNNEL_VISION_POST_FORCING");
  });
});
