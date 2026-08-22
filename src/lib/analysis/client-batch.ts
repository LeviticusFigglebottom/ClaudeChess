import { createEngine } from "@/lib/engine";
import type { EngineInfo } from "@/lib/engine/types";
import { GamePosition } from "@/lib/chess/position";
import type { VariantId } from "@/lib/chess/variant";
import { ANALYSIS_SETTINGS } from "@/lib/eval";
import { needsVerify, VERIFY_RULES } from "./verify-rules";

/**
 * CLIENT-SIDE batch analysis (the §3.3 revision): the browser's
 * multi-threaded WASM engine — several times faster than a 1-vCPU
 * serverless instance — does the searching; every result streams to the
 * server ingest route, which derives wp/classifications/motifs through the
 * SAME code as the server-search path. Progressive depth (§4.6):
 *
 *   pass 1  depth 12 · MultiPV 3  → provisional classifications, visible
 *                                    immediately, §9-excluded
 *   pass 2  depth 18 · MultiPV 3  → the review record, updated in place
 *   pass 3  depth 24 · MultiPV 1  → §4.2 borderline verification
 *
 * Wall-clock structure: ingest flushes are DOUBLE-BUFFERED (one request in
 * flight while the engine keeps searching), and on machines with ≥6 cores a
 * SECOND engine instance runs the d24 verify pass CONCURRENTLY with pass 2,
 * fed by the ingest responses' verify-ready candidates — total time becomes
 * ~max(sweep, verify) instead of their sum. Below 6 cores both engines
 * would just fight for the same cores, so the verify pass stays serial
 * (with a position cache — adjacent borderline plies share a position).
 *
 * Streaming is per-position with one-position batch overlap (the ingest
 * contract: a ply is written when its two positions arrive together), so a
 * closed tab loses only in-flight work and the driver resumes from the
 * stored analyzedAtDepth state. Positions the engine cannot finish inside
 * the client timeout are SKIPPED — the finalize call hands them to the
 * server fallback rather than writing anything below the requested depth.
 */

export interface BatchProgress {
  phase: "boot" | "pass1" | "pass2" | "pass3" | "finalize";
  done: number;
  total: number;
}

interface DriverPly {
  ply: number;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  classification: string | null;
  wpLoss: number | null;
  analyzedAtDepth: number | null;
  degraded: boolean;
}

interface DriverPayload {
  game: { variant: string; startFen: string | null };
  plies: DriverPly[];
}

interface IngestReply {
  verifyRemaining: number;
  verifyReadyPlies?: number[];
  error?: { message: string };
}

type BatchEntry = { index: number; lines: EngineInfo[] | "terminal" };

/** Capability gate: client-first only where it is actually faster. */
export function clientBatchCapability(): { ok: boolean; reason: string } {
  if (typeof crossOriginIsolated === "undefined" || !crossOriginIsolated) {
    return { ok: false, reason: "no cross-origin isolation (single-threaded engine)" };
  }
  const cores = navigator.hardwareConcurrency ?? 0;
  if (cores < 4) {
    return { ok: false, reason: `${cores} cores — below the 4-core client threshold` };
  }
  return { ok: true, reason: `${cores} cores, isolated` };
}

const BATCH_FLUSH_AT = 12;
const PASS_TIMEOUT_MS: Record<number, number> = { 12: 12_000, 18: 45_000, 24: 120_000 };
/** Concurrent verifier only when a second engine won't starve the sweep. */
const PIPELINE_MIN_CORES = 6;

async function fetchRows(gameId: string): Promise<DriverPayload> {
  const response = await fetch(`/api/games/${gameId}`);
  const body = (await response.json()) as DriverPayload & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

function isTerminal(fen: string, variant: VariantId): boolean {
  try {
    const position = GamePosition.fromFen(fen, variant);
    return (
      position.outcome() !== null ||
      position.isStalemate() ||
      position.isInsufficientMaterial()
    );
  } catch {
    return false;
  }
}

export async function runClientBatchAnalysis(
  gameId: string,
  onProgress: (progress: BatchProgress) => void,
  onPassComplete: (pass: 1 | 2 | 3) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  onProgress({ phase: "boot", done: 0, total: 1 });
  let payload = await fetchRows(gameId);
  const variant = payload.game.variant as VariantId;
  const rows = payload.plies;
  if (rows.length === 0) return { ok: false, error: "no moves to analyze" };
  const startFen = payload.game.startFen ?? rows[0]!.fenBefore;
  const movesUci = rows.map((row) => row.uci);
  const fenAt = (index: number) => (index === 0 ? rows[0]!.fenBefore : rows[index - 1]!.fenAfter);

  // Batch threading policy, independent of the interactive default (which
  // the bot calibration measured against and which stays capped at 4): the
  // tab does nothing else during batch analysis. With the concurrent
  // verifier the budget splits between the two instances.
  const cores = navigator.hardwareConcurrency ?? 2;
  const pipelined = cores >= PIPELINE_MIN_CORES;
  const sweepThreads = pipelined
    ? Math.max(2, Math.min(cores - 3, 6))
    : Math.max(1, Math.min(cores - 1, 8));
  const verifyThreads = pipelined ? 2 : 0;

  const bootEngine = async (threads: number) => {
    const engine = createEngine();
    await Promise.race([
      engine.init({ threads, hashMb: 128, variant }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("engine boot timeout")), 12_000)
      ),
    ]);
    return engine;
  };

  let sweepEngine: ReturnType<typeof createEngine>;
  try {
    sweepEngine = await bootEngine(sweepThreads);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "engine boot failed" };
  }

  const searchPosition = async (
    engine: ReturnType<typeof createEngine>,
    index: number,
    depth: number,
    multipv: number
  ): Promise<EngineInfo[] | null> => {
    const timeoutMs = PASS_TIMEOUT_MS[depth] ?? 60_000;
    engine.setPosition(startFen, movesUci.slice(0, index));
    const stream = engine.analyze({ depth, multipv });
    const byMultipv = new Map<number, EngineInfo>();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      engine.stop();
    }, timeoutMs);
    try {
      for await (const info of stream) byMultipv.set(info.multipv, info);
    } finally {
      clearTimeout(timer);
    }
    const lines = [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
    if (lines.length === 0) return null;
    // A timed-out search below the requested depth is SKIPPED, not written —
    // the server fallback finishes it at full depth (never a silent shortfall).
    if (timedOut && (lines[0]!.depth ?? 0) < depth) return null;
    return lines;
  };

  // Double-buffered ingest: at most one flush in flight; its response's
  // verify-ready candidates feed the concurrent verifier.
  let inFlight: Promise<IngestReply | null> = Promise.resolve(null);
  const verifyQueue: number[] = [];
  const queued = new Set<number>();
  let sweepDone = false;

  const postIngest = async (depth: number, batch: BatchEntry[]): Promise<IngestReply | null> => {
    if (batch.length < 2) return null;
    const response = await fetch("/api/analyze/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameId,
        positions: batch.map((entry) => ({
          index: entry.index,
          depth,
          lines:
            entry.lines === "terminal"
              ? []
              : entry.lines.map((info) => ({
                  multipv: info.multipv,
                  depth: info.depth,
                  scoreCp: info.scoreCp,
                  mateIn: info.mateIn,
                  pv: info.pv.slice(0, 32),
                })),
        })),
      }),
    });
    const body = (await response.json().catch(() => null)) as IngestReply | null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `ingest failed (HTTP ${response.status})`);
    }
    return body;
  };

  const enqueueCandidates = (reply: IngestReply | null) => {
    for (const ply of reply?.verifyReadyPlies ?? []) {
      if (!queued.has(ply)) {
        queued.add(ply);
        verifyQueue.push(ply);
      }
    }
  };

  /** Await the previous flush (collecting its candidates), start the next. */
  const flush = async (depth: number, batch: BatchEntry[]): Promise<void> => {
    enqueueCandidates(await inFlight);
    inFlight = postIngest(depth, batch);
  };

  /** Run one sweep pass over a contiguous position range. */
  const runPass = async (
    phase: "pass1" | "pass2",
    depth: number,
    firstPosition: number,
    lastPosition: number
  ): Promise<void> => {
    const count = lastPosition - firstPosition + 1;
    let pending: BatchEntry[] = [];
    let done = 0;
    onProgress({ phase, done, total: count });
    for (let index = firstPosition; index <= lastPosition; index++) {
      if (signal?.aborted) throw new Error("cancelled");
      const fen = fenAt(index);
      if (isTerminal(fen, variant)) {
        pending.push({ index, lines: "terminal" });
      } else {
        const lines = await searchPosition(
          sweepEngine,
          index,
          depth,
          ANALYSIS_SETTINGS.review.multipv
        );
        if (lines === null) {
          // Skip breaks the pair chain; ship what we have and continue —
          // the ply on each side of the gap falls to the server fallback.
          await flush(depth, pending);
          pending = [];
          done++;
          onProgress({ phase, done, total: count });
          continue;
        }
        pending.push({ index, lines });
      }
      if (pending.length >= BATCH_FLUSH_AT) {
        await flush(depth, pending);
        pending = [pending[pending.length - 1]!]; // one-position overlap
      }
      done++;
      onProgress({ phase, done, total: count });
    }
    await flush(depth, pending);
    enqueueCandidates(await inFlight);
    inFlight = Promise.resolve(null);
  };

  /** Verify one borderline ply (a d24:1 pair) on the given engine. */
  const d24Cache = new Map<number, EngineInfo[] | "terminal" | null>();
  const verifyPly = async (
    engine: ReturnType<typeof createEngine>,
    ply: number
  ): Promise<void> => {
    const pair: BatchEntry[] = [];
    for (const index of [ply - 1, ply]) {
      let lines = d24Cache.get(index);
      if (lines === undefined) {
        const fen = fenAt(index);
        lines = isTerminal(fen, variant)
          ? "terminal"
          : await searchPosition(engine, index, VERIFY_RULES.depth, 1);
        d24Cache.set(index, lines);
      }
      if (lines !== null) pair.push({ index, lines });
    }
    if (pair.length === 2) await postIngest(VERIFY_RULES.depth, pair);
  };

  let verifierError: Error | null = null;
  let verifyEngine: ReturnType<typeof createEngine> | null = null;
  const verifierLoop = async (engine: ReturnType<typeof createEngine>): Promise<number> => {
    let verified = 0;
    for (;;) {
      const ply = verifyQueue.shift();
      if (ply === undefined) {
        if (sweepDone) return verified;
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      if (signal?.aborted) throw new Error("cancelled");
      await verifyPly(engine, ply);
      verified++;
    }
  };

  try {
    const needsPass = (row: DriverPly, depth: number) =>
      !row.degraded && (row.analyzedAtDepth ?? 0) < depth;

    // Concurrent verifier (≥6 cores): boots alongside pass 1/2 and consumes
    // candidates as ingest reports them ready.
    let verifierRun: Promise<number> | null = null;
    if (pipelined) {
      try {
        verifyEngine = await bootEngine(verifyThreads);
        verifierRun = verifierLoop(verifyEngine).catch((error: Error) => {
          verifierError = error;
          return 0;
        });
      } catch {
        verifyEngine = null; // verify falls back to the serial tail
      }
    }

    for (const [phase, depth] of [
      ["pass1", ANALYSIS_SETTINGS.provisional.depth],
      ["pass2", ANALYSIS_SETTINGS.review.depth],
    ] as const) {
      const targets = rows.filter((row) => needsPass(row, depth));
      if (targets.length === 0) continue;
      const firstPosition = Math.max(0, targets[0]!.ply - 1);
      const lastPosition = targets[targets.length - 1]!.ply;
      await runPass(phase, depth, firstPosition, lastPosition);
      onPassComplete(phase === "pass1" ? 1 : 2);
      payload = await fetchRows(gameId);
      rows.splice(0, rows.length, ...payload.plies);
    }
    sweepDone = true;

    // Drain the concurrent verifier, then serially finish whatever remains
    // (pipeline disabled, verifier died, or neighbour-deferred candidates).
    if (verifierRun) {
      onProgress({ phase: "pass3", done: 0, total: queued.size || 1 });
      await verifierRun;
      verifyEngine?.quit();
      verifyEngine = null;
      // (indirection: TS cannot see the catch-callback assignment)
      const verifierProblem = verifierError as Error | null;
      if (verifierProblem) console.info(`[batch] verifier degraded: ${verifierProblem.message}`);
    }
    payload = await fetchRows(gameId);
    rows.splice(0, rows.length, ...payload.plies);
    const remaining = rows.filter((row) => needsVerify(row));
    if (remaining.length > 0) {
      let done = 0;
      onProgress({ phase: "pass3", done, total: remaining.length });
      for (const row of remaining) {
        if (signal?.aborted) throw new Error("cancelled");
        await verifyPly(sweepEngine, row.ply);
        done++;
        onProgress({ phase: "pass3", done, total: remaining.length });
      }
    }
    onPassComplete(3);

    // Finalize: the server completes anything skipped, runs any remaining
    // verification, then derives motifs/volatility/fair-play. Usually one call.
    console.info("[batch] finalize");
    onProgress({ phase: "finalize", done: 0, total: 1 });
    for (let call = 0; call < 40; call++) {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const body = (await response.json().catch(() => null)) as {
        done?: boolean;
        error?: { message: string };
      } | null;
      if (!response.ok || body === null) {
        throw new Error(body?.error?.message ?? `finalize failed (HTTP ${response.status})`);
      }
      if (body.done) break;
    }
    return { ok: true };
  } catch (error) {
    console.info(`[batch] failed: ${error instanceof Error ? error.message : error}`);
    return { ok: false, error: error instanceof Error ? error.message : "analysis failed" };
  } finally {
    sweepDone = true;
    sweepEngine.quit();
    verifyEngine?.quit();
  }
}
