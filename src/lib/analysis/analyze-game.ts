import { and, asc, eq, sql } from "drizzle-orm";
import { games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { GamePosition } from "@/lib/chess/position";
import { materialDeltaCp, PIECE_VALUES_CP } from "@/lib/chess/material";
import { openingForEpd, MAX_BOOK_PLY } from "@/lib/chess/openings";
import { parseMultiPgn, replayPgnGame } from "@/lib/chess/pgn-read";
import type { VariantId } from "@/lib/chess/variant";
import {
  classifyMove,
  forColor,
  normalizeInfo,
  winProbFromEval,
  ANALYSIS_SETTINGS,
  type Classification,
  type WhitePovEval,
} from "@/lib/eval";
import type { EngineInfo } from "@/lib/engine/types";
import type { AnalysisPool } from "./pool";
import { searchWithWatchdog } from "./watchdog";
import { wpFromWdl, type TablebaseClient, type TbResult } from "./tablebase";
import { BAND_CLASSES, bandForLoss, needsVerify, VERIFY_RULES } from "./verify-rules";

export { VERIFY_RULES } from "./verify-rules";

/**
 * The Phase 2 batch pass (§4): populates every analysis field of `plies`.
 * One engine search per POSITION — ply i consumes position i (before) and
 * position i+1 (after), so a game of N plies costs N+1 searches and ply i's
 * refutation line is exactly ply i+1's stored pv1.
 *
 * POV discipline: engine infos are side-to-move POV; they are normalized to
 * White-POV exactly once (normalizeInfo) and re-derived per color via
 * forColor. The DB stores White-POV cp/mate and MOVER-POV win probabilities.
 *
 * Chunked and resumable: a chunk analyzes up to `maxPositions` positions
 * within `maxMs`, writing each completed ply immediately. When every ply is
 * written, `finalizeDerived` computes the ±2-ply volatility half of
 * isCritical (§9.3) and runs motif detection (C2) over the stored lines.
 */

export interface AnalyzeChunkOpts {
  pool: AnalysisPool;
  tb: TablebaseClient;
  /** When present, server-computed sweep searches join the GLOBAL eval
   * cache (organic growth of the trusted tier). */
  db?: Db;
  depth?: number;
  multipv?: number;
  /** Max engine positions this chunk may analyze (≥ 2 to complete a ply). */
  maxPositions?: number;
  /** Wall-clock budget for the chunk; the current position always completes. */
  maxMs?: number;
  /**
   * BASIC mode (owner directive 2026-08-23, the DEFAULT for user-initiated
   * review): skip the §4.2 d24 borderline verification pass — the review
   * stands on d18 numbers and finalizes immediately. Full depth is the
   * opt-in ("deep verify" on the review screen re-runs with this false).
   */
  skipVerify?: boolean;
  onPly?: (done: number, total: number) => void;
}

export interface AnalyzeChunkResult {
  gameId: string;
  analyzedPlies: number;
  totalPlies: number;
  remainingPlies: number;
  finalized: boolean;
}

type PlyRow = typeof plies.$inferSelect;

export interface PositionEval {
  infos: EngineInfo[];
  /** Mover-POV eval of the position (pv1), already tb-consulted when known. */
  wpMover: number;
  whitePov: WhitePovEval;
  tb: TbResult | null;
  terminal: "checkmate" | "stalemate" | "draw" | "variant-end" | null;
  /** §3.3 watchdog verdict: non-null when the search only completed degraded. */
  degraded: { reason: string; reachedDepth: number } | null;
}

function fenColor(fen: string): "w" | "b" {
  return (fen.split(" ")[1] ?? "w") === "w" ? "w" : "b";
}

/**
 * Terminal-position eval without an engine: mate, stalemate, dead draws,
 * and variant ends (third check delivered, KotH king centered) — the engine
 * must never be asked about a finished position.
 */
export function terminalEval(fen: string, variant: VariantId): PositionEval | null {
  const position = GamePosition.fromFen(fen, variant);
  const outcome = position.outcome();
  if (outcome === "white" || outcome === "black") {
    // Decided (checkmate or a variant win): winner is never the side to
    // move. Encoded as mate ±1 — the sign is what wp/classification
    // consume; the board already shows the ending.
    return {
      infos: [],
      wpMover: position.turn === (outcome === "white" ? "w" : "b") ? 100 : 0,
      whitePov: { cp: null, mateIn: outcome === "white" ? 1 : -1 },
      tb: null,
      terminal: position.isCheckmate() ? "checkmate" : "variant-end",
      degraded: null,
    };
  }
  if (outcome === "draw" || position.isStalemate() || position.isInsufficientMaterial()) {
    return {
      infos: [],
      wpMover: 50,
      whitePov: { cp: 0, mateIn: null },
      tb: null,
      terminal: position.isStalemate() ? "stalemate" : "draw",
      degraded: null,
    };
  }
  return null;
}

/**
 * Derive a PositionEval from engine lines — the SINGLE place raw infos
 * become wp/White-POV numbers, shared by the server search path and the
 * client-batch ingest path (which supplies infos computed in the browser).
 * Terminal positions are the caller's job (terminalEval first).
 */
export function positionEvalFromInfos(
  fen: string,
  infos: EngineInfo[],
  tb: TbResult | null,
  degraded: { reason: string; reachedDepth: number } | null
): PositionEval {
  const pv1 = infos[0];
  if (!pv1) {
    // No line at all — a fully failed search is a degraded ply, not a fake
    // draw eval that silently corrupts every trainer downstream.
    return {
      infos: [],
      wpMover: 50,
      whitePov: { cp: 0, mateIn: null },
      tb,
      terminal: null,
      degraded: degraded ?? { reason: "engine produced no line", reachedDepth: 0 },
    };
  }
  const mover = fenColor(fen);
  const whitePov = normalizeInfo(pv1, mover);
  const wpMover =
    tb !== null ? wpFromWdl(tb.wdl) : winProbFromEval(forColor(whitePov, mover));
  return { infos, wpMover, whitePov, tb, terminal: null, degraded };
}

async function evaluatePosition(
  fen: string,
  startFen: string,
  movesUci: string[],
  variant: VariantId,
  opts: AnalyzeChunkOpts,
  depth: number,
  multipv: number
): Promise<PositionEval> {
  const terminal = terminalEval(fen, variant);
  if (terminal) return terminal;

  const tb = variant === "standard" ? await opts.tb.probe(fen) : null;
  // §3.3 watchdog: fitted per-shape budget, kill-and-retry ladder, never
  // hangs — one pathological position can no longer wedge a whole import.
  const { result, degraded } = await searchWithWatchdog(opts.pool, variant, startFen, movesUci, {
    depth,
    multipv,
  });
  const degradedInfo = degraded
    ? { reason: degraded.reason, reachedDepth: degraded.reachedDepth }
    : null;
  const evaluated = positionEvalFromInfos(fen, result.infos, tb, degradedInfo);
  // Organic global-cache growth: this search ran on the SERVER, so it is
  // trusted by construction. Opening zone only, sweep shapes only.
  if (
    opts.db &&
    degradedInfo === null &&
    multipv >= 3 &&
    movesUci.length <= 40 &&
    result.infos.length > 0
  ) {
    try {
      const { epdOf, storeGlobalLines } = await import("./eval-cache");
      await storeGlobalLines(opts.db, variant, [
        {
          epd: epdOf(fen),
          depth,
          multipv: result.infos.length,
          lines: result.infos.map((info) => ({
            multipv: info.multipv,
            depth: info.depth,
            scoreCp: info.scoreCp,
            mateIn: info.mateIn,
            pv: info.pv.slice(0, 32),
          })),
        },
      ]);
    } catch {
      // Cache is an accelerator, never a requirement.
    }
  }
  return evaluated;
}

/** Sum of capturable material on distinct target squares (§9.3 criterion c). */
function captureStakes(fen: string, variant: VariantId): { captures: number; stakeCp: number } {
  const position = GamePosition.fromFen(fen, variant);
  const victims = new Map<string, number>();
  let captures = 0;
  for (const uci of position.legalMovesUci()) {
    const to = uci.slice(2, 4);
    const victim = position.pieceAt(to);
    if (victim && victim.color !== position.turn) {
      captures++;
      victims.set(to, PIECE_VALUES_CP[victim.role === "knight" ? "n" : victim.role[0]!] ?? 0);
    }
  }
  let stakeCp = 0;
  for (const value of victims.values()) stakeCp += value;
  return { captures, stakeCp };
}

/** Ensures plies rows exist for a game that was saved as PGN only (bot games). */
export async function materializePliesFromPgn(db: Db, gameId: string): Promise<number> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game) throw new Error(`no such game ${gameId}`);
  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(plies)
    .where(eq(plies.gameId, gameId));
  if ((existing[0]?.n ?? 0) > 0) return existing[0]!.n;
  if (!game.pgn || game.isStudy) return 0;
  const raw = parseMultiPgn(game.pgn)[0];
  if (!raw) return 0;
  const replayed = replayPgnGame(raw);
  const rows = replayed.plies.map((ply) => ({
    gameId,
    ply: ply.ply,
    moveNumber: ply.moveNumber,
    color: (ply.color === "w" ? "white" : "black") as "white" | "black",
    san: ply.san,
    uci: ply.uci,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter,
    clockMsRemaining: ply.clockMs,
    timeSpentMs: null as number | null,
  }));
  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(plies).values(rows.slice(i, i + 400));
  }
  return rows.length;
}

export async function analyzeGameChunk(
  db: Db,
  gameId: string,
  opts: AnalyzeChunkOpts
): Promise<AnalyzeChunkResult> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game) throw new Error(`no such game ${gameId}`);
  await materializePliesFromPgn(db, gameId);

  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  const total = rows.length;
  if (total === 0) {
    return { gameId, analyzedPlies: 0, totalPlies: 0, remainingPlies: 0, finalized: false };
  }

  const firstUnanalyzed = rows.findIndex(
    (row) =>
      (row.evalBeforeCp === null && row.mateBefore === null) ||
      // Progressive depth: a PROVISIONAL ply (client pass 1, depth < review
      // depth) counts as unanalyzed for the server path — the fallback
      // refines it to full depth rather than letting a d12 number stand.
      // Degraded plies stay terminal (§3.3): the ladder already concluded.
      (!row.degraded && (row.analyzedAtDepth ?? 0) < ANALYSIS_SETTINGS.review.depth)
  );
  if (firstUnanalyzed === -1) {
    const verify = opts.skipVerify
      ? { remaining: 0 }
      : await verifyBorderline(db, gameId, opts, {
          maxPositions: opts.maxPositions,
          deadline: opts.maxMs ? Date.now() + opts.maxMs : null,
        });
    const finalized = verify.remaining === 0 ? await finalizeDerived(db, gameId, opts) : false;
    return {
      gameId,
      analyzedPlies: 0,
      totalPlies: total,
      remainingPlies: verify.remaining,
      finalized,
    };
  }

  const depth = opts.depth ?? ANALYSIS_SETTINGS.review.depth;
  const multipv = opts.multipv ?? ANALYSIS_SETTINGS.review.multipv;
  const startFen = game.startFen ?? rows[0]!.fenBefore;
  const variant = game.variant as VariantId;
  const movesUci = rows.map((row) => row.uci);
  // Server sweep searches feed the trusted global cache.
  opts = { ...opts, db };
  const deadline = opts.maxMs ? Date.now() + opts.maxMs : null;
  const maxPositions = Math.max(2, opts.maxPositions ?? Number.MAX_SAFE_INTEGER);

  let positionsUsed = 0;
  let analyzed = 0;
  let index = firstUnanalyzed;

  // Position "before" the first ply of this chunk.
  let before = await evaluatePosition(
    rows[index]!.fenBefore,
    startFen,
    movesUci.slice(0, index),
    variant,
    opts,
    depth,
    multipv
  );
  positionsUsed++;

  while (index < total && positionsUsed < maxPositions) {
    if (deadline !== null && Date.now() > deadline) break;
    const row = rows[index]!;
    const after = await evaluatePosition(
      row.fenAfter,
      startFen,
      movesUci.slice(0, index + 1),
      variant,
      opts,
      depth,
      multipv
    );
    positionsUsed++;

    await writePlyRecord(db, game, row, before, after, depth, index === total - 1);
    analyzed++;
    opts.onPly?.(index + 1, total);
    before = after;
    index++;
  }

  let remaining = total - index;
  let finalized = false;
  if (remaining === 0) {
    const verify = opts.skipVerify
      ? { remaining: 0 }
      : await verifyBorderline(db, gameId, opts, {
          maxPositions: maxPositions - positionsUsed,
          deadline,
        });
    remaining = verify.remaining;
    if (verify.remaining === 0) finalized = await finalizeDerived(db, gameId, opts);
  }
  return {
    gameId,
    analyzedPlies: analyzed,
    totalPlies: total,
    remainingPlies: remaining,
    finalized,
  };
}

export async function writePlyRecord(
  db: Db,
  game: typeof games.$inferSelect,
  row: PlyRow,
  before: PositionEval,
  after: PositionEval,
  depth: number,
  isLastPly: boolean
): Promise<void> {
  const mover = row.color === "white" ? "w" : "b";
  const wpBefore = before.wpMover; // before-position mover == this ply's mover
  const wpAfter = 100 - after.wpMover; // after-position mover is the opponent
  const loss = wpBefore - wpAfter;

  const beforePv1 = before.infos[0];
  const beforePv2 = before.infos[1];
  const bestUci = beforePv1?.pv[0] ?? null;

  // GREAT inputs: mover-POV win probs of the top two lines of the pre-move position.
  const wpPv1 = beforePv1
    ? winProbFromEval(forColor(normalizeInfo(beforePv1, mover), mover))
    : null;
  const wpPv2 = beforePv2
    ? winProbFromEval(forColor(normalizeInfo(beforePv2, mover), mover))
    : null;

  // MISS inputs (mover POV).
  const bestEval = beforePv1 ? forColor(normalizeInfo(beforePv1, mover), mover) : null;
  const playedEval = forColor(after.whitePov, mover);

  // BRILLIANT sacrifice inputs: material after the opponent's best reply.
  let sacrifice: { materialDeltaAfterBestReplyCp: number; isRecapture: boolean } | undefined;
  const refutationFirst = after.infos[0]?.pv[0];
  if (refutationFirst) {
    try {
      const probe = GamePosition.fromFen(row.fenAfter, game.variant as VariantId);
      if (probe.moveUci(refutationFirst)) {
        sacrifice = {
          materialDeltaAfterBestReplyCp: materialDeltaCp(
            row.fenBefore,
            probe.fen(),
            mover
          ),
          isRecapture: false,
        };
      }
    } catch {
      sacrifice = undefined;
    }
  }
  // Recapture = this move captures on the square the opponent just captured on.
  if (sacrifice && row.san.includes("x")) {
    const previous = await db
      .select({ san: plies.san, uci: plies.uci })
      .from(plies)
      .where(and(eq(plies.gameId, row.gameId), eq(plies.ply, row.ply - 1)));
    const prevRow = previous[0];
    if (prevRow?.san.includes("x") && prevRow.uci.slice(2, 4) === row.uci.slice(2, 4)) {
      sacrifice.isRecapture = true;
    }
  }

  const legal = captureStakes(row.fenBefore, game.variant as VariantId);
  const legalMoveCount = GamePosition.fromFen(
    row.fenBefore,
    game.variant as VariantId
  ).legalMoveCount();

  const isBook =
    game.variant === "standard" &&
    row.ply <= MAX_BOOK_PLY &&
    openingForEpd(row.fenAfter.split(" ").slice(0, 4).join(" ")) !== null;

  const classification: Classification = classifyMove({
    variant: game.variant as VariantId,
    wpBefore,
    wpAfter,
    playedUci: row.uci,
    bestUci: bestUci ?? row.uci,
    legalMoveCount,
    isBook,
    sacrifice,
    multipv: wpPv1 !== null ? { wpPv1, wpPv2 } : undefined,
    miss: bestEval
      ? {
          bestEvalCp: bestEval.cp,
          bestMateIn: bestEval.mateIn,
          playedEvalCp: playedEval.cp,
          playedMateIn: playedEval.mateIn,
        }
      : undefined,
  });

  // §9.3 isCritical, criteria (a) only-move gap and (c) capture stakes;
  // criterion (b) ±2-ply volatility joins in finalizeDerived.
  const onlyMoveish = wpPv1 !== null && wpPv2 !== null && wpPv1 - wpPv2 >= 12;
  const capturesHot = legal.captures >= 5 && legal.stakeCp >= 300;

  await db
    .update(plies)
    .set({
      evalBeforeCp: before.whitePov.cp,
      evalAfterCp: after.whitePov.cp,
      mateBefore: before.whitePov.mateIn,
      mateAfter: after.whitePov.mateIn,
      bestMoveUci: bestUci,
      pv1: beforePv1?.pv ?? [],
      pv2: beforePv2?.pv ?? null,
      pv3: before.infos[2]?.pv ?? null,
      // White-POV alternative-line evals (review "alternatives" rendering).
      pv2EvalCp: beforePv2 ? normalizeInfo(beforePv2, mover).cp : null,
      pv2Mate: beforePv2 ? normalizeInfo(beforePv2, mover).mateIn : null,
      pv3EvalCp: before.infos[2] ? normalizeInfo(before.infos[2], mover).cp : null,
      pv3Mate: before.infos[2] ? normalizeInfo(before.infos[2], mover).mateIn : null,
      wpBefore,
      wpAfter,
      wpLoss: loss,
      classification,
      isCritical: onlyMoveish || capturesHot,
      // Watchdog (§3.3): a ply is degraded when EITHER side of it only
      // completed at reduced settings; analyzedAtDepth records the depth
      // actually reached, not the one requested.
      degraded: before.degraded !== null || after.degraded !== null,
      degradedReason:
        [before.degraded?.reason, after.degraded?.reason].filter(Boolean).join(" | ") || null,
      analyzedAtDepth:
        before.degraded !== null || after.degraded !== null
          ? Math.min(
              before.degraded?.reachedDepth ?? depth,
              after.degraded?.reachedDepth ?? depth
            )
          : depth,
      tbWdl: after.tb?.wdl ?? null,
      tbDtz: after.tb?.dtz ?? null,
      tbHit: after.tb !== null,
      tbProbedAt: after.tb !== null ? new Date() : null,
      variantStateJson: isLastPly
        ? { finalPosition: { terminal: after.terminal } }
        : row.variantStateJson,
    })
    .where(and(eq(plies.gameId, row.gameId), eq(plies.ply, row.ply)));
}

/**
 * Borderline verification (§4.2): the Phase 2 agreement gate showed the d18
 * batch eval is accurate everywhere except right at the MISTAKE/BLUNDER
 * decision boundaries, where a small systematic depth effect (deeper
 * analysis scores decided positions more decisively) parks real blunders one
 * wp point under the line. Plies whose measured loss lands inside the
 * boundary window get both of their positions re-searched at a deeper depth
 * and their loss re-derived — refinement moves plies in BOTH directions, so
 * this is a measurement improvement, not a threshold nudge.
 */
/**
 * Apply one verified position pair to its ply and refresh the shared
 * neighbours — the update rules of the §4.2 verify pass, extracted so the
 * server loop (verifyBorderline) and the client-batch ingest path apply
 * IDENTICAL semantics: only band classes reclassify by loss, neighbours
 * stay on the one-eval-per-position chain, analyzedAtDepth records the
 * verify depth.
 */
export async function applyVerifyPair(
  db: Db,
  gameId: string,
  rows: PlyRow[],
  row: PlyRow,
  before: PositionEval,
  after: PositionEval
): Promise<void> {
  const wpBefore = before.wpMover;
  const wpAfter = 100 - after.wpMover;
  const loss = wpBefore - wpAfter;
  const cls = row.classification as Classification | null;
  await db
    .update(plies)
    .set({
      evalBeforeCp: before.whitePov.cp,
      evalAfterCp: after.whitePov.cp,
      mateBefore: before.whitePov.mateIn,
      mateAfter: after.whitePov.mateIn,
      wpBefore,
      wpAfter,
      wpLoss: loss,
      classification: cls !== null && BAND_CLASSES.includes(cls) ? bandForLoss(loss) : cls,
      analyzedAtDepth: VERIFY_RULES.depth,
    })
    .where(and(eq(plies.gameId, gameId), eq(plies.ply, row.ply)));

  // Keep the one-eval-per-position chain consistent: the two refreshed
  // positions are shared with the neighbouring plies.
  const prev = rows[row.ply - 2];
  if (prev) {
    const prevWpAfter = 100 - before.wpMover;
    const prevLoss = prev.wpBefore! - prevWpAfter;
    const prevCls = prev.classification as Classification | null;
    await db
      .update(plies)
      .set({
        evalAfterCp: before.whitePov.cp,
        mateAfter: before.whitePov.mateIn,
        wpAfter: prevWpAfter,
        wpLoss: prevLoss,
        classification:
          prevCls !== null && BAND_CLASSES.includes(prevCls) ? bandForLoss(prevLoss) : prevCls,
      })
      .where(and(eq(plies.gameId, gameId), eq(plies.ply, prev.ply)));
    prev.wpAfter = prevWpAfter;
    prev.wpLoss = prevLoss;
  }
  const next = rows[row.ply];
  if (next) {
    const nextWpBefore = 100 - wpAfter;
    const nextLoss = nextWpBefore - next.wpAfter!;
    const nextCls = next.classification as Classification | null;
    await db
      .update(plies)
      .set({
        evalBeforeCp: after.whitePov.cp,
        mateBefore: after.whitePov.mateIn,
        wpBefore: nextWpBefore,
        wpLoss: nextLoss,
        classification:
          nextCls !== null && BAND_CLASSES.includes(nextCls) ? bandForLoss(nextLoss) : nextCls,
      })
      .where(and(eq(plies.gameId, gameId), eq(plies.ply, next.ply)));
    next.wpBefore = nextWpBefore;
    next.wpLoss = nextLoss;
  }
  row.wpLoss = loss;
  row.analyzedAtDepth = VERIFY_RULES.depth;
}

/**
 * Resumable: verified plies carry analyzedAtDepth = VERIFY_RULES.depth.
 * Returns how many in-window plies still await verification (0 → done).
 */
export async function verifyBorderline(
  db: Db,
  gameId: string,
  opts: AnalyzeChunkOpts,
  budget?: {
    maxPositions?: number;
    deadline?: number | null;
    /**
     * Selection override (the d24 re-verification after the 20s-soft-stop
     * finding): re-process rows this predicate accepts INSTEAD of the
     * needsVerify gate, reusing every update rule verbatim.
     */
    force?: (row: PlyRow) => boolean;
  }
): Promise<{ remaining: number; refined: number; positionsUsed: number }> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game) throw new Error(`no such game ${gameId}`);
  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  if (rows.some((row) => row.wpBefore === null)) {
    return { remaining: 0, refined: 0, positionsUsed: 0 };
  }
  const startFen = game.startFen ?? rows[0]?.fenBefore;
  if (!startFen) return { remaining: 0, refined: 0, positionsUsed: 0 };
  const variant = game.variant as VariantId;
  const movesUci = rows.map((row) => row.uci);

  // Position p (0-based) = fenBefore of ply p+1 = fenAfter of ply p.
  const positionCache = new Map<number, PositionEval>();
  let positionsUsed = 0;
  const searchPosition = async (p: number): Promise<PositionEval> => {
    const cached = positionCache.get(p);
    if (cached) return cached;
    const fen = p === 0 ? rows[0]!.fenBefore : rows[p - 1]!.fenAfter;
    const result = await evaluatePosition(
      fen,
      startFen,
      movesUci.slice(0, p),
      variant,
      opts,
      VERIFY_RULES.depth,
      1
    );
    positionsUsed++;
    positionCache.set(p, result);
    return result;
  };

  let refined = 0;
  const maxPositions = budget?.maxPositions ?? Number.MAX_SAFE_INTEGER;
  const deadline = budget?.deadline ?? null;
  const selected = budget?.force ?? needsVerify;
  for (const row of rows) {
    if (!selected(row)) continue;
    if (positionsUsed + 2 > maxPositions) break;
    if (deadline !== null && Date.now() > deadline) break;
    const before = await searchPosition(row.ply - 1);
    const after = await searchPosition(row.ply);
    if (before.degraded !== null || after.degraded !== null) {
      // Verification refines an already COMPLETE lower-depth analysis; a
      // degraded d24 search must not overwrite honest d18 numbers or stamp
      // a depth it never reached. Leave the ply as analyzed (needsVerify
      // may retry it on a later pass).
      continue;
    }
    await applyVerifyPair(db, gameId, rows, row, before, after);
    refined++;
  }

  const remaining = rows.filter((row) => needsVerify(row)).length;
  return { remaining, refined, positionsUsed };
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/**
 * Post-pass once every ply is analyzed: the volatility half of isCritical,
 * and motif detection (C2) over the stored refutation lines. Idempotent —
 * safe to re-run (the motif backfill path).
 */
export async function finalizeDerived(
  db: Db,
  gameId: string,
  opts?: Pick<AnalyzeChunkOpts, "pool" | "tb">
): Promise<boolean> {
  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  if (rows.length === 0) return false;
  if (rows.some((row) => row.wpBefore === null)) return false;

  // White-POV wp series over positions p0..pN.
  const series: number[] = rows.map((row) =>
    row.color === "white" ? row.wpBefore! : 100 - row.wpBefore!
  );
  const last = rows.at(-1)!;
  series.push(last.color === "white" ? 100 - last.wpAfter! : last.wpAfter!);

  for (const [i, row] of rows.entries()) {
    const window = series.slice(Math.max(0, i - 2), Math.min(series.length, i + 3));
    const volatile = stdev(window) >= 10;
    if (volatile && !row.isCritical) {
      await db
        .update(plies)
        .set({ isCritical: true })
        .where(and(eq(plies.gameId, gameId), eq(plies.ply, row.ply)));
    }
  }

  const { detectAndStoreMotifs } = await import("@/lib/motifs/apply");
  await detectAndStoreMotifs(db, gameId, opts);
  // Rated online games pick up their analysis-time fair-play signals here
  // (A2.3: engine correlation is free once the review pipeline ran).
  const { computeAnalysisSignals } = await import("@/lib/play/fairplay");
  await computeAnalysisSignals(db, gameId);
  return true;
}

/** Analysis progress counters for a game (drives the review UI progress bar). */
export async function analysisProgress(
  db: Db,
  gameId: string
): Promise<{ total: number; analyzed: number }> {
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      analyzed: sql<number>`count(*) filter (where ${plies.wpBefore} is not null)::int`,
    })
    .from(plies)
    .where(eq(plies.gameId, gameId));
  return { total: result[0]?.total ?? 0, analyzed: result[0]?.analyzed ?? 0 };
}
