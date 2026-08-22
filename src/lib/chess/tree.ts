import { GamePosition } from "./position";
import { START_FEN } from "./fen";
import type { VariantId } from "./variant";

/**
 * Variation tree (A3.1/A3.2). The tree is the analysis board's data model:
 * every node is one move; children[0] is the mainline continuation and the
 * rest are variations, ordered by promotion. `plies` (the DB analysis
 * record) remains the canonical LINEAR mainline — trees are additive,
 * live in study PGNs (RAV), and never feed §9 statistics.
 *
 * Rules and encodings all come from the GamePosition facade; this module
 * adds only structure (and PGN round-tripping with variations, which the
 * import reader deliberately skips).
 */

export interface TreeNode {
  id: number;
  parentId: number | null;
  san: string;
  uci: string;
  fenAfter: string;
  moveNumber: number;
  color: "w" | "b";
  comment: string | null;
  children: TreeNode[];
}

export class GameTree {
  readonly variant: VariantId;
  readonly startFen: string;
  /** Virtual root: fenAfter = start position, san/uci empty. */
  readonly root: TreeNode;
  private nextId = 1;
  private index = new Map<number, TreeNode>();

  constructor(startFen?: string, variant: VariantId = "standard") {
    this.variant = variant;
    this.startFen = startFen ?? START_FEN;
    // Validate the start position eagerly.
    GamePosition.fromFen(this.startFen, variant);
    const startColor = this.startFen.split(" ")[1] === "b" ? "b" : "w";
    const startNumber = Number(this.startFen.split(" ")[5] ?? 1);
    this.root = {
      id: 0,
      parentId: null,
      san: "",
      uci: "",
      fenAfter: this.startFen,
      // Chosen so play()'s child derivation lands the first real move on
      // startNumber: white to move → parent reads black/startNumber−1
      // (increments to startNumber); black to move → white/startNumber.
      moveNumber: startColor === "w" ? startNumber - 1 : startNumber,
      color: startColor === "w" ? "b" : "w",
      comment: null,
      children: [],
    };
    this.index.set(0, this.root);
  }

  node(id: number): TreeNode | null {
    return this.index.get(id) ?? null;
  }

  positionAt(id: number): GamePosition {
    const node = this.index.get(id);
    if (!node) throw new Error(`no tree node ${id}`);
    return GamePosition.fromFen(node.fenAfter, this.variant);
  }

  /**
   * Plays a move from `fromId`. If an identical child already exists it is
   * returned (transposition into an existing line); otherwise a new child is
   * appended (becoming a variation when a mainline child already exists).
   */
  play(
    fromId: number,
    input: { from: string; to: string; promotion?: string } | { san: string } | { uci: string }
  ): TreeNode | null {
    const parent = this.index.get(fromId);
    if (!parent) return null;
    const position = this.positionAt(fromId);
    const move =
      "san" in input
        ? position.moveSan(input.san)
        : "uci" in input
          ? position.moveUci(input.uci)
          : position.move(input);
    if (!move) return null;

    const existing = parent.children.find((child) => child.uci === move.uci);
    if (existing) return existing;

    const node: TreeNode = {
      id: this.nextId++,
      parentId: parent.id,
      san: move.san,
      uci: move.uci,
      fenAfter: position.fen(),
      moveNumber: parent.color === "b" ? parent.moveNumber + 1 : parent.moveNumber,
      color: parent.color === "w" ? "b" : "w",
      comment: null,
      children: [],
    };
    parent.children.push(node);
    this.index.set(node.id, node);
    return node;
  }

  /** Path from root (exclusive) to the node (inclusive). */
  pathTo(id: number): TreeNode[] {
    const path: TreeNode[] = [];
    let current = this.index.get(id) ?? null;
    while (current && current.id !== 0) {
      path.unshift(current);
      current = current.parentId === null ? null : (this.index.get(current.parentId) ?? null);
    }
    return path;
  }

  mainline(): TreeNode[] {
    const line: TreeNode[] = [];
    let current: TreeNode | undefined = this.root.children[0];
    while (current) {
      line.push(current);
      current = current.children[0];
    }
    return line;
  }

  /** Moves the node to the front of its siblings (variation → mainline here). */
  promote(id: number): void {
    const node = this.index.get(id);
    if (!node || node.parentId === null) return;
    const parent = this.index.get(node.parentId);
    if (!parent) return;
    const at = parent.children.indexOf(node);
    if (at > 0) {
      parent.children.splice(at, 1);
      parent.children.unshift(node);
    }
  }

  /** Deletes the node and its whole subtree. */
  deleteFrom(id: number): void {
    const node = this.index.get(id);
    if (!node || node.parentId === null) return;
    const parent = this.index.get(node.parentId);
    if (!parent) return;
    const at = parent.children.indexOf(node);
    if (at !== -1) parent.children.splice(at, 1);
    const drop = (target: TreeNode) => {
      this.index.delete(target.id);
      for (const child of target.children) drop(child);
    };
    drop(node);
  }

  setComment(id: number, comment: string | null): void {
    const node = this.index.get(id);
    if (node && node.id !== 0) node.comment = comment;
  }

  /** Study PGN with variations (RAV) and comments. */
  toPgn(headers: Record<string, string> = {}): string {
    const tags: [string, string][] = [
      ["Event", headers.Event ?? "GAMBIT study"],
      ["Site", "GAMBIT"],
      ["Result", "*"],
    ];
    if (this.variant === "chess960") tags.push(["Variant", "Chess960"]);
    else if (this.variant !== "standard") tags.push(["Variant", this.variant]);
    if (this.startFen !== START_FEN) {
      tags.push(["SetUp", "1"], ["FEN", this.startFen]);
    }
    for (const [key, value] of Object.entries(headers)) {
      if (key !== "Event" && !tags.some(([tag]) => tag === key)) tags.push([key, value]);
    }
    const headerText = tags.map(([key, value]) => `[${key} "${value}"]`).join("\n");
    const movetext = this.root.children.length
      ? writeLine(this.root.children, true)
      : "";
    return `${headerText}\n\n${movetext ? `${movetext} ` : ""}*\n`;
  }

  /** Parses PGN INCLUDING variations into a tree. Throws on illegal SAN. */
  static fromPgn(text: string, variantHint?: VariantId): GameTree {
    const headers: Record<string, string> = {};
    let index = 0;
    const source = text.replace(/^﻿/, "").trim();
    while (index < source.length) {
      while (index < source.length && /\s/.test(source[index]!)) index++;
      if (source[index] !== "[") break;
      const close = source.indexOf("]", index);
      if (close === -1) break;
      const match = source.slice(index + 1, close).match(/^(\w+)\s+"([\s\S]*)"$/);
      if (match) headers[match[1]!] = match[2]!;
      index = close + 1;
    }
    const variant =
      variantHint ??
      (headers.Variant?.toLowerCase().replace(/[\s-]/g, "") === "chess960"
        ? "chess960"
        : "standard");
    const startFen = headers.SetUp === "1" || headers.FEN ? headers.FEN : undefined;
    const tree = new GameTree(startFen, variant);

    // Recursive movetext walk. `anchor` is the node each new move extends;
    // '(' rewinds one move (variation of the LAST move played).
    const stack: number[] = [];
    let anchor = 0;
    let lastPlayed = 0;
    while (index < source.length) {
      const char = source[index]!;
      if (/\s/.test(char)) {
        index++;
        continue;
      }
      if (char === "{") {
        const close = source.indexOf("}", index);
        const body = source.slice(index + 1, close === -1 ? source.length : close).trim();
        if (body && lastPlayed !== 0) {
          const node = tree.node(lastPlayed);
          if (node) node.comment = node.comment ? `${node.comment} ${body}` : body;
        }
        index = close === -1 ? source.length : close + 1;
        continue;
      }
      if (char === "(") {
        stack.push(lastPlayed);
        const node = tree.node(lastPlayed);
        anchor = node?.parentId ?? 0;
        index++;
        continue;
      }
      if (char === ")") {
        lastPlayed = stack.pop() ?? 0;
        anchor = lastPlayed;
        index++;
        continue;
      }
      let end = index;
      while (end < source.length && !/[\s{}()]/.test(source[end]!)) end++;
      const token = source.slice(index, end);
      index = end;
      if (["1-0", "0-1", "1/2-1/2", "*"].includes(token)) continue;
      if (/^\d+\.+$/.test(token) || token.startsWith("$")) continue;
      const san = token.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
      if (!san) continue;
      const played = tree.play(anchor, { san });
      if (!played) throw new Error(`illegal SAN "${san}" in study PGN`);
      anchor = played.id;
      lastPlayed = played.id;
    }
    return tree;
  }
}

function writeLine(children: TreeNode[], forceNumber: boolean): string {
  const main = children[0];
  if (!main) return "";
  const parts: string[] = [];
  parts.push(moveToken(main, forceNumber));
  if (main.comment) parts.push(`{ ${main.comment.replaceAll("}", "")} }`);
  for (const variation of children.slice(1)) {
    const inner = [moveToken(variation, true)];
    if (variation.comment) inner.push(`{ ${variation.comment.replaceAll("}", "")} }`);
    const rest = writeLine(variation.children, false);
    if (rest) inner.push(rest);
    parts.push(`(${inner.join(" ")})`);
  }
  const rest = writeLine(main.children, children.length > 1);
  if (rest) parts.push(rest);
  return parts.join(" ");
}

function moveToken(node: TreeNode, forceNumber: boolean): string {
  if (node.color === "w") return `${node.moveNumber}. ${node.san}`;
  return forceNumber ? `${node.moveNumber}... ${node.san}` : node.san;
}
