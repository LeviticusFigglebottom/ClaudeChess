import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { EngineInfo } from "./types";
import { parseBestmoveLine, parseInfoLine } from "./uci";

/**
 * Node-side driver for the vendored single-threaded Stockfish build.
 *
 * TEST/TOOLING ONLY — never import from app code. It lives inside
 * src/lib/engine so the "UCI never escapes this module" invariant holds for
 * tooling too. Uses: the G2 perft cross-check, and the Phase 1 calibration
 * arena (self-play bot vs reference Stockfish at a known UCI_Elo).
 *
 * The engine runs as a child process in its CLI mode (stdin/stdout UCI) —
 * the emscripten wrapper sniffs its host environment and behaves differently
 * under worker threads, so in-process loading is a trap; a child process is
 * boring and immune.
 */

export interface NodeEngineOpts {
  chess960: boolean;
  /** Enables UCI_LimitStrength at this Elo (reference opponents). */
  limitStrengthElo?: number;
  hashMb?: number;
}

export interface AnalyzeResult {
  /** Final info per MultiPV line, sorted by multipv (side-to-move POV). */
  infos: EngineInfo[];
  bestmove: string | null;
  /** Search breached its budget and was truncated by `stop` (§3.3). */
  truncated?: boolean;
}

/**
 * §3.3 for the tooling path: a search that breached its budget AND ignored
 * `stop` — the child was killed and respawned; the caller decides what the
 * lost search means (the arena voids the game and lets the line-count
 * checkpoint replay it).
 */
export class NodeEngineWedgedError extends Error {
  constructor(label: string) {
    super(`node engine wedged: ${label} exceeded its budget and ignored stop`);
    this.name = "NodeEngineWedgedError";
  }
}

const STOP_GRACE_MS = 2_000;

export class NodeEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(line: string) => void>();
  private buffer = "";
  private lastMultipv = 1;
  private initOpts: NodeEngineOpts | null = null;
  /** Serializes searches so concurrent calls can't interleave go/stop. */
  private chain: Promise<unknown> = Promise.resolve();

  async init(opts: NodeEngineOpts): Promise<void> {
    this.initOpts = opts;
    const enginePath = path.resolve(
      process.cwd(),
      "public",
      "engine",
      "stockfish-18-lite-single.js"
    );
    this.child = spawn(process.execPath, [enginePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    if (opts.chess960) this.send("setoption name UCI_Chess960 value true");
    if (opts.hashMb) this.send(`setoption name Hash value ${opts.hashMb}`);
    if (opts.limitStrengthElo !== undefined) {
      this.send("setoption name UCI_LimitStrength value true");
      this.send(`setoption name UCI_Elo value ${opts.limitStrengthElo}`);
    }
    const readyOk = this.waitFor((line) => line === "readyok");
    this.send("isready");
    await readyOk;
  }

  /**
   * Fixed-depth MultiPV analysis of a position given as FEN + moves played.
   * With `budgetMs` (§3.3, fitted per shape): breach → `stop` (result comes
   * back `truncated`); `stop` ignored past a 2s grace → the child is KILLED
   * and respawned, and NodeEngineWedgedError is thrown.
   */
  analyze(
    fen: string,
    moves: string[],
    opts: { depth: number; multipv: number },
    budgetMs?: number
  ): Promise<AnalyzeResult> {
    return this.enqueue(async () => {
      if (opts.multipv !== this.lastMultipv) {
        this.lastMultipv = opts.multipv;
        this.send(`setoption name MultiPV value ${opts.multipv}`);
      }
      this.sendPosition(fen, moves);
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
      this.send(`go depth ${opts.depth}`);
      const truncated = await this.awaitWithWatchdog(
        done,
        budgetMs,
        `go depth ${opts.depth} multipv ${opts.multipv}`
      );
      return {
        infos: [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv),
        bestmove,
        truncated,
      };
    });
  }

  /** Timed best-move search (reference opponents under UCI_LimitStrength).
   * Same watchdog contract as analyze(). */
  bestMove(
    fen: string,
    moves: string[],
    movetimeMs: number,
    budgetMs?: number
  ): Promise<string | null> {
    return this.enqueue(async () => {
      if (this.lastMultipv !== 1) {
        this.lastMultipv = 1;
        this.send("setoption name MultiPV value 1");
      }
      this.sendPosition(fen, moves);
      let bestmove: string | null = null;
      const done = this.waitFor((line) => {
        const best = parseBestmoveLine(line);
        if (best !== null) {
          bestmove = best === "(none)" ? null : best;
          return true;
        }
        return false;
      });
      this.send(`go movetime ${movetimeMs}`);
      await this.awaitWithWatchdog(done, budgetMs, `go movetime ${movetimeMs}`);
      return bestmove;
    });
  }

  /**
   * Awaits a search's bestmove with the §3.3 breach ladder. Returns whether
   * the search was truncated by a budget-breach `stop`. On a wedge (stop
   * ignored) the child is killed + respawned and the error propagates.
   */
  private async awaitWithWatchdog(
    done: Promise<string>,
    budgetMs: number | undefined,
    label: string
  ): Promise<boolean> {
    if (!budgetMs) {
      await done;
      return false;
    }
    const BREACH = Symbol("breach");
    const raceTimer = (ms: number) => {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<typeof BREACH>((resolve) => {
        timer = setTimeout(() => resolve(BREACH), ms);
      });
      return {
        run: async () => {
          const first = await Promise.race([done, timeout]);
          clearTimeout(timer!);
          return first;
        },
      };
    };
    if ((await raceTimer(budgetMs).run()) !== BREACH) return false;
    this.send("stop");
    if ((await raceTimer(STOP_GRACE_MS).run()) !== BREACH) return true;
    await this.restart();
    throw new NodeEngineWedgedError(label);
  }

  /** Kill a wedged child and bring up a fresh one with the same options. */
  private async restart(): Promise<void> {
    this.child?.kill("SIGKILL");
    this.child = null;
    this.listeners.clear();
    this.buffer = "";
    this.lastMultipv = 1;
    if (this.initOpts) await this.init(this.initOpts);
  }

  /** Runs `go perft` and returns the node count Stockfish reports. */
  perft(fen: string, depth: number): Promise<number> {
    return this.enqueue(async () => {
      const result = this.waitFor((line) => line.startsWith("Nodes searched:"));
      this.sendPosition(fen, []);
      this.send(`go perft ${depth}`);
      const line = await result;
      return Number(line.split(":")[1]?.trim());
    });
  }

  newGame(): void {
    this.send("ucinewgame");
  }

  quit(): void {
    if (!this.child) return;
    this.send("quit");
    this.child.kill();
    this.child = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private sendPosition(fen: string, moves: string[]): void {
    const suffix = moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
    this.send(`position fen ${fen}${suffix}`);
  }

  private send(command: string): void {
    if (!this.child) throw new Error("node engine not initialized");
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
