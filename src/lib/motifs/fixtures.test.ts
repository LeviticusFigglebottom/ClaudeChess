import { describe, expect, it } from "vitest";
import fixturesJson from "./fixtures.json";
import { detectMotifs, type MotifDetectionInput, type MotifName } from "./detect";

/**
 * C4 gate: the fixture suite. Every fixture must return its expected motif
 * as RANK 1 — a miss is a bug with a reproducible position, not a statistic.
 * Fixtures were curated from Lichess puzzles by theme tag (C6) with
 * geometric mechanism pre-filters, plus handcrafted cases for motifs puzzle
 * data cannot express; tablebase fixtures carry real WDL values probed at
 * build time. See scripts/build-motif-fixtures.mts for the curation rules.
 */

interface Fixture {
  id: string;
  motif: MotifName;
  source: string;
  themes: string[];
  input: MotifDetectionInput;
}

const fixtures = fixturesJson as unknown as Fixture[];

describe("C4 fixture suite", () => {
  it("has meaningful breadth (≥ 140 fixtures, ≥ 16 motifs)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(140);
    const motifs = new Set(fixtures.map((fixture) => fixture.motif));
    expect(motifs.size).toBeGreaterThanOrEqual(16);
    for (const motif of motifs) {
      const count = fixtures.filter((fixture) => fixture.motif === motif).length;
      expect(count, `${motif} fixture count`).toBeGreaterThanOrEqual(2);
    }
  });

  for (const fixture of fixtures) {
    it(`${fixture.id} → ${fixture.motif} at rank 1 (${fixture.source})`, () => {
      const detections = detectMotifs(fixture.input);
      expect(
        detections[0]?.motif,
        `expected ${fixture.motif}, got [${detections.map((d) => d.motif).join(", ")}]`
      ).toBe(fixture.motif);
      expect(detections[0]?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(detections[0]?.evidence).toBeTruthy();
    });
  }
});
