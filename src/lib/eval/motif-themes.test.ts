import { describe, expect, it } from "vitest";
import { blunderMotifEnum } from "@/db/schema";
import { drillThemesForMotifs, MOTIF_TO_PUZZLE_THEMES } from "./motif-themes";

describe("MOTIF_TO_PUZZLE_THEMES (B1.2)", () => {
  it("covers the entire motif enum, no stragglers", () => {
    expect(Object.keys(MOTIF_TO_PUZZLE_THEMES).sort()).toEqual(
      [...blunderMotifEnum.enumValues].sort()
    );
  });

  it("drillable motifs have themes; non-drillable are explicit and explained", () => {
    for (const [motif, mapping] of Object.entries(MOTIF_TO_PUZZLE_THEMES)) {
      if (mapping.drillable) {
        expect(mapping.themes.length, `${motif} drillable but has no themes`).toBeGreaterThan(0);
      } else {
        expect(mapping.themes, `${motif} not drillable but lists themes`).toEqual([]);
        expect(mapping.note, `${motif} needs a note explaining why`).toBeTruthy();
      }
    }
  });

  it("the three B1.2-named motifs (plus UNCLEAR) are drill-unavailable", () => {
    for (const motif of [
      "PASSIVITY",
      "TUNNEL_VISION_POST_FORCING",
      "TIME_PRESSURE",
      "UNCLEAR",
    ] as const) {
      expect(MOTIF_TO_PUZZLE_THEMES[motif].drillable).toBe(false);
    }
  });

  it("drillThemesForMotifs dedupes across motifs", () => {
    const themes = drillThemesForMotifs(["OVERLOADED_DEFENDER", "REMOVING_THE_DEFENDER"]);
    expect(themes.filter((theme) => theme === "deflection")).toHaveLength(1);
    expect(themes).toContain("capturingDefender");
  });
});
