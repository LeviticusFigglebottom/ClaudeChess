import { asc, eq } from "drizzle-orm";
import { games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { GamePosition } from "@/lib/chess/position";
import type { VariantId } from "@/lib/chess/variant";
import { ANALYSIS_SETTINGS } from "@/lib/eval";
import type { EngineInfo } from "@/lib/engine/types";
import {
  applyVerifyPair,
  positionEvalFromInfos,
  terminalEval,
  writePlyRecord,
  type PositionEval,
} from "./analyze-game";
import type { TablebaseClient } from "./tablebase";
import { needsVerify, VERIFY_RULES } from "./verify-rules";

/**
 * Ingest for CLIENT-SIDE batch analysis: the browser engine (§3.2 client,
 * several times faster than a 1-vCPU serverless instance) searches the
 * positions; the SERVER remains the single place raw lines become wp /
 * classifications / motifs — POV normalization, tablebase blending, §4.2
 * verify semantics and §9 derivations all run through the exact same code
 * as the server-search path (positionEvalFromInfos → writePlyRecord /
 * applyVerifyPair). The client streams positions as they complete, so a
 * closed tab loses only in-flight work.
 *
 * Contract: positions arrive in ascending index order; a ply is written
 * when its two positions (k-1, k) appear in the SAME request — batches
 * overlap by one position (free for the client: it resends cached lines,
 * not a new search). Position index 0 is the position before ply 1.
 *
 * Trust: evals are client-computed and only ever affect the OWNER's own
 * analysis record (the same data a user could fabricate offline). Fens are
 * always the server's own stored ones — the client cannot analyze one
 * position and file it under another. Depth can only move a row UP its
 * ladder (12 → 18 → 24-verify), and the 24 tier applies the conservative
 * verify rules, never a fresh classification.
 */

export interface IngestLine {
  multipv: number;
  depth: number;
  scoreCp: number | null;
  mateIn: number | null;
  pv: string[];
}

export interface IngestPosition {
  /** 0-based position index: 0 = before ply 1, k = after ply k. */
  index: number;
  /** Declared pass depth — whitelisted to the progressive tiers. */
  depth: number;
  lines: IngestLine[];
}

export interface IngestResult {
  written: number;
  verified: number;
  skipped: number;
  invalid: number;
  totalPlies: number;
  /** Plies still below review depth (excluding degraded) after this batch. */
  provisionalRemaining: number;
  /** Plies still awaiting the d24 verify pass after this batch. */
  verifyRemaining: number;
}

const ALLOWED_DEPTHS = new Set<number>([
  ANALYSIS_SETTINGS.provisional.depth,
  ANALYSIS_SETTINGS.review.depth,
  VERIFY_RULES.depth,
]);
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbnk]?$/;

function sanitizeLines(fen: string, variant: VariantId, raw: IngestLine[]): EngineInfo[] {
  const infos: EngineInfo[] = [];
  for (const line of raw.slice(0, 5)) {
    if (typeof line.multipv !== "number" || line.multipv < 1 || line.multipv > 5) continue;
    if (typeof line.depth !== "number" || line.depth < 1 || line.depth > 40) continue;
    const cp = line.scoreCp;
    const mate = line.mateIn;
    if (cp !== null && (typeof cp !== "number" || Math.abs(cp) > 100_000)) continue;
    if (mate !== null && (typeof mate !== "number" || Math.abs(mate) > 64)) continue;
    if (cp === null && mate === null) continue;
    if (!Array.isArray(line.pv) || line.pv.length === 0 || line.pv.length > 64) continue;
    if (!line.pv.every((m) => typeof m === "string" && UCI_RE.test(m))) continue;
    // First-move legality against the SERVER's own position — garbage pv1
    // would poison bestMoveUci and every motif built on the stored line.
    // (moveUci applies the move, so each check gets a fresh position.)
    try {
      if (!GamePosition.fromFen(fen, variant).moveUci(line.pv[0]!)) continue;
    } catch {
      return [];
    }
    infos.push({
      depth: Math.floor(line.depth),
      multipv: Math.floor(line.multipv),
      scoreCp: cp === null ? null : Math.round(cp),
      mateIn: mate === null ? null : Math.round(mate),
      pv: line.pv,
      nodes: 0,
      nps: 0,
    });
  }
  infos.sort((a, b) => a.multipv - b.multipv);
  // Dedup multipv collisions (keep the deepest).
  const byMultipv = new Map<number, EngineInfo>();
  for (const info of infos) {
    const existing = byMultipv.get(info.multipv);
    if (!existing || info.depth > existing.depth) byMultipv.set(info.multipv, info);
  }
  return [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
}

export async function ingestPositionEvals(
  db: Db,
  gameId: string,
  userId: string,
  tb: TablebaseClient,
  positions: IngestPosition[]
): Promise<IngestResult> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game || game.userId !== userId) throw new Error("game_missing");
  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  const total = rows.length;
  const variant = game.variant as VariantId;

  let written = 0;
  let verified = 0;
  let skipped = 0;
  let invalid = 0;

  // Resolve payload positions → PositionEval keyed by index.
  const evals = new Map<number, { pe: PositionEval; depth: number; lineDepth: number }>();
  const sorted = [...positions].sort((a, b) => a.index - b.index);
  for (const position of sorted) {
    if (
      typeof position.index !== "number" ||
      position.index < 0 ||
      position.index > total ||
      !ALLOWED_DEPTHS.has(position.depth)
    ) {
      invalid++;
      continue;
    }
    const fen = position.index === 0 ? rows[0]?.fenBefore : rows[position.index - 1]?.fenAfter;
    if (!fen) {
      invalid++;
      continue;
    }
    // Terminal positions are the server's own derivation — client lines for
    // them are ignored entirely.
    const terminal = terminalEval(fen, variant);
    if (terminal) {
      evals.set(position.index, { pe: terminal, depth: position.depth, lineDepth: 99 });
      continue;
    }
    const infos = sanitizeLines(fen, variant, position.lines ?? []);
    if (infos.length === 0) {
      invalid++;
      continue;
    }
    const tbHit = variant === "standard" ? await tb.probe(fen) : null;
    evals.set(position.index, {
      pe: positionEvalFromInfos(fen, infos, tbHit, null),
      depth: position.depth,
      lineDepth: infos[0]!.depth,
    });
  }

  // Write every adjacent pair present in this request.
  for (const [index, after] of [...evals.entries()].sort((a, b) => a[0] - b[0])) {
    if (index === 0) continue;
    const before = evals.get(index - 1);
    if (!before) continue;
    const row = rows[index - 1]; // ply `index` is rows[index-1]
    if (!row) continue;
    if (row.degraded) {
      skipped++;
      continue;
    }
    // Honest depth: the declared tier, capped by what the engine reported.
    const effectiveDepth = Math.min(
      before.depth,
      after.depth,
      before.lineDepth,
      after.lineDepth
    );
    const declared = Math.min(before.depth, after.depth);

    if (declared >= VERIFY_RULES.depth) {
      // Verify tier: conservative §4.2 semantics, borderline plies only —
      // and only over a completed review-depth base.
      if (!needsVerify(row)) {
        skipped++;
        continue;
      }
      if (effectiveDepth < VERIFY_RULES.depth) {
        // The engine did not actually reach the verify depth — refusing is
        // the same honesty rule the server's degraded-verify guard applies.
        skipped++;
        continue;
      }
      await applyVerifyPair(db, gameId, rows, row, before.pe, after.pe);
      verified++;
      continue;
    }

    // Initial/refine tier: full classification semantics. Depth only moves
    // UP — a stale d12 replay never overwrites a refined row.
    if (row.classification !== null && (row.analyzedAtDepth ?? 0) >= declared) {
      skipped++;
      continue;
    }
    await writePlyRecord(
      db,
      game,
      row,
      before.pe,
      after.pe,
      Math.min(declared, effectiveDepth),
      index === total
    );
    written++;
  }

  const fresh = await db
    .select({
      analyzedAtDepth: plies.analyzedAtDepth,
      degraded: plies.degraded,
      classification: plies.classification,
      wpLoss: plies.wpLoss,
    })
    .from(plies)
    .where(eq(plies.gameId, gameId));
  const provisionalRemaining = fresh.filter(
    (row) =>
      !row.degraded && (row.analyzedAtDepth ?? 0) < ANALYSIS_SETTINGS.review.depth
  ).length;
  const verifyRemaining = fresh.filter((row) => needsVerify(row)).length;

  return {
    written,
    verified,
    skipped,
    invalid,
    totalPlies: total,
    provisionalRemaining,
    verifyRemaining,
  };
}
