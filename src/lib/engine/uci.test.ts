import { describe, expect, it } from "vitest";
import { parseBestmoveLine, parseIdNameLine, parseInfoLine } from "./uci";

describe("UCI info parsing", () => {
  it("parses a real Stockfish 18 info line (captured from the WASM build)", () => {
    const line =
      "info depth 20 seldepth 33 multipv 1 score cp 34 nodes 2146454 nps 2611257 hashfull 196 time 822 pv e2e4 e7e5 g1f3 b8c6 d2d4 e5d4";
    expect(parseInfoLine(line)).toEqual({
      depth: 20,
      multipv: 1,
      scoreCp: 34,
      mateIn: null,
      pv: ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4"],
      nodes: 2146454,
      nps: 2611257,
    });
  });

  it("parses mate scores as mateIn with null cp", () => {
    const line = "info depth 12 multipv 1 score mate -3 nodes 5000 nps 100000 time 50 pv h7h8";
    const info = parseInfoLine(line);
    expect(info?.mateIn).toBe(-3);
    expect(info?.scoreCp).toBeNull();
  });

  it("defaults multipv to 1 when absent", () => {
    const info = parseInfoLine("info depth 8 score cp -50 nodes 1000 nps 1000 pv e7e5");
    expect(info?.multipv).toBe(1);
    expect(info?.scoreCp).toBe(-50);
  });

  it("skips bound reports, currmove chatter, and string lines", () => {
    expect(
      parseInfoLine("info depth 18 multipv 1 score cp 30 lowerbound nodes 1 nps 1 pv e2e4")
    ).toBeNull();
    expect(parseInfoLine("info depth 18 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("info string NNUE evaluation using nn-1c0000000000.nnue")).toBeNull();
    expect(parseInfoLine("bestmove e2e4 ponder e7e5")).toBeNull();
  });

  it("parses bestmove and id name lines", () => {
    expect(parseBestmoveLine("bestmove e2e4 ponder e7e5")).toBe("e2e4");
    expect(parseBestmoveLine("info depth 1")).toBeNull();
    expect(parseIdNameLine("id name Stockfish 18 Lite WASM Multithreaded")).toBe(
      "Stockfish 18 Lite WASM Multithreaded"
    );
  });
});
