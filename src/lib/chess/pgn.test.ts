import { describe, expect, it } from "vitest";
import { parsePgn, startingPosition } from "chessops/pgn";
import { makeSanAndPlay } from "chessops/san";
import { parseSan } from "chessops/san";
import { formatClk, writePgn, type PgnMeta } from "./pgn";
import { chess960StartFen } from "./chess960";

const meta: PgnMeta = {
  white: "Aaron",
  black: "Fable 1400",
  result: "1-0",
  variant: "standard",
  clock: { mode: "fischer", initialMs: 180_000, incrementMs: 2_000 },
  rated: true,
  playedAt: new Date("2026-08-21T12:00:00Z"),
  termination: "checkmate",
  eco: { eco: "C50", name: "Italian Game" },
};

describe("PGN writer with %clk (Phase 1)", () => {
  it("formats clocks as h:mm:ss", () => {
    expect(formatClk(180_000)).toBe("0:03:00");
    expect(formatClk(59_400)).toBe("0:00:59");
    expect(formatClk(3_723_000)).toBe("1:02:03");
    expect(formatClk(-5)).toBe("0:00:00");
  });

  it("writes headers, %clk comments, and result", () => {
    const pgn = writePgn(meta, [
      { san: "e4", clockMsAfter: 178_500 },
      { san: "e5", clockMsAfter: 179_000 },
      { san: "Qh5", clockMsAfter: 176_000 },
    ]);
    expect(pgn).toContain('[White "Aaron"]');
    expect(pgn).toContain('[TimeControl "180+2"]');
    expect(pgn).toContain('[ECO "C50"]');
    expect(pgn).toContain("1. e4 {[%clk 0:02:58]} e5 {[%clk 0:02:59]} 2. Qh5 {[%clk 0:02:56]}");
    expect(pgn.trim().endsWith("1-0")).toBe(true);
  });

  it("delay modes keep the standard tag honest and add auxiliary tags", () => {
    const pgn = writePgn(
      { ...meta, clock: { mode: "delay", initialMs: 300_000, incrementMs: 5_000 } },
      [{ san: "e4", clockMsAfter: 300_000 }]
    );
    expect(pgn).toContain('[TimeControl "300"]');
    expect(pgn).toContain('[TimeControlMode "delay"]');
    expect(pgn).toContain('[TimeControlDelay "5"]');
  });

  it("chess960 games carry Variant/SetUp/FEN with X-FEN castling", () => {
    const startFen = chess960StartFen(266);
    const pgn = writePgn(
      { ...meta, variant: "chess960", startFen, startPositionId: 266, eco: null },
      [{ san: "d4", clockMsAfter: 100_000 }]
    );
    expect(pgn).toContain('[Variant "Chess960"]');
    expect(pgn).toContain('[StartPosition "SP266"]');
    expect(pgn).toContain(`[FEN "${startFen}"]`);
    expect(startFen.split(" ")[2]).toMatch(/^[A-H]{2}[a-h]{2}$/);
  });

  it("round-trips through chessops' PGN parser, moves and clocks intact", () => {
    const pgn = writePgn(meta, [
      { san: "e4", clockMsAfter: 178_500 },
      { san: "e5", clockMsAfter: 179_000 },
      { san: "Nf3", clockMsAfter: 177_100 },
    ]);
    const games = parsePgn(pgn);
    expect(games).toHaveLength(1);
    const game = games[0]!;
    expect(game.headers.get("White")).toBe("Aaron");

    const position = startingPosition(game.headers).unwrap();
    const sans: string[] = [];
    const comments: string[] = [];
    for (const node of game.moves.mainline()) {
      const move = parseSan(position, node.san);
      expect(move, `parses ${node.san}`).toBeTruthy();
      sans.push(makeSanAndPlay(position, move!));
      for (const comment of node.comments ?? []) comments.push(comment);
    }
    expect(sans).toEqual(["e4", "e5", "Nf3"]);
    expect(comments.join(" ")).toContain("%clk 0:02:58");
  });
});
