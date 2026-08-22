import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { ENGINE_SUPPORTED_VARIANTS, type VariantId } from "@/lib/chess/variant";
import type { EngineInfo } from "./types";
import { parseBestmoveLine, parseInfoLine } from "./uci";

/**
 * Server-side engine for the Phase 2 batch pipeline (§3.3): the vendored
 * Stockfish CLI build as a child process, one process per pool slot. Lives
 * inside src/lib/engine so UCI strings still never escape this module.
 * Distinct from node-engine.ts, which is test/calibration tooling and stays
 * un-imported by app code.
 *
 * Variant guard (invariant): init throws for variants vanilla Stockfish
 * cannot evaluate — a meaningless eval silently corrupts every trainer.
 * Fairy-Stockfish arrives behind this same contract in Phase 4.5.
 */

export interface ServerEngineOpts {
  variant: VariantId;
  hashMb?: number;
}

export interface ServerAnalyzeResult {
  /** Final info per MultiPV line, sorted by multipv — SIDE-TO-MOVE POV. */
  infos: EngineInfo[];
  bestmove: string | null;
}

export class ServerEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(line: string) => void>();
  private buffer = "";
  private lastMultipv = 1;
  private chain: Promise<unknown> = Promise.resolve();
  readonly variant: VariantId;

  constructor(variant: VariantId) {
    this.variant = variant;
  }

  async init(opts: Omit<ServerEngineOpts, "variant"> = {}): Promise<void> {
    if (!ENGINE_SUPPORTED_VARIANTS.includes(this.variant)) {
      throw new Error(
        `engine cannot evaluate variant "${this.variant}" — Fairy-Stockfish lands in Phase 4.5`
      );
    }
    const enginePath = path.resolve(
      process.cwd(),
      "public",
      "engine",
      "stockfish-18-lite-single.js"
    );
    this.child = spawn(process.execPath, [enginePath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        for (const listener of [...this.listeners]) listener(line);
      }
    });

    const ready = this.waitFor((line) => line === "uciok");
    this.send("uci");
    await ready;
    if (this.variant === "chess960") this.send("setoption name UCI_Chess960 value true");
    this.send(`setoption name Hash value ${opts.hashMb ?? 128}`);
    const readyOk = this.waitFor((line) => line === "readyok");
    this.send("isready");
    await readyOk;
  }

  /**
   * Depth-limited MultiPV analysis with a wall-clock safety ceiling: a
   * pathological position that refuses to reach the depth is stopped at
   * `maxMs` and the deepest completed lines are returned.
   */
  analyze(
    fen: string,
    moves: string[],
    opts: { depth: number; multipv: number; maxMs?: number }
  ): Promise<ServerAnalyzeResult> {
    return this.enqueue(async () => {
      if (opts.multipv !== this.lastMultipv) {
        this.lastMultipv = opts.multipv;
        this.send(`setoption name MultiPV value ${opts.multipv}`);
      }
      const suffix = moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
      this.send(`position fen ${fen}${suffix}`);
      const byMultipv = new Map<number, EngineInfo>();
      let bestmove: string | null = null;
      const done = this.waitFor((line) => {
        const info = parseInfoLine(line);
        if (info) byMultipv.set(info.multipv, info);
        const best = parseBestmoveLine(line);
        if (best !== null) {
          bestmove = best === "(none)" ? null : best;
          return true;
        }
        return false;
      });
      const timer = setTimeout(() => this.send("stop"), opts.maxMs ?? 60_000);
      this.send(`go depth ${opts.depth}`);
      await done;
      clearTimeout(timer);
      return {
        infos: [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv),
        bestmove,
      };
    });
  }

  newGame(): void {
    this.send("ucinewgame");
  }

  quit(): void {
    if (!this.child) return;
    try {
      this.send("quit");
    } catch {
      // already gone
    }
    this.child.kill();
    this.child = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private send(command: string): void {
    if (!this.child) throw new Error("server engine not initialized");
    this.child.stdin.write(command + "\n");
  }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const listener = (line: string) => {
        if (predicate(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }
}
