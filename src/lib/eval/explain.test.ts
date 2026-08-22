import { describe, expect, it } from "vitest";
import { evalLabel, explainPly } from "./explain";

const base = {
  san: "Qxb7",
  wpLoss: 23.4,
  playedIsBest: false,
  bestSan: "Nf3",
  mateAfterWhitePov: null,
  moverIsWhite: true,
  motifs: [],
  provisional: false,
  degraded: false,
};

describe("explainPly", () => {
  it("names the mechanism on a blunder", () => {
    const { verdict, notes } = explainPly({
      ...base,
      classification: "BLUNDER",
      motifs: [{ motif: "FORK_ALLOWED", evidence: { square: "e5" } }],
    });
    expect(verdict).toBe("A blunder — 23 win-% thrown away: it walks into a fork (e5).");
    expect(notes).toContain("Better was Nf3.");
  });

  it("leads with the mate when one is now forced", () => {
    const { verdict } = explainPly({
      ...base,
      classification: "BLUNDER",
      mateAfterWhitePov: -3,
    });
    expect(verdict).toBe("A blunder — Black now has forced mate in 3.");
  });

  it("marks provisional plies and never suggests 'better' on best moves", () => {
    const { verdict, notes } = explainPly({
      ...base,
      classification: "BEST",
      playedIsBest: true,
      provisional: true,
    });
    expect(verdict).toBe("The engine's first choice.");
    expect(notes.some((note) => note.startsWith("Better was"))).toBe(false);
    expect(notes.some((note) => note.startsWith("Provisional"))).toBe(true);
  });

  it("phrases a MISS around the forgone chance", () => {
    const { verdict } = explainPly({
      ...base,
      classification: "MISS",
      motifs: [{ motif: "MISSED_FORK", evidence: null }],
    });
    expect(verdict).toBe("A win goes begging — Nf3 was the chance (a fork was available).");
  });
});

describe("evalLabel", () => {
  it("formats cp and mate White-POV", () => {
    expect(evalLabel(83, null)).toBe("+0.83");
    expect(evalLabel(-120, null)).toBe("−1.20");
    expect(evalLabel(null, 5)).toBe("#5");
    expect(evalLabel(null, -3)).toBe("−#3");
    expect(evalLabel(0, null)).toBe("0.00");
    expect(evalLabel(null, null)).toBeNull();
  });
});
