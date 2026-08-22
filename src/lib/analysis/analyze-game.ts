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
import type { ServerAnalyzeResult } from "@/lib/engine/server";
import type { AnalysisPool } from "./pool";
import { wpFromWdl, type TablebaseClient, type TbResult } from "./tablebase";

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
  depth?: number;
  multipv?: number;
  /** Max engine positions this chunk may analyze (≥ 2 to complete a ply). */
  maxPositions?: number;
  /** Wall-clock budget for the chunk; the current position always completes. */
  maxMs?: number;
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

interface PositionEval {
  infos: EngineInfo[];
  /** Mover-POV eval of the position (pv1), already tb-consulted when known. */
  wpMover: number;
  whitePov: WhitePovEval;
  tb: TbResult | null;
  terminal: "checkmate" | "stalemate" | "draw" | null;
}

function fenColor(fen: string): "w" | "b" {
  return (fen.split(" ")[1] ?? "w") === "w" ? "w" : "b";
}

/** Terminal-position eval without an engine (mate/stalemate/dead draws). */
function terminalEval(fen: string, variant: VariantId): PositionEval | null {
  const position = GamePosition.fromFen(fen, variant);
  if (position.isCheckmate()) {
    // The side to move is mated: mate distance ±1 by convention here (the
    // sign is what wp/classification consume; the board already shows mate).
    const mated = position.turn;
    return {
      infos: [],
      wpMover: 0,
      whitePov: { cp: null, mateIn: mated === "w" ? -1 : 1 },
      tb: null,
      terminal: "checkmate",
    };
  }
  if (position.isStalemate() || position.isInsufficientMaterial()) {
    return {
      infos: [],
      wpMover: 50,
      whitePov: { cp: 0, mateIn: null },
      tb: null,
      terminal: position.isStalemate() ? "stalemate" : "draw",
    };
  }
  return null;
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
  const result: ServerAnalyzeResult = await opts.pool.withEngine(variant, (engine) =>
    engine.analyze(startFen, movesUci, { depth, multipv, maxMs: 20_000 })
  );
  const pv1 = result.infos[0];
  if (!pv1) {
    // Engine produced no line (should not happen off-terminal) — draw-ish fallback.
    return { infos: [], wpMover: 50, whitePov: { cp: 0, mateIn: null }, tb, terminal: null };
  }
  const mover = fenColor(fen);
  const whitePov = normalizeInfo(pv1, mover);
  const wpMover =
    tb !== null ? wpFromWdl(tb.wdl) : winProbFromEval(forColor(whitePov, mover));
  return { infos: result.infos, wpMover, whitePov, tb, terminal: null };
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
    (row) => row.evalBeforeCp === null && row.mateBefore === null
  );
  if (firstUnanalyzed === -1) {
    const finalized = await finalizeDerived(db, gameId, opts);
    return { gameId, analyzedPlies: 0, totalPlies: total, remainingPlies: 0, finalized };
  }

  const depth = opts.depth ?? ANALYSIS_SETTINGS.review.depth;
  const multipv = opts.multipv ?? ANALYSIS_SETTINGS.review.multipv;
  const startFen = game.startFen ?? rows[0]!.fenBefore;
  const variant = game.variant as VariantId;
  const movesUci = rows.map((row) => row.uci);
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

  const remaining = total - index;
  let finalized = false;
  if (remaining === 0) {
    finalized = await finalizeDerived(db, gameId, opts);
  }
  return {
    gameId,
    analyzedPlies: analyzed,
    totalPlies: total,
    remainingPlies: remaining,
    finalized,
  };
}

async function writePlyRecord(
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
      wpBefore,
      wpAfter,
      wpLoss: loss,
      classification,
      isCritical: onlyMoveish || capturesHot,
      analyzedAtDepth: depth,
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
