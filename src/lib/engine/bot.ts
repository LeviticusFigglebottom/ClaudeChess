import { clamp, winProb } from "@/lib/eval/winprob";
import type { Rng } from "@/lib/rng";
import type { EngineInfo } from "./types";

/**
 * Tier A bot move selection — spec §6 as REVISED by the Phase 1 policy
 * directive (supersedes the original constants):
 *
 *  a. MultiPV scales with band: clamp(round(24 − (R−600)/100), 4, 24) —
 *     600→24, 1400→16, 2200→8. A 1000 plays the 15th-best move; it can't
 *     when only 5 candidates exist. (Engine returns fewer lines than the
 *     option when fewer legal moves exist — the legal-move cap is implicit.)
 *  b. Truth depth scales: 14 below 1600, 18 at or above. Shallow pass stays
 *     depth 6 / MultiPV 5 at every band.
 *  c. Blunder loss window widens at low bands: [15, 45 + (2200 − R)/20] —
 *     600: [15,125] (queens get hung), 2200: [15,45].
 *  d. Fallthrough NEVER plays near-best silently: softmax over the full
 *     widened MultiPV at temperature. Candidate availability is reported on
 *     every choice for instrumentation.
 *  e. Near-random floor for the bottom bands: pRandom = clamp((1000−R)/2000,
 *     0, 0.2), uniform over legal moves that don't allow an immediate mate
 *     in reply, applied BEFORE the blunder branch.
 *
 * POV note: both searches run on the position the bot must move in, so raw
 * EngineInfo scores are already the MOVER's POV — winProb applies directly.
 *
 * The formula constants are priors; shipping (pBlunder, temperature) come
 * calibrated per band from bot-calibration.json (the Phase 1 gate).
 */

export const BOT_RATINGS = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200] as const;
export type BotRating = (typeof BOT_RATINGS)[number];

export interface SearchSettings {
  depth: number;
  multipv: number;
}

/** Revision (a) + (b): per-band search shapes. Shallow is fixed at all bands. */
export function bandSearchSettings(rating: number): { shallow: SearchSettings; deep: SearchSettings } {
  return {
    shallow: { depth: 6, multipv: 5 },
    deep: {
      depth: rating < 1600 ? 14 : 18,
      multipv: clamp(Math.round(24 - (rating - 600) / 100), 4, 24),
    },
  };
}

/** Revision (c): band-dependent blunder-loss window (win-prob points). */
export function blunderWindow(rating: number): { min: number; max: number } {
  return { min: 15, max: Math.max(15, 45 + (2200 - rating) / 20) };
}

/** Revision (e): near-random floor probability for the bottom bands. */
export function pRandom(rating: number): number {
  return clamp((1000 - rating) / 2000, 0, 0.2);
}

export interface BotPolicyParams {
  /** Base probability of playing a plausible blunder when one exists. */
  pBlunder: number;
  /** Softmax temperature over −wpLoss (higher = weaker/more random). */
  temperature: number;
}

/** Spec §6 formula priors for the calibrated knobs. */
export function formulaParams(rating: number): BotPolicyParams {
  return {
    pBlunder: clamp(0.45 - (rating - 600) / 3000, 0.02, 0.45),
    temperature: clamp(6.0 - (rating - 600) / 300, 0.15, 6.0),
  };
}

export interface BotSearchSnapshot {
  /** Final shallow-pass infos, in multipv order (side-to-move POV). */
  shallow: EngineInfo[];
  /** Final deep-pass infos, in multipv order (side-to-move POV). */
  deep: EngineInfo[];
  legalMoveCount: number;
  inCheck: boolean;
  /**
   * Legal moves that do not allow an immediate mate in reply (revision e).
   * Only consulted when pRandom(rating) > 0 — callers may pass [] otherwise.
   */
  randomSafeMoves: string[];
}

export type BotMoveKind = "random" | "blunder" | "sampled";

export interface BotMoveChoice {
  uci: string;
  kind: BotMoveKind;
  /** Mover-POV win-prob loss vs the deep best line (unknown for random moves outside MPV). */
  wpLoss: number | null;
  /** A shallow-good/deep-bad candidate existed for this move (instrumentation, revision d). */
  blunderAvailable: boolean;
  /** Effective pBlunder after phase scaling (diagnostics). */
  effectivePBlunder: number;
}

const SHALLOW_TOP_N = 3;

function moverWp(info: EngineInfo): number {
  if (info.mateIn !== null) return info.mateIn > 0 ? 100 : 0;
  return winProb(info.scoreCp ?? 0);
}

/**
 * §6.5 phase scaling: ×1.4 in complex middlegames (legal moves > 35), ×0.5
 * in forced sequences (in check or ≤ 5 legal moves).
 */
export function phaseFactor(legalMoveCount: number, inCheck: boolean): number {
  if (inCheck || legalMoveCount <= 5) return 0.5;
  if (legalMoveCount > 35) return 1.4;
  return 1;
}

export function selectBotMove(
  rating: number,
  params: BotPolicyParams,
  snapshot: BotSearchSnapshot,
  rng: Rng
): BotMoveChoice | null {
  const deep = snapshot.deep.filter((info) => info.pv.length > 0);
  if (deep.length === 0) return null;

  const bestWp = moverWp(deep[0] as EngineInfo);
  const candidates = deep.map((info) => ({
    uci: info.pv[0] as string,
    wpLoss: Math.max(0, bestWp - moverWp(info)),
  }));

  const shallowRank = new Map<string, number>();
  snapshot.shallow.forEach((info, index) => {
    const uci = info.pv[0];
    if (uci && !shallowRank.has(uci)) shallowRank.set(uci, index);
  });

  const window = blunderWindow(rating);
  const blunderCandidates = candidates.filter((candidate) => {
    const rank = shallowRank.get(candidate.uci);
    return (
      rank !== undefined &&
      rank < SHALLOW_TOP_N &&
      candidate.wpLoss >= window.min &&
      candidate.wpLoss <= window.max
    );
  });
  const blunderAvailable = blunderCandidates.length > 0;

  const effectivePBlunder = clamp(
    params.pBlunder * phaseFactor(snapshot.legalMoveCount, snapshot.inCheck),
    0,
    1
  );

  // (e) Near-random floor, before the blunder branch.
  if (pRandom(rating) > 0 && snapshot.randomSafeMoves.length > 0 && rng() < pRandom(rating)) {
    const uci = snapshot.randomSafeMoves[
      Math.floor(rng() * snapshot.randomSafeMoves.length)
    ] as string;
    const known = candidates.find((candidate) => candidate.uci === uci);
    return {
      uci,
      kind: "random",
      wpLoss: known?.wpLoss ?? null,
      blunderAvailable,
      effectivePBlunder,
    };
  }

  if (blunderAvailable && rng() < effectivePBlunder) {
    const chosen = blunderCandidates.reduce((a, b) =>
      (shallowRank.get(a.uci) ?? 9) <= (shallowRank.get(b.uci) ?? 9) ? a : b
    );
    return {
      uci: chosen.uci,
      kind: "blunder",
      wpLoss: chosen.wpLoss,
      blunderAvailable,
      effectivePBlunder,
    };
  }

  // (d) Fallthrough: softmax over the FULL widened MultiPV at temperature.
  const weights = candidates.map((candidate) => Math.exp(-candidate.wpLoss / params.temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i] as number;
    if (roll <= 0) {
      const chosen = candidates[i] as (typeof candidates)[number];
      return {
        uci: chosen.uci,
        kind: "sampled",
        wpLoss: chosen.wpLoss,
        blunderAvailable,
        effectivePBlunder,
      };
    }
  }
  const fallback = candidates[0] as (typeof candidates)[number];
  return {
    uci: fallback.uci,
    kind: "sampled",
    wpLoss: fallback.wpLoss,
    blunderAvailable,
    effectivePBlunder,
  };
}
