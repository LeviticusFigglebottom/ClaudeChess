import {
  clientBatchCapability,
  newEngineLease,
  releaseEngineLease,
  runClientBatchAnalysis,
  type BatchProgress,
  type EngineLease,
} from "./client-batch";

/**
 * The ANALYSIS RUNNER: a module-level singleton that owns import + batch
 * analysis so the work SURVIVES route changes. Page components used to run
 * the engine loop inside their own lifecycle — navigating to another tab
 * unmounted them, orphaning the engine worker and losing all progress UI
 * (and a revisit booted a duplicate engine). Here the loop lives outside
 * React entirely; pages and the app-shell chip merely subscribe.
 *
 * Scope is one browser tab: a full reload still drops in-flight work (the
 * per-move ingest persistence + auto-resume already cover that loss).
 */

export interface RunnerJob {
  gameId: string;
  label: string;
  /** Full-depth (d24 borderline verification) — BASIC is the default. */
  full?: boolean;
}

export interface RunnerCurrent extends RunnerJob {
  phase: BatchProgress | null;
  serverProgress: { analyzed: number; total: number; verifyRemaining: number } | null;
  note: string | null;
}

export interface RunnerSnapshot {
  running: boolean;
  importing: string | null;
  current: RunnerCurrent | null;
  queue: RunnerJob[];
  lastResult: { gameId: string; ok: boolean; error?: string } | null;
  note: string | null;
  version: number;
}

export type GameEvent = "progress" | "pass" | "done";

const EMPTY: RunnerSnapshot = {
  running: false,
  importing: null,
  current: null,
  queue: [],
  lastResult: null,
  note: null,
  version: 0,
};

type ImportSource = "chesscom" | "lichess";

interface GamesReply {
  games: {
    id: string;
    source: string;
    whiteName: string;
    blackName: string;
    userColor: "white" | "black";
    isStudy: boolean;
    plyCount: number;
    reviewedCount: number;
  }[];
}

/**
 * Which listed games still want analysis. Imported games always have ply
 * rows (created at store time); games played HERE (source "local") get
 * their rows materialized by the first analysis pass, so plyCount 0 on a
 * local game means "never analyzed", not "no moves".
 */
export function needsAnalysis(game: {
  source: string;
  isStudy: boolean;
  plyCount: number;
  reviewedCount: number;
}): boolean {
  if (game.isStudy) return false;
  if (game.plyCount === 0) return game.source === "local";
  return game.reviewedCount < game.plyCount;
}

class AnalysisRunner {
  private queue: RunnerJob[] = [];
  private current: RunnerCurrent | null = null;
  private importing: string | null = null;
  private note: string | null = null;
  private lastResult: RunnerSnapshot["lastResult"] = null;
  private active = false;
  private abort: AbortController | null = null;
  private version = 0;
  private snapshot: RunnerSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private gameListeners = new Map<string, Set<(event: GameEvent) => void>>();

  getSnapshot = (): RunnerSnapshot => this.snapshot;
  getServerSnapshot = (): RunnerSnapshot => EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeGame(gameId: string, listener: (event: GameEvent) => void): () => void {
    let set = this.gameListeners.get(gameId);
    if (!set) {
      set = new Set();
      this.gameListeners.set(gameId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.gameListeners.delete(gameId);
    };
  }

  private emit(): void {
    this.version++;
    this.snapshot = {
      running: this.active,
      importing: this.importing,
      current: this.current ? { ...this.current } : null,
      queue: [...this.queue],
      lastResult: this.lastResult,
      note: this.note,
      version: this.version,
    };
    for (const listener of this.listeners) listener();
  }

  private emitGame(gameId: string, event: GameEvent): void {
    for (const listener of this.gameListeners.get(gameId) ?? []) listener(event);
  }

  has(gameId: string): boolean {
    return this.current?.gameId === gameId || this.queue.some((job) => job.gameId === gameId);
  }

  /** Queue games for analysis (deduplicated); starts the loop if idle. */
  enqueue(jobs: RunnerJob[], opts: { front?: boolean } = {}): void {
    const fresh = jobs.filter((job) => !this.has(job.gameId));
    if (opts.front) this.queue.unshift(...fresh);
    else this.queue.push(...fresh);
    this.note = null;
    this.emit();
    void this.runLoop();
  }

  /** Abort the current game and drop the queue (per-move progress is saved). */
  stop(): void {
    this.queue.length = 0;
    this.abort?.abort();
    this.emit();
  }

  /**
   * The dashboard chain: import every linked source to completion, then
   * queue whatever games are not fully reviewed. Import runs inside the
   * runner for the same reason analysis does — it must survive navigation.
   */
  async syncAndAnalyze(sources: ImportSource[]): Promise<void> {
    if (this.importing !== null) return;
    let imported = 0;
    this.note = null;
    try {
      for (const source of sources) {
        const label = source === "chesscom" ? "chess.com" : "Lichess";
        this.importing = `importing from ${label}…`;
        this.emit();
        for (let chunk = 0; chunk < 40; chunk++) {
          const response = await fetch("/api/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run", source }),
          });
          const body = (await response.json().catch(() => null)) as {
            result?: { imported: number; done: boolean };
            error?: { message: string };
          } | null;
          if (!response.ok || !body?.result) {
            throw new Error(body?.error?.message ?? `import failed (HTTP ${response.status})`);
          }
          imported += body.result.imported;
          this.importing = `importing from ${label}… ${imported}`;
          this.emit();
          if (body.result.done) break;
        }
      }
      const reply = (await (await fetch("/api/games?limit=50")).json()) as GamesReply;
      const todo = (reply.games ?? [])
        .filter(needsAnalysis)
        .map((game) => ({
          gameId: game.id,
          label: `vs ${game.userColor === "black" ? game.whiteName : game.blackName}`,
        }));
      this.note =
        todo.length > 0
          ? null
          : imported > 0
            ? `Imported ${imported} new game${imported === 1 ? "" : "s"} — all analyzed.`
            : "Everything is up to date.";
      if (todo.length > 0) this.enqueue(todo);
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Sync failed.";
    } finally {
      this.importing = null;
      this.emit();
    }
  }

  /** Warm sweep engine shared across the queue (quit when the loop drains). */
  private lease: EngineLease = newEngineLease();

  private async runLoop(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.emit();
    try {
      for (;;) {
        const job = this.queue.shift();
        if (!job) break;
        const abort = new AbortController();
        this.abort = abort;
        const current: RunnerCurrent = { ...job, phase: null, serverProgress: null, note: null };
        this.current = current;
        this.emit();
        let result: { ok: boolean; error?: string };
        const capability = clientBatchCapability();
        if (capability.ok) {
          result = await runClientBatchAnalysis(
            job.gameId,
            (phase) => {
              current.phase = phase;
              this.emit();
              this.emitGame(job.gameId, "progress");
            },
            () => this.emitGame(job.gameId, "pass"),
            abort.signal,
            { full: job.full === true, engines: this.lease }
          );
          if (!result.ok && !abort.signal.aborted) {
            current.note = `client analysis stopped (${result.error}) — finishing on the server`;
            current.phase = null;
            this.emit();
            result = await this.serverAnalyze(job.gameId, job.full === true);
          }
        } else {
          current.note = `server analysis (${capability.reason})`;
          this.emit();
          result = await this.serverAnalyze(job.gameId, job.full === true);
        }
        this.lastResult = { gameId: job.gameId, ok: result.ok, error: result.error };
        this.current = null;
        this.emit();
        this.emitGame(job.gameId, "done");
        if (abort.signal.aborted) {
          this.queue.length = 0;
          break;
        }
      }
    } finally {
      this.active = false;
      this.abort = null;
      releaseEngineLease(this.lease);
      this.emit();
    }
  }

  /** Server-side fallback: the chunked /api/analyze loop (moved intact from
   * review-client so it, too, survives navigation). */
  private async serverAnalyze(
    gameId: string,
    full: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      let retried = false;
      let stalled = 0;
      let lastState = "";
      for (;;) {
        if (this.abort?.signal.aborted) return { ok: false, error: "cancelled" };
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId, full }),
        });
        interface ChunkPayload {
          analyzedPlies?: number;
          progress?: { analyzed: number; total: number };
          verifyRemaining?: number;
          done?: boolean;
          error?: { message: string };
        }
        let body: ChunkPayload | null = null;
        try {
          body = (await response.json()) as ChunkPayload;
        } catch {
          // Platform error pages (e.g. a gateway timeout) are not JSON.
        }
        if (body === null) {
          if (!retried && response.status >= 500) {
            retried = true;
            continue;
          }
          return { ok: false, error: `analysis service error (HTTP ${response.status})` };
        }
        if (!response.ok) {
          return { ok: false, error: body.error?.message ?? "analysis failed" };
        }
        if (this.current) {
          this.current.serverProgress = {
            analyzed: body.progress?.analyzed ?? 0,
            total: body.progress?.total ?? 0,
            verifyRemaining: body.verifyRemaining ?? 0,
          };
          this.emit();
          this.emitGame(gameId, "progress");
        }
        if (body.done) return { ok: true };
        const state = `${body.progress?.analyzed ?? 0}:${body.verifyRemaining ?? 0}`;
        stalled = state === lastState && (body.analyzedPlies ?? 0) === 0 ? stalled + 1 : 0;
        lastState = state;
        if (stalled >= 6) {
          return {
            ok: false,
            error: "Analysis stalled — keeping the plies analyzed so far. Try again later.",
          };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "analysis failed" };
    }
  }
}

export const analysisRunner = new AnalysisRunner();
