import { EngineWedgedError, type ServerAnalyzeResult } from "@/lib/engine/server";
import type { VariantId } from "@/lib/chess/variant";
import type { AnalysisPool } from "./pool";
import { budgetForMs } from "./budgets";

/**
 * §3.3 watchdog ladder around one position search. The production defect
 * this closes: one wedged depth-18 MultiPV search burned 2.5 hours of CPU
 * in the calibration arena, and the batch pipeline ran the same engine with
 * no recovery path — one such position would hang a user's whole import.
 *
 * Ladder: full shape → retry at MultiPV 1 → retry at reduced depth. A soft
 * breach (budget exceeded, engine honored `stop`) fails the rung but keeps
 * its deepest lines as fallback data; a hard wedge kills the worker (the
 * pool replaces it) and the ladder continues on a fresh engine. If every
 * rung fails, the deepest partial result seen is returned marked degraded —
 * the job continues, the ply is honest about what it is. NEVER hang.
 */

export interface WatchdogSearchResult {
  result: ServerAnalyzeResult;
  /** Null when the full shape completed inside budget. */
  degraded: {
    reason: string;
    /** Deepest depth actually reached across all attempts. */
    reachedDepth: number;
    /** Shape that produced the returned lines (or the last attempted). */
    depth: number;
    multipv: number;
  } | null;
}

export async function searchWithWatchdog(
  pool: AnalysisPool,
  variant: VariantId,
  startFen: string,
  moves: string[],
  shape: { depth: number; multipv: number },
  /** Test hook: budget resolver override (production uses the fitted table). */
  budgetMsFor: (depth: number, multipv: number) => number = budgetForMs
): Promise<WatchdogSearchResult> {
  const rungs = [
    { depth: shape.depth, multipv: shape.multipv, label: "full" },
    { depth: shape.depth, multipv: 1, label: "reduced multipv" },
    { depth: Math.max(10, shape.depth - 6), multipv: 1, label: "reduced depth" },
  ];
  const reasons: string[] = [];
  let bestPartial: ServerAnalyzeResult | null = null;
  let bestPartialShape = rungs[0]!;

  for (const [index, rung] of rungs.entries()) {
    try {
      const result = await pool.withEngine(variant, (engine) =>
        engine.analyze(startFen, moves, {
          depth: rung.depth,
          multipv: rung.multipv,
          maxMs: budgetMsFor(rung.depth, rung.multipv),
        })
      );
      if (result.breach === "none" && result.infos.length > 0) {
        return {
          result,
          degraded:
            index === 0
              ? null
              : {
                  reason: `${reasons.join("; ")} — completed at ${rung.label}`,
                  reachedDepth: result.reachedDepth,
                  depth: rung.depth,
                  multipv: rung.multipv,
                },
        };
      }
      // Soft breach: rung failed, but its deepest lines beat nothing.
      reasons.push(`budget breach at d${rung.depth}mp${rung.multipv} (soft, reached d${result.reachedDepth})`);
      if (
        result.infos.length > 0 &&
        (bestPartial === null || result.reachedDepth > bestPartial.reachedDepth)
      ) {
        bestPartial = result;
        bestPartialShape = rung;
      }
    } catch (error) {
      if (!(error instanceof EngineWedgedError)) throw error;
      reasons.push(`engine wedged at d${rung.depth}mp${rung.multipv} (killed, reached d${error.reachedDepth})`);
      if (
        error.partialInfos.length > 0 &&
        (bestPartial === null || error.reachedDepth > (bestPartial.reachedDepth ?? 0))
      ) {
        bestPartial = {
          infos: error.partialInfos,
          bestmove: null,
          reachedDepth: error.reachedDepth,
          breach: "soft",
        };
        bestPartialShape = rung;
      }
    }
  }

  const result: ServerAnalyzeResult =
    bestPartial ?? { infos: [], bestmove: null, reachedDepth: 0, breach: "soft" };
  return {
    result,
    degraded: {
      reason: reasons.join("; "),
      reachedDepth: result.reachedDepth,
      depth: bestPartialShape.depth,
      multipv: bestPartialShape.multipv,
    },
  };
}
