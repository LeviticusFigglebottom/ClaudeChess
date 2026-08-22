import { describe, expect, it } from "vitest";
import { GameTree } from "./tree";

/** A3.2 variation tree: structure, promotion, RAV round-trip. */

describe("GameTree", () => {
  it("builds a mainline and returns existing nodes on repeat moves", () => {
    const tree = new GameTree();
    const e4 = tree.play(0, { san: "e4" })!;
    const e5 = tree.play(e4.id, { san: "e5" })!;
    expect(tree.mainline().map((node) => node.san)).toEqual(["e4", "e5"]);
    const again = tree.play(0, { san: "e4" });
    expect(again?.id).toBe(e4.id);
    expect(tree.root.children).toHaveLength(1);
    expect(e5.moveNumber).toBe(1);
    expect(e5.color).toBe("b");
  });

  it("branches variations and promotes them", () => {
    const tree = new GameTree();
    const e4 = tree.play(0, { san: "e4" })!;
    tree.play(e4.id, { san: "e5" });
    const sicilian = tree.play(e4.id, { san: "c5" })!;
    expect(e4.children.map((node) => node.san)).toEqual(["e5", "c5"]);
    expect(tree.mainline().map((node) => node.san)).toEqual(["e4", "e5"]);
    tree.promote(sicilian.id);
    expect(tree.mainline().map((node) => node.san)).toEqual(["e4", "c5"]);
  });

  it("deletes subtrees", () => {
    const tree = new GameTree();
    const e4 = tree.play(0, { san: "e4" })!;
    const e5 = tree.play(e4.id, { san: "e5" })!;
    const nf3 = tree.play(e5.id, { san: "Nf3" })!;
    tree.deleteFrom(e5.id);
    expect(tree.mainline().map((node) => node.san)).toEqual(["e4"]);
    expect(tree.node(e5.id)).toBeNull();
    expect(tree.node(nf3.id)).toBeNull();
  });

  it("round-trips PGN with nested variations and comments", () => {
    const tree = new GameTree();
    const e4 = tree.play(0, { san: "e4" })!;
    const e5 = tree.play(e4.id, { san: "e5" })!;
    tree.setComment(e5.id, "classical");
    const c5 = tree.play(e4.id, { san: "c5" })!;
    const nf3 = tree.play(c5.id, { san: "Nf3" })!;
    tree.play(nf3.id, { san: "d6" });
    tree.play(nf3.id, { san: "Nc6" });
    tree.play(e5.id, { san: "Nf3" });

    const pgn = tree.toPgn({ Event: "Test study" });
    expect(pgn).toContain("1. e4 e5");
    expect(pgn).toContain("(1... c5 2. Nf3 d6 (2... Nc6))");
    expect(pgn).toContain("{ classical }");

    const parsed = GameTree.fromPgn(pgn);
    expect(parsed.mainline().map((node) => node.san)).toEqual(["e4", "e5", "Nf3"]);
    const parsedE4 = parsed.root.children[0]!;
    expect(parsedE4.children.map((node) => node.san)).toEqual(["e5", "c5"]);
    const parsedC5 = parsedE4.children[1]!;
    expect(parsedC5.children[0]?.san).toBe("Nf3");
    expect(parsedC5.children[0]?.children.map((node) => node.san)).toEqual(["d6", "Nc6"]);
    expect(parsed.root.children[0]?.children[0]?.comment).toBe("classical");
  });

  it("supports chess960 studies from an X-FEN start", () => {
    const tree = new GameTree(
      "bqnbnrkr/pppppppp/8/8/8/8/PPPPPPPP/BQNBNRKR w HFhf - 0 1",
      "chess960"
    );
    const d4 = tree.play(0, { san: "d4" })!;
    expect(d4.fenAfter).toContain("HFhf");
    const pgn = tree.toPgn();
    expect(pgn).toContain('[Variant "Chess960"]');
    expect(pgn).toContain('[FEN "bqnbnrkr');
    const parsed = GameTree.fromPgn(pgn);
    expect(parsed.variant).toBe("chess960");
    expect(parsed.mainline()[0]?.san).toBe("d4");
  });

  it("parses variations that begin at the game's first move", () => {
    const tree = GameTree.fromPgn("1. e4 (1. d4 d5) 1... e5 *");
    expect(tree.root.children.map((node) => node.san)).toEqual(["e4", "d4"]);
    expect(tree.mainline().map((node) => node.san)).toEqual(["e4", "e5"]);
  });

  it("throws on illegal SAN instead of silently truncating", () => {
    expect(() => GameTree.fromPgn("1. e4 e5 2. Ke2 Qh4 3. Kf3 *")).not.toThrow();
    expect(() => GameTree.fromPgn("1. e4 e5 2. Qh7 *")).toThrow(/illegal SAN/);
  });
});
