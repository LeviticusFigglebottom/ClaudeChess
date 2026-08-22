import { asc, eq, inArray } from "drizzle-orm";
import { blunderTags, games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { budgetForMs } from "@/lib/analysis/budgets";
import type { AnalysisPool } from "@/lib/analysis/pool";
import type { TablebaseClient } from "@/lib/analysis/tablebase";
import { detectMotifs, type MotifDetectionInput } from "./detect";

/**
 * DB adapter for C2/C5: pulls the stored analysis of every MISTAKE / BLUNDER
 * / MISS ply, assembles detector input (refutation = the NEXT ply's stored
 * pv1; for the game's final ply a one-off engine search of the final
 * position fills it), runs the pure detectors, and writes blunder_tags —
 * one row per fired motif with rank per C2.4. Idempotent: re-running
 * replaces a ply's tags.
 */

const ERROR_CLASSES = ["MISTAKE", "BLUNDER", "MISS"] as const;

export async function detectAndStoreMotifs(
  db: Db,
  gameId: string,
  opts?: { pool?: AnalysisPool; tb?: TablebaseClient }
): Promise<number> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game) return 0;
  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  if (rows.length === 0) return 0;

  const errorRows = rows.filter(
    (row) =>
      row.classification !== null &&
      (ERROR_CLASSES as readonly string[]).includes(row.classification) &&
      // §3.3 watchdog: degraded plies carry partial evals — they are
      // excluded from every §9 statistic, so they get no motif tags (the
      // game-wide delete above already cleared any stale ones).
      !row.degraded
  );

  // Clear existing tags for the WHOLE game, not just current error plies —
  // a ply reclassified out of the error set (e.g. the borderline
  // verification pass downgrading a BLUNDER to INACCURACY) must lose its
  // stale tags, or every population metric over blunder_tags drifts.
  await db.delete(blunderTags).where(
    inArray(
      blunderTags.plyId,
      rows.map((row) => row.id)
    )
  );
  if (errorRows.length === 0) return 0;

  let stored = 0;
  for (const row of errorRows) {
    const next = rows.find((candidate) => candidate.ply === row.ply + 1);
    let refutationPv: string[] = (next?.pv1 as string[] | null) ?? [];
    if (refutationPv.length === 0 && !next && opts?.pool) {
      // Final ply of the game: analyze the final position once.
      try {
        const result = await opts.pool.withEngine(
          game.variant as Parameters<AnalysisPool["withEngine"]>[0],
          (engine) =>
            // Fitted §3.3 budget; on a wedge the engine rejects (and is
            // replaced by the pool) and the catch below degrades gracefully.
            engine.analyze(row.fenAfter, [], { depth: 16, multipv: 1, maxMs: budgetForMs(16, 1) })
        );
        refutationPv = result.infos[0]?.pv ?? [];
      } catch {
        refutationPv = [];
      }
    }

    // Forcing-run context for TUNNEL_VISION_POST_FORCING: were the previous
    // ≥3 plies all checks/captures/promotions?
    const preceding = rows.filter((r) => r.ply < row.ply).slice(-3);
    const priorForcingRun =
      preceding.length >= 3 &&
      preceding.every((r) => r.san.includes("x") || r.san.includes("+") || r.san.includes("="));

    // ZWISCHENZUG context: did this move recapture on the square the
    // opponent captured on one ply earlier?
    const prevPly = rows.find((r) => r.ply === row.ply - 1);
    const playedIsRecapture =
      prevPly !== undefined &&
      prevPly.san.includes("x") &&
      row.san.includes("x") &&
      prevPly.uci.slice(2, 4) === row.uci.slice(2, 4);

    // Mobility trend for PASSIVITY: this side's recent non-forcing drift,
    // measured across the run (start of 3 own moves ago → after this move).
    const ownRecent = rows
      .filter((r) => r.color === row.color && r.ply <= row.ply)
      .slice(-4);
    let runMobility: { start: number; end: number } | undefined;
    if (ownRecent.length >= 3) {
      try {
        const mover = row.color === "white" ? "white" : "black";
        const { mobility, posFromFen } = await import("./primitives");
        runMobility = {
          start: mobility(posFromFen(ownRecent[0]!.fenBefore), mover),
          end: mobility(posFromFen(row.fenAfter), mover),
        };
      } catch {
        runMobility = undefined;
      }
    }

    // Forgone gate (Task 3): best-play eval of the pre-move position in the
    // MOVER's POV (DB stores White-POV; mate outranks cp).
    let bestEvalCp: number | null = null;
    if (row.mateBefore !== null && row.mateBefore !== undefined) {
      const moverMates = row.color === "white" ? row.mateBefore > 0 : row.mateBefore < 0;
      bestEvalCp = moverMates ? 10_000 : -10_000;
    } else if (row.evalBeforeCp !== null && row.evalBeforeCp !== undefined) {
      bestEvalCp = row.color === "white" ? row.evalBeforeCp : -row.evalBeforeCp;
    }

    const input: MotifDetectionInput = {
      variant: game.variant,
      fenBefore: row.fenBefore,
      fenAfter: row.fenAfter,
      movedUci: row.uci,
      movedSan: row.san,
      bestPv: (row.pv1 as string[] | null) ?? [],
      refutationPv,
      classification: row.classification,
      bestEvalCp,
      wpLoss: row.wpLoss ?? 0,
      clockMsRemaining: row.clockMsRemaining,
      tbBefore: null,
      tbAfter: row.tbHit ? { wdl: row.tbWdl ?? 0, dtz: row.tbDtz } : null,
      tbBeforeHit: false,
      priorForcingRun,
      recentOwnSans: ownRecent.map((r) => r.san),
      playedIsRecapture,
      runMobility,
    };
    // tbBefore: the previous ply's after-position IS this ply's before-position.
    if (prevPly?.tbHit) {
      input.tbBefore = { wdl: prevPly.tbWdl ?? 0, dtz: prevPly.tbDtz };
      input.tbBeforeHit = true;
    }

    const detections = detectMotifs(input);
    for (const [index, detection] of detections.entries()) {
      await db
        .insert(blunderTags)
        .values({
          plyId: row.id,
          motif: detection.motif,
          secondaryMotif: detections[index + 1]?.motif ?? null,
          rank: index + 1,
          confidence: detection.confidence,
          evidence: detection.evidence as Record<string, unknown>,
          model: "gambit-detectors-v1",
        })
        .onConflictDoNothing();
      stored++;
    }
  }
  return stored;
}
