import type {
  AnalyzeOpts,
  EngineBuild,
  EngineClient,
  EngineInfo,
  EngineInitOpts,
} from "./types";
import { parseBestmoveLine, parseIdNameLine, parseInfoLine } from "./uci";

/**
 * Async queue backing the analyze() stream: the worker pushes parsed
 * EngineInfo records, the consumer pulls them with for-await.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        // Consumer broke out of for-await: nothing to tear down here — the
        // search keeps running until stop()/a new analyze() supersedes it.
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface ActiveSearch {
  queue: AsyncQueue<EngineInfo>;
  done: Promise<void>;
  resolveDone: () => void;
}

/**
 * EngineClient over a Stockfish WASM worker (spec §3.2). The engine script
 * itself is the worker (`new Worker('/engine/stockfish-18-lite.js')`) — the
 * multithreaded emscripten build spawns its own pthread sub-workers, which is
 * why cross-origin isolation must hold (§3.1). No UCI strings escape this
 * module.
 */
export class StockfishClient implements EngineClient {
  private worker: Worker | null = null;
  private active: ActiveSearch | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private lastMultipv = 1;
  private initialized = false;
  /** Serializes analyze() starts so rapid calls can't interleave go/stop. */
  private startChain: Promise<void> = Promise.resolve();

  /** Engine's self-reported name, for diagnostics ("Stockfish 18 Lite WASM Multithreaded"). */
  engineName: string | null = null;

  constructor(readonly build: EngineBuild) {}

  async init(opts: EngineInitOpts): Promise<void> {
    if (this.worker) throw new Error("engine already initialized");
    const worker = new Worker(this.build.url);
    this.worker = worker;

    const failed = new Promise<never>((_, reject) => {
      worker.onerror = (event) =>
        reject(new Error(`engine worker failed to load: ${event.message ?? "unknown error"}`));
    });

    worker.onmessage = (event: MessageEvent) => this.route(String(event.data));

    this.send("uci");
    await Promise.race([this.waitForLine((l) => l === "uciok"), failed]);

    const threads = Math.max(1, Math.min(opts.threads, this.build.maxThreads));
    this.send(`setoption name Threads value ${threads}`);
    this.send(`setoption name Hash value ${opts.hashMb}`);
    this.send(`setoption name MultiPV value ${this.lastMultipv}`);
    this.send("isready");
    await Promise.race([this.waitForLine((l) => l === "readyok"), failed]);

    worker.onerror = null;
    this.initialized = true;
  }

  setPosition(fen: string, moves?: string[]): void {
    this.assertReady();
    // A position sent mid-search would apply to the *next* search anyway
    // (UCI engines process commands sequentially); stop first so the queued
    // command lands in a quiet engine.
    if (this.active) this.stop();
    const suffix = moves && moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
    this.send(`position fen ${fen}${suffix}`);
  }

  analyze(opts: AnalyzeOpts): AsyncIterable<EngineInfo> {
    this.assertReady();
    const queue = new AsyncQueue<EngineInfo>();

    const start = async () => {
      // Supersede any running search: stop it and wait for its bestmove so
      // commands can't interleave across searches.
      if (this.active) {
        const previous = this.active;
        this.send("stop");
        await previous.done;
      }

      const multipv = opts.multipv ?? 1;
      if (multipv !== this.lastMultipv) {
        this.lastMultipv = multipv;
        this.send(`setoption name MultiPV value ${multipv}`);
        this.send("isready");
        await this.waitForLine((l) => l === "readyok");
      }

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => (resolveDone = resolve));
      this.active = { queue, done, resolveDone };

      const goParts = ["go"];
      if (opts.depth !== undefined) goParts.push("depth", String(opts.depth));
      if (opts.movetimeMs !== undefined) goParts.push("movetime", String(opts.movetimeMs));
      if (opts.depth === undefined && opts.movetimeMs === undefined) goParts.push("infinite");
      this.send(goParts.join(" "));
    };

    this.startChain = this.startChain.then(start).catch(() => queue.end());
    return queue;
  }

  stop(): void {
    if (!this.worker || !this.active) return;
    this.send("stop");
  }

  quit(): void {
    if (!this.worker) return;
    this.send("quit");
    this.worker.terminate();
    this.worker = null;
    this.initialized = false;
    this.active?.queue.end();
    this.active?.resolveDone();
    this.active = null;
  }

  private route(line: string): void {
    const name = parseIdNameLine(line);
    if (name) this.engineName = name;

    for (const listener of [...this.lineListeners]) listener(line);

    if (this.active) {
      const info = parseInfoLine(line);
      if (info) {
        this.active.queue.push(info);
        return;
      }
      if (parseBestmoveLine(line) !== null) {
        this.active.queue.end();
        this.active.resolveDone();
        this.active = null;
      }
    }
  }

  private send(command: string): void {
    if (!this.worker) throw new Error("engine not initialized");
    this.worker.postMessage(command);
  }

  private waitForLine(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const listener = (line: string) => {
        if (predicate(line)) {
          this.lineListeners.delete(listener);
          resolve(line);
        }
      };
      this.lineListeners.add(listener);
    });
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error("engine not initialized — call init() first");
  }
}
