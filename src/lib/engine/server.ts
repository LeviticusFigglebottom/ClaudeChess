import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import {
  ENGINE_SUPPORTED_VARIANTS,
  FAIRY_ENGINE_VARIANTS,
  type VariantId,
} from "@/lib/chess/variant";
import { FAIRY_NODE_CLI, FAIRY_UCI_VARIANT } from "./fairy";
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
  /** Deepest completed depth across the returned lines (0 = nothing). */
  reachedDepth: number;
  /**
   * "soft" = the wall-clock budget was exceeded but the engine honored
   * `stop` and returned its deepest lines. The caller decides whether that
   * partial result is acceptable — writing it as if complete is the bug the
   * watchdog exists to prevent.
   */
  breach: "none" | "soft";
}

/**
 * The engine exceeded its budget AND ignored `stop` (the wedged-search
 * failure mode: hours at 100% CPU on one position). The child process has
 * been killed; the engine instance is dead and must be discarded.
 */
export class EngineWedgedError extends Error {
  constructor(
    readonly reachedDepth: number,
    readonly partialInfos: EngineInfo[]
  ) {
    super(`engine wedged: ignored stop after budget (deepest depth ${reachedDepth})`);
  }
}

/** Grace after `stop` before the process is declared wedged and killed. */
const STOP_GRACE_MS = 2_000;

/** Ceiling on `uci`→`uciok`/`isready`→`readyok` during init. A healthy
 * vendored build answers in well under a second; a child that cannot even
 * start (missing file in a serverless bundle, missing wasm sidecar) exits
 * without ever speaking UCI — and before this deadline existed, init would
 * await `uciok` FOREVER, hanging the whole request. Measured on prod
 * (2026-08-22): every /api/analyze call burned the full 300s function
 * budget and died with FUNCTION_INVOCATION_TIMEOUT because of exactly
 * this. A dead child must fail in seconds, with its stderr attached. */
const INIT_BUDGET_MS = 20_000;

export class ServerEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(line: string) => void>();
  /** Pending waitFor rejections — settled when the child dies. */
  private pendingRejects = new Set<(err: Error) => void>();
  private stderrTail = "";
  private exitDiagnosis: string | null = null;
  private buffer = "";
  private lastMultipv = 1;
  private chain: Promise<unknown> = Promise.resolve();
  readonly variant: VariantId;
  /** Test hook: override the engine binary (the synthetic-hang tests). */
  private readonly enginePathOverride: string | null;
  /** Set when the watchdog killed the process — the instance is unusable. */
  dead = false;
  /** Soft budget breaches this session; the pool retires the worker at 3. */
  softBreaches = 0;

  constructor(variant: VariantId, opts: { enginePath?: string } = {}) {
    this.variant = variant;
    this.enginePathOverride = opts.enginePath ?? null;
  }

  async init(opts: Omit<ServerEngineOpts, "variant"> = {}): Promise<void> {
    if (!ENGINE_SUPPORTED_VARIANTS.includes(this.variant)) {
      throw new Error(
        `engine cannot evaluate variant "${this.variant}" — refusing meaningless evals (A1.3)`
      );
    }
    const fairy = FAIRY_ENGINE_VARIANTS.includes(this.variant);
    const enginePath =
      this.enginePathOverride ??
      (fairy
        ? path.resolve(process.cwd(), ...FAIRY_NODE_CLI)
        : path.resolve(process.cwd(), "public", "engine", "stockfish-18-lite-single.js"));
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
    // A child that dies (spawn failure, missing engine file, crash) must
    // reject every pending wait IMMEDIATELY — otherwise a request awaits
    // `uciok`/`bestmove` from a corpse until the platform kills it.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on("error", (err) => this.failPending(`engine process error: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      // `quit()`/`destroy()` clear this.child first — only an UNEXPECTED
      // death reaches pending waiters here.
      if (this.child !== null) {
        this.failPending(`engine process exited (code ${code}, signal ${signal})`);
      }
    });

    const ready = this.waitFor((line) => line === "uciok");
    this.send("uci");
    await this.withInitDeadline(ready, "uciok");
    if (this.variant === "chess960") this.send("setoption name UCI_Chess960 value true");
    if (fairy) {
      this.send(
        `setoption name UCI_Variant value ${FAIRY_UCI_VARIANT[this.variant] ?? this.variant}`
      );
    }
    this.send(`setoption name Hash value ${opts.hashMb ?? 128}`);
    const readyOk = this.waitFor((line) => line === "readyok");
    this.send("isready");
    await this.withInitDeadline(readyOk, "readyok");
  }

  /** Reject every pending wait and mark the instance dead (child died). */
  private failPending(reason: string): void {
    this.exitDiagnosis = `${reason}${this.stderrTail ? ` — stderr: ${this.stderrTail.trim().slice(-500)}` : ""}`;
    this.dead = true;
    this.child = null;
    const rejects = [...this.pendingRejects];
    this.pendingRejects.clear();
    this.listeners.clear();
    for (const reject of rejects) reject(new Error(this.exitDiagnosis));
  }

  private withInitDeadline(wait: Promise<string>, label: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = this.exitDiagnosis ?? this.stderrTail.trim().slice(-500) ?? "";
        this.destroy();
        reject(
          new Error(
            `engine failed to reach ${label} within ${INIT_BUDGET_MS / 1000}s${detail ? ` — ${detail}` : ""}`
          )
        );
      }, INIT_BUDGET_MS);
      wait.then(
        (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        (err: Error) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /**
   * Depth-limited MultiPV analysis under a HARD wall-clock watchdog (§3.3):
   * at `maxMs` the search is told to stop; if the engine returns its lines
   * within the grace window that is a SOFT breach (partial result, breach
   * flagged — the caller decides). If it ignores `stop` — the wedged-search
   * failure mode that burned 2.5h of CPU on one calibration position — the
   * child process is KILLED and EngineWedgedError carries whatever depth was
   * reached. A hung engine can no longer hang the job.
   */
  analyze(
    fen: string,
    moves: string[],
    opts: { depth: number; multipv: number; maxMs?: number }
  ): Promise<ServerAnalyzeResult> {
    return this.enqueue(async () => {
      if (this.dead) throw new EngineWedgedError(0, []);
      if (opts.multipv !== this.lastMultipv) {
        this.lastMultipv = opts.multipv;
        this.send(`setoption name MultiPV value ${opts.multipv}`);
      }
      const suffix = moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
      this.send(`position fen ${fen}${suffix}`);
      const byMultipv = new Map<number, EngineInfo>();
      let bestmove: string | null = null;
      let sawBestmove = false;
      const done = this.waitFor((line) => {
        const info = parseInfoLine(line);
        if (info) byMultipv.set(info.multipv, info);
        const best = parseBestmoveLine(line);
        if (best !== null) {
          bestmove = best === "(none)" ? null : best;
          sawBestmove = true;
          return true;
        }
        return false;
      });

      const budget = opts.maxMs ?? 60_000;
      let breached = false;
      let stopTimer: NodeJS.Timeout | null = null;
      let graceTimer: NodeJS.Timeout | null = null;
      const wedged = new Promise<never>((_, reject) => {
        stopTimer = setTimeout(() => {
          breached = true;
          try {
            this.send("stop");
          } catch {
            // stdin gone — fall through to the grace check
          }
          graceTimer = setTimeout(() => {
            const infos = [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
            const reachedDepth = infos.reduce((max, info) => Math.max(max, info.depth ?? 0), 0);
            // Reject BEFORE destroy: destroy also fails the pending `done`
            // waiter, and the race must settle on the wedge verdict.
            reject(new EngineWedgedError(reachedDepth, infos));
            this.destroy();
          }, STOP_GRACE_MS);
        }, budget);
      });

      this.send(`go depth ${opts.depth}`);
      try {
        await Promise.race([done, wedged]);
      } finally {
        if (stopTimer) clearTimeout(stopTimer);
        if (graceTimer) clearTimeout(graceTimer);
      }
      if (!sawBestmove) {
        // Raced by the wedge rejection — unreachable, but keep the invariant.
        throw new EngineWedgedError(0, []);
      }
      if (breached) this.softBreaches++;
      const infos = [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
      return {
        infos,
        bestmove,
        reachedDepth: infos.reduce((max, info) => Math.max(max, info.depth ?? 0), 0),
        breach: breached ? "soft" : "none",
      };
    });
  }

  /** Kill the child outright and mark the instance dead (watchdog path). */
  private destroy(): void {
    const child = this.child;
    this.child = null;
    this.dead = true;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    // Any wait still pending can never resolve now.
    this.failPending("engine process destroyed by watchdog");
  }

  newGame(): void {
    this.send("ucinewgame");
  }

  quit(): void {
    this.dead = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.write("quit\n");
    } catch {
      // already gone
    }
    child.kill();
    this.failPending("engine quit");
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
    if (this.dead) {
      return Promise.reject(new Error(this.exitDiagnosis ?? "server engine is dead"));
    }
    return new Promise((resolve, reject) => {
      const rejectOnce = (err: Error) => {
        this.listeners.delete(listener);
        reject(err);
      };
      const listener = (line: string) => {
        if (predicate(line)) {
          this.listeners.delete(listener);
          this.pendingRejects.delete(rejectOnce);
          resolve(line);
        }
      };
      this.listeners.add(listener);
      this.pendingRejects.add(rejectOnce);
    });
  }
}
