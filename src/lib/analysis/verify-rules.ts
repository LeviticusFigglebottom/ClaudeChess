import { ANALYSIS_SETTINGS, LOSS_THRESHOLDS, type Classification } from "@/lib/eval";

/**
 * Borderline-verification rules (§4.2) in a CLIENT-SAFE module: the browser
 * batch driver needs the same selection predicate the server uses, and
 * analyze-game.ts imports server-only engine code. No drizzle, no node.
 */

export const VERIFY_RULES = {
  depth: 24,
  /**
   * Loss window around the 10 (MISTAKE) and 15 (BLUNDER) boundaries.
   * Reaches down to 5 so the INACCURACY band feeding the mistake boundary
   * is refined too — d18's small systematic softness parks real mistakes
   * at loss 6–9 the same way it parked blunders at 12–15.
   */
  lossMin: 5,
  lossMax: 18,
} as const;

export const BAND_CLASSES: Classification[] = [
  "EXCELLENT",
  "GOOD",
  "INACCURACY",
  "MISTAKE",
  "BLUNDER",
];

export function bandForLoss(loss: number): Classification {
  if (loss < LOSS_THRESHOLDS.excellent) return "EXCELLENT";
  if (loss < LOSS_THRESHOLDS.good) return "GOOD";
  if (loss < LOSS_THRESHOLDS.inaccuracy) return "INACCURACY";
  if (loss < LOSS_THRESHOLDS.mistake) return "MISTAKE";
  return "BLUNDER";
}

/** The structural slice of a ply row the verify predicate needs. */
export interface VerifyCandidate {
  wpLoss: number | null;
  analyzedAtDepth: number | null;
  classification: string | null;
  degraded?: boolean | null;
}

export function needsVerify(row: VerifyCandidate): boolean {
  if (row.wpLoss === null) return false;
  // Degraded plies are terminally excluded from the batch (§3.3); a
  // PROVISIONAL ply (progressive pass 1, depth < review depth) must finish
  // pass 2 before the d24 verify may touch it — verification refines an 18,
  // never a 12.
  if (row.degraded) return false;
  if ((row.analyzedAtDepth ?? 0) < ANALYSIS_SETTINGS.review.depth) return false;
  if ((row.analyzedAtDepth ?? 0) >= VERIFY_RULES.depth) return false;
  if (row.wpLoss < VERIFY_RULES.lossMin || row.wpLoss > VERIFY_RULES.lossMax) return false;
  // Only classes whose meaning rides on the loss measurement: the loss
  // bands and MISS (which folds by loss). BOOK/BEST/GREAT/BRILLIANT are
  // decided by other evidence and stay as analyzed.
  const cls = row.classification;
  return (
    cls === "INACCURACY" || cls === "MISTAKE" || cls === "BLUNDER" || cls === "MISS"
  );
}

/** Provisional = analyzed below review depth and not degraded (§9-excluded). */
export function isProvisional(row: {
  analyzedAtDepth: number | null;
  degraded?: boolean | null;
  classification?: string | null;
}): boolean {
  if (row.degraded) return false;
  if (row.classification == null) return false;
  return (row.analyzedAtDepth ?? 0) < ANALYSIS_SETTINGS.review.depth;
}
