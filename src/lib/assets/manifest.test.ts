import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSIFICATION_GLYPHS } from "@/lib/eval/classification-glyphs";
import { CLASSIFICATIONS } from "@/lib/eval/classify";
import { ASSET_MANIFEST, manifestFor } from "./manifest";

const publicDir = path.resolve(__dirname, "../../../public");

function assetDirs(kind: string): string[] {
  const parent = path.join(publicDir, kind);
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${kind}/${entry.name}`);
}

describe("asset manifest (B2.5: no asset lands without an entry)", () => {
  it("every piece-set and sound directory under /public has a manifest entry", () => {
    for (const dir of [...assetDirs("pieces"), ...assetDirs("sounds")]) {
      expect(manifestFor(dir), `missing manifest entry for public/${dir}`).toBeTruthy();
    }
  });

  it("every manifest entry with a publicDir actually ships files", () => {
    for (const entry of ASSET_MANIFEST) {
      if (!entry.publicDir) continue;
      const dir = path.join(publicDir, entry.publicDir);
      expect(existsSync(dir), `${entry.id} points at missing public/${entry.publicDir}`).toBe(true);
      expect(readdirSync(dir).length, `${entry.id} directory is empty`).toBeGreaterThan(0);
    }
  });

  it("entries carry the required fields", () => {
    for (const entry of ASSET_MANIFEST) {
      expect(entry.name).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.license).toBeTruthy();
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("cburnett ships all 12 piece SVGs", () => {
    const dir = path.join(publicDir, "pieces/cburnett");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(
      ["bB", "bK", "bN", "bP", "bQ", "bR", "wB", "wK", "wN", "wP", "wQ", "wR"]
        .map((piece) => `${piece}.svg`)
        .sort()
    );
  });
});

describe("classification glyphs (B2.4 shape-only parity)", () => {
  it("covers every classification", () => {
    expect(Object.keys(CLASSIFICATION_GLYPHS).sort()).toEqual([...CLASSIFICATIONS].sort());
  });

  it("every marked class has a DISTINCT glyph — shape alone carries the information", () => {
    const glyphs = Object.values(CLASSIFICATION_GLYPHS)
      .map((entry) => entry.glyph)
      .filter((glyph): glyph is string => glyph !== null);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("only EXCELLENT and GOOD are unmarked (as in print annotation)", () => {
    const unmarked = Object.entries(CLASSIFICATION_GLYPHS)
      .filter(([, entry]) => entry.glyph === null)
      .map(([classification]) => classification)
      .sort();
    expect(unmarked).toEqual(["EXCELLENT", "GOOD"]);
  });

  it("BLUNDER is the only classification wearing --flag (token discipline)", () => {
    const flagWearers = Object.entries(CLASSIFICATION_GLYPHS)
      .filter(([, entry]) => entry.colorClass === "text-flag")
      .map(([classification]) => classification);
    expect(flagWearers).toEqual(["BLUNDER"]);
  });
});
