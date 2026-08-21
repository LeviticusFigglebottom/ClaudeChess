import { describe, expect, it } from "vitest";
import { GamePosition } from "./position";
import { MAX_BOOK_PLY, openingCount, openingForEpd, openingForGame } from "./openings";

/** Plays UCI moves from the start and returns the epd after each ply. */
function epdsFor(uciMoves: string[]): string[] {
  const position = GamePosition.initial();
  const epds: string[] = [];
  for (const uci of uciMoves) {
    if (!position.moveUci(uci)) throw new Error(`bad test move ${uci}`);
    epds.push(position.epd());
  }
  return epds;
}

describe("opening detection (addendum A3.4)", () => {
  it("dataset loaded and sane", () => {
    expect(openingCount()).toBe(3810);
    expect(MAX_BOOK_PLY).toBeGreaterThan(10);
    expect(MAX_BOOK_PLY).toBeLessThan(60);
  });

  it("matches the Ruy Lopez by position", () => {
    const epds = epdsFor(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    const match = openingForEpd(epds.at(-1) as string);
    expect(match?.eco).toBe("C60");
    expect(match?.name).toMatch(/Ruy Lopez/);
  });

  it("deepest hit wins over shallower book positions", () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 Nf6 — the Berlin, deeper than plain C60.
    const epds = epdsFor(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "g8f6"]);
    const match = openingForGame(epds);
    expect(match?.eco).toBe("C65");
    expect(match?.name).toMatch(/Berlin/);
    expect(match?.ply).toBe(6);
  });

  it("out-of-book continuations keep the last book match", () => {
    // Berlin, then two clearly non-book rook-pawn pushes.
    const epds = epdsFor(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "g8f6", "a2a3", "a7a6"]);
    // 4.a3 a6 actually transposes nowhere useful; the deepest book hit is
    // still found by walking backwards.
    const match = openingForGame(epds);
    expect(match).not.toBeNull();
    expect(match?.ply).toBeGreaterThanOrEqual(6);
  });

  it("matching is transposition-aware (epd-keyed, not move-order-keyed)", () => {
    const viaD4 = openingForGame(epdsFor(["d2d4", "d7d5", "g1f3"]));
    const viaNf3 = openingForGame(epdsFor(["g1f3", "d7d5", "d2d4"]));
    expect(viaD4).not.toBeNull();
    expect(viaD4).toEqual(viaNf3);
  });

  it("never matches for non-standard variants (A1.2: BOOK undefined for 960)", () => {
    const epds = epdsFor(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    expect(openingForGame(epds, "chess960")).toBeNull();
    expect(openingForEpd(epds.at(-1) as string, "chess960")).toBeNull();
    expect(openingForEpd(epds.at(-1) as string, "koth")).toBeNull();
  });

  it("start position itself is not a book line", () => {
    expect(openingForEpd(GamePosition.initial().epd())).toBeNull();
  });
});
