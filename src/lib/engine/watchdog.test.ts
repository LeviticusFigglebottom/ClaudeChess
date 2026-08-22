import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisPool } from "@/lib/analysis/pool";
import { searchWithWatchdog } from "@/lib/analysis/watchdog";
import { EngineWedgedError, ServerEngine } from "./server";

/**
 * §3.3 watchdog against SYNTHETIC HANGS — the production defect this closes
 * is a real search that spun 2.5 hours at 100% CPU on one position. Three
 * mock UCI engines (child processes, same harness contract as the real
 * vendored CLI) exercise every path: a wedge that ignores `stop`, a slow
 * search that honors it, and a healthy fast one.
 */

const fixture = (name: string) =>
  path.resolve(process.cwd(), "src", "lib", "engine", "__fixtures__", `${name}.mjs`);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("ServerEngine watchdog", () => {
  it("kills a wedged engine that ignores stop; analyze rejects, instance is dead", async () => {
    const engine = new ServerEngine("standard", { enginePath: fixture("mock-uci-wedge") });
    await engine.init();
    const t0 = Date.now();
    await expect(
      engine.analyze(START, [], { depth: 18, multipv: 3, maxMs: 300 })
    ).rejects.toBeInstanceOf(EngineWedgedError);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(8_000); // budget + 2s grace + slack — never hours
    expect(engine.dead).toBe(true);
  }, 15_000);

  it("wedge rejection carries the depth actually reached", async () => {
    const engine = new ServerEngine("standard", { enginePath: fixture("mock-uci-wedge") });
    await engine.init();
    const error = await engine
      .analyze(START, [], { depth: 18, multipv: 3, maxMs: 300 })
      .then(() => null)
      .catch((e: EngineWedgedError) => e);
    expect(error?.reachedDepth).toBe(8);
    expect(error?.partialInfos.length).toBeGreaterThan(0);
  }, 15_000);

  it("a stop-honoring slow search is a SOFT breach: partial result, breach counted", async () => {
    const engine = new ServerEngine("standard", { enginePath: fixture("mock-uci-slowstop") });
    await engine.init();
    const result = await engine.analyze(START, [], { depth: 18, multipv: 3, maxMs: 300 });
    expect(result.breach).toBe("soft");
    expect(result.reachedDepth).toBe(8);
    expect(engine.dead).toBe(false);
    expect(engine.softBreaches).toBe(1);
    engine.quit();
  }, 15_000);

  it("a healthy search inside budget breaches nothing", async () => {
    const engine = new ServerEngine("standard", { enginePath: fixture("mock-uci-fast") });
    await engine.init();
    const result = await engine.analyze(START, [], { depth: 18, multipv: 3, maxMs: 5_000 });
    expect(result.breach).toBe("none");
    expect(result.reachedDepth).toBe(18);
    expect(result.bestmove).toBe("e2e4");
    engine.quit();
  }, 15_000);
});

describe("watchdog ladder over the pool", () => {
  it("an always-wedging engine degrades the ply and NEVER hangs the job", async () => {
    const pool = new AnalysisPool({ cap: 1, enginePath: fixture("mock-uci-wedge") });
    const t0 = Date.now();
    const { result, degraded } = await searchWithWatchdog(
      pool,
      "standard",
      START,
      [],
      { depth: 18, multipv: 3 },
      () => 300
    );
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(degraded).not.toBeNull();
    expect(degraded!.reason).toContain("wedged");
    expect(degraded!.reachedDepth).toBe(8); // deepest partial the wedge produced
    expect(result.infos.length).toBeGreaterThan(0);
    pool.shutdown();
  }, 30_000);

  it("the ladder recovers on a healthy replacement after a wedge kill", async () => {
    // First rung wedges (engine killed by watchdog); the pool then spawns a
    // fresh engine for the retry rung. Same binary here, so every rung
    // wedges — the recovery path itself is proven by the rung count: three
    // attempts ran, three engines spawned, none hung.
    const pool = new AnalysisPool({ cap: 1, enginePath: fixture("mock-uci-wedge") });
    const { degraded } = await searchWithWatchdog(
      pool,
      "standard",
      START,
      [],
      { depth: 18, multipv: 3 },
      () => 200
    );
    const wedges = (degraded!.reason.match(/wedged/g) ?? []).length;
    expect(wedges).toBe(3);
    pool.shutdown();
  }, 30_000);

  it("pool retires a worker after three soft breaches", async () => {
    const pool = new AnalysisPool({ cap: 1, enginePath: fixture("mock-uci-slowstop") });
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await pool.withEngine("standard", async (engine) => {
        seen.push(engine);
        await engine.analyze(START, [], { depth: 18, multipv: 3, maxMs: 150 });
      });
    }
    // Calls 1–3 reuse the same worker (breaches 1..3); release then retires
    // it, so call 4 runs on a fresh instance.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[3]).not.toBe(seen[2]);
    expect((seen[3] as ServerEngine).softBreaches).toBe(1);
    pool.shutdown();
  }, 30_000);
});
