import { describe, expect, it } from "vitest";
import type { EngineInfo } from "@/lib/engine/types";
import { forColor, normalizeInfo, toWhitePovCp, toWhitePovMate } from "./pov";
import { winProbFromEval } from "./winprob";

function info(partial: Partial<EngineInfo>): EngineInfo {
  return { depth: 20, multipv: 1, scoreCp: null, mateIn: null, pv: ["e2e4"], nodes: 0, nps: 0, ...partial };
}

/**
 * Sign-normalization tests (spec §3.2 "Critical", §8 Phase 0 gate).
 *
 * Reference position: k7/8/8/8/8/8/8/KQ6 b - - 0 1 — Black to move, Black is
 * down a full queen and losing. The engine, speaking side-to-move POV, reports
 * a strongly NEGATIVE score. White-POV must come out strongly POSITIVE.
 */
describe("side-to-move → White-POV normalization", () => {
  it("losing-for-black position: black to move, engine says -900 → White-POV +900", () => {
    expect(toWhitePovCp(-900, "b")).toBe(900);
  });

  it("same position from white's side: white to move, engine says +900 → +900", () => {
    expect(toWhitePovCp(900, "w")).toBe(900);
  });

  it("black to move and BETTER: engine says +300 → White-POV -300", () => {
    expect(toWhitePovCp(300, "b")).toBe(-300);
  });

  it("mate scores flip with the mover", () => {
    // Black to move, engine sees itself getting mated in 3 → White mates in 3.
    expect(toWhitePovMate(-3, "b")).toBe(3);
    // Black to move and mating in 2 → White-POV -2.
    expect(toWhitePovMate(2, "b")).toBe(-2);
    expect(toWhitePovMate(5, "w")).toBe(5);
  });

  it("normalizeInfo: black-to-move losing info becomes positive White-POV eval", () => {
    const normalized = normalizeInfo(info({ scoreCp: -880 }), "b");
    expect(normalized).toEqual({ cp: 880, mateIn: null });
    expect(winProbFromEval(normalized)).toBeGreaterThan(90);
  });

  it("normalizeInfo: mate for the black mover becomes negative White-POV mate", () => {
    expect(normalizeInfo(info({ mateIn: 4 }), "b")).toEqual({ cp: null, mateIn: -4 });
  });

  it("forColor flips White-POV to Black-POV and is identity for white", () => {
    expect(forColor({ cp: 250, mateIn: null }, "b")).toEqual({ cp: -250, mateIn: null });
    expect(forColor({ cp: 250, mateIn: null }, "w")).toEqual({ cp: 250, mateIn: null });
    expect(forColor({ cp: null, mateIn: -2 }, "b")).toEqual({ cp: null, mateIn: 2 });
  });
});
