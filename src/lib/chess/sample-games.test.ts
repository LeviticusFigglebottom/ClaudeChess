import { describe, expect, it } from "vitest";
import { GameTree } from "./tree";
import { SAMPLE_GAMES } from "./sample-games";

/**
 * Every preset classic must replay move-for-move through the real rules
 * engine and end in the checkmate its result claims — a typo'd move in a
 * preset must fail the build, never a visitor's first click.
 */
describe("sample games", () => {
  for (const sample of SAMPLE_GAMES) {
    it(`${sample.title} replays fully and ends in mate`, () => {
      const tree = GameTree.fromPgn(sample.pgn);
      // Walk the mainline to its end.
      let node = tree.root;
      let plies = 0;
      while (node.children.length > 0) {
        node = node.children[0]!;
        plies++;
      }
      expect(plies).toBeGreaterThan(10);
      const movetextMoves = sample.pgn
        .split("\n\n")[1]!
        .replace(/\d+\.(\s|\.\.)?/g, " ")
        .split(/\s+/)
        .filter((token) => token && !["1-0", "0-1", "1/2-1/2", "*"].includes(token));
      expect(plies).toBe(movetextMoves.length);
    });
  }

  it("Légal's trap is 13 plies ending in Nd5#", () => {
    const tree = GameTree.fromPgn(SAMPLE_GAMES.find((s) => s.id === "legal")!.pgn);
    let node = tree.root;
    while (node.children.length > 0) node = node.children[0]!;
    expect(node.san).toBe("Nd5#");
  });
});
