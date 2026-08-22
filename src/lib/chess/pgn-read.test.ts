import { describe, expect, it } from "vitest";
import {
  parseMultiPgn,
  parseTimeControlTag,
  replayPgnGame,
  timeSpentFromClocks,
  variantFromHeader,
} from "./pgn-read";

/** A Lichess-flavoured analysed PGN: %clk + %eval + judgment suffixes + a variation. */
const LICHESS_PGN = `[Event "Rated blitz game"]
[Site "https://lichess.org/AbCd1234"]
[Date "2026.07.14"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[Variant "Standard"]
[TimeControl "300+3"]
[ECO "C50"]

1. e4 { [%eval 0.3] [%clk 0:05:00] } 1... e5 { [%eval 0.25] [%clk 0:05:00] }
2. Nf3 { [%eval 0.2] [%clk 0:04:58] } 2... Nc6 { [%eval 0.3] [%clk 0:04:57] }
3. Bc4 { [%eval 0.15] [%clk 0:04:55] } 3... Nf6?! { [%eval 0.66] [%clk 0:04:40] Inaccuracy. Bc5 was best. } (3... Bc5 4. c3)
4. Ng5 { [%eval 0.55] [%clk 0:04:50] } 4... d5 { [%eval 0.6] [%clk 0:04:35] }
5. exd5 Na5?? { [%eval #3] [%clk 0:04:01] Blunder. Nxd5 was best. } 6. Bb5+ { [%clk 0:04:44] } c6
7. dxc6 1-0`;

const CHESSCOM_960 = `[Event "Live Chess960"]
[Site "Chess.com"]
[White "carol"]
[Black "dave"]
[Result "0-1"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "bqnbnrkr/pppppppp/8/8/8/8/PPPPPPPP/BQNBNRKR w HFhf - 0 1"]
[TimeControl "180"]

1. d4 {[%clk 0:02:58.1]} d5 {[%clk 0:02:57]} 2. Ncd3 {[%clk 0:02:55]} Ncd6 0-1`;

describe("parseMultiPgn", () => {
  it("reads headers, moves, %clk, %eval, suffix NAGs, and skips variations", () => {
    const games = parseMultiPgn(LICHESS_PGN);
    expect(games).toHaveLength(1);
    const game = games[0]!;
    expect(game.headers.White).toBe("alice");
    expect(game.result).toBe("1-0");
    expect(game.moves.map((m) => m.san).slice(0, 6)).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
      "Bc4",
      "Nf6",
    ]);
    const nf6 = game.moves[5]!;
    expect(nf6.nags).toEqual([6]); // ?!
    expect(nf6.evalCp).toBe(66);
    expect(nf6.clockMs).toBe(4 * 60_000 + 40_000);
    expect(nf6.comment).toContain("Inaccuracy");
    const na5 = game.moves.find((m) => m.san === "Na5")!;
    expect(na5.nags).toEqual([4]); // ??
    expect(na5.evalMate).toBe(3);
    expect(na5.evalCp).toBeNull();
    // The variation's moves are not in the mainline.
    expect(game.moves.filter((m) => m.san === "Bc5")).toHaveLength(0);
    // Last move before the result token still lands.
    expect(game.moves.at(-1)?.san).toBe("dxc6");
  });

  it("splits multi-game files", () => {
    const games = parseMultiPgn(`${LICHESS_PGN}\n\n${CHESSCOM_960}`);
    expect(games).toHaveLength(2);
    expect(games[1]?.headers.Variant).toBe("Chess960");
  });

  it("handles $-style NAGs and glued move numbers", () => {
    const games = parseMultiPgn(`[Result "*"]\n\n1.e4 $2 1...c5 $1 2.Nf3 *`);
    const game = games[0]!;
    expect(game.moves.map((m) => m.san)).toEqual(["e4", "c5", "Nf3"]);
    expect(game.moves[0]?.nags).toEqual([2]);
    expect(game.moves[1]?.nags).toEqual([1]);
  });
});

describe("replayPgnGame", () => {
  it("replays a standard game to UCI + FENs", () => {
    const game = replayPgnGame(parseMultiPgn(LICHESS_PGN)[0]!);
    expect(game.variant).toBe("standard");
    expect(game.isDefaultStart).toBe(true);
    expect(game.plies).toHaveLength(13);
    const first = game.plies[0]!;
    expect(first.uci).toBe("e2e4");
    expect(first.color).toBe("w");
    expect(first.fenBefore).toContain("rnbqkbnr/pppppppp");
    const last = game.plies.at(-1)!;
    expect(last.san).toBe("dxc6");
    expect(last.moveNumber).toBe(7);
  });

  it("replays chess960 from its X-FEN start", () => {
    const game = replayPgnGame(parseMultiPgn(CHESSCOM_960)[0]!);
    expect(game.variant).toBe("chess960");
    expect(game.startFen).toContain("bqnbnrkr");
    expect(game.plies).toHaveLength(4);
  });

  it("throws with the ply number on an illegal move", () => {
    const raw = parseMultiPgn(`[Result "*"]\n\n1. e4 e5 2. Ke2 Qh4# 3. Kxh4 *`)[0]!;
    expect(() => replayPgnGame(raw)).toThrow(/ply 5/);
  });

  it("rejects unsupported variants", () => {
    const raw = parseMultiPgn(`[Variant "Antichess"]\n[Result "*"]\n\n1. e3 *`)[0]!;
    expect(() => replayPgnGame(raw)).toThrow(/unsupported variant/);
  });
});

describe("variantFromHeader", () => {
  it("maps platform vocabulary", () => {
    expect(variantFromHeader(undefined)).toBe("standard");
    expect(variantFromHeader("Standard")).toBe("standard");
    expect(variantFromHeader("From Position")).toBe("standard");
    expect(variantFromHeader("Chess960")).toBe("chess960");
    expect(variantFromHeader("Fischerandom")).toBe("chess960");
    expect(variantFromHeader("Three-check")).toBe("threecheck");
    expect(variantFromHeader("King of the Hill")).toBe("koth");
    expect(variantFromHeader("Crazyhouse")).toBe("crazyhouse");
    expect(variantFromHeader("Atomic")).toBeNull();
  });
});

describe("timeSpentFromClocks (§9.3)", () => {
  it("computes think time from clock deltas plus increment", () => {
    const plies = [
      { color: "w" as const, clockMs: 300_000 }, // 5:00 after move (3s inc, thought 3s)
      { color: "b" as const, clockMs: 297_000 }, // thought 6s
      { color: "w" as const, clockMs: 290_000 }, // thought 13s
      { color: "b" as const, clockMs: 299_000 }, // thought 1s (net gain from inc)
    ];
    const spent = timeSpentFromClocks(plies, 300_000, 3_000);
    expect(spent).toEqual([3_000, 6_000, 13_000, 1_000]);
  });

  it("clamps at zero and passes through missing clocks", () => {
    const spent = timeSpentFromClocks(
      [
        { color: "w" as const, clockMs: 310_000 }, // adjourned/odd data → clamp
        { color: "b" as const, clockMs: null },
      ],
      300_000,
      0
    );
    expect(spent).toEqual([0, null]);
  });
});

describe("parseTimeControlTag", () => {
  it("parses fischer, plain, daily, and unknown", () => {
    expect(parseTimeControlTag("300+3")).toEqual({ baseMs: 300_000, incrementMs: 3_000, daily: false });
    expect(parseTimeControlTag("180")).toEqual({ baseMs: 180_000, incrementMs: 0, daily: false });
    expect(parseTimeControlTag("1/86400")).toEqual({ baseMs: 86_400_000, incrementMs: 0, daily: true });
    expect(parseTimeControlTag("-")).toBeNull();
    expect(parseTimeControlTag(undefined)).toBeNull();
  });
});
