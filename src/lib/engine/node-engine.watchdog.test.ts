import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeEngine } from "./node-engine";

/**
 * §3.3 on the tooling path: a budget breach sends `stop` and the result
 * comes back truncated — and the engine stays usable afterwards. (The
 * kill+respawn wedge leg needs a child that IGNORES stop, which the real
 * engine never does — that leg is exercised by the pool's mock-UCI suite
 * in watchdog.test.ts; here we pin the honest-stop ladder end to end.)
 */

let engine: NodeEngine;

beforeAll(async () => {
  engine = new NodeEngine();
  await engine.init({ chess960: false, hashMb: 16 });
}, 30_000);
afterAll(() => {
  engine.quit();
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("NodeEngine watchdog", () => {
  it("budget breach -> stop -> truncated result, engine survives", async () => {
    const truncated = await engine.analyze(START, [], { depth: 30, multipv: 2 }, 50);
    expect(truncated.truncated).toBe(true);

    // The same engine must serve a normal search afterwards.
    const clean = await engine.analyze(START, [], { depth: 8, multipv: 1 }, 30_000);
    expect(clean.truncated).toBe(false);
    expect(clean.bestmove).toBeTruthy();
  }, 60_000);

  it("no budget -> no watchdog involvement", async () => {
    const result = await engine.analyze(START, [], { depth: 6, multipv: 1 });
    expect(result.truncated).toBe(false);
    expect(result.infos.length).toBeGreaterThan(0);
  }, 30_000);
});
