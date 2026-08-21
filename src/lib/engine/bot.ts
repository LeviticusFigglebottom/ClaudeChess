import { clamp, winProb } from "@/lib/eval/winprob";
import type { Rng } from "@/lib/rng";
import type { EngineInfo } from "./types";

/**
 * Tier A bot move selection (spec §6): shallow-good/deep-bad sampling.
 *
 * The core trick: a move that ranks top-3 at depth 6 but is bad at depth 18
 * is a human-plausible blunder — exactly the move a 1200 plays. Otherwise
 * sample from the deep MultiPV via softmax over −wpLoss.
 *
 * POV note: both searches are run on the position the bot must move in, so
 * raw EngineInfo scores are already the MOVER's POV — winProb applies
 * directly, no White-POV normalization involved (that boundary is for
 * storage/display, not for a mover choosing its own move).
 *
 * The formula constants below are the spec's priors. Shipping values are
 * CALIBRATED per band (bot-calibration.json, fitted from ≥200 self-play
 * games per band vs a reference Stockfish — the Phase 1 gate). Uncalibrated
 * constants do not ship.
 */

export const BOT_RATINGS = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200] as const;
export type BotRating = (typeof BOT_RATINGS)[number];

/** Spec §4.6/§6 search settings for the two passes. */
export const BOT_SEARCH = {
  shallow: { depth: 6, multipv: 5 },
  deep: { depth: 18, multipv: 5 },
} as const;

export interface BotPolicyParams {
  /** Base probability of playing a plausible blunder when one exists. */
  pBlunder: number;
  /** Softmax temperature over −wpLoss (higher = weaker/more random). */
  temperature: number;
}

/** Spec §6 formula priors, before calibration. */
export function formulaParams(rating: number): BotPolicyParams {
  return {
    pBlunder: clamp(0.45 - (rating - 600) / 3000, 0.02, 0.45),
    temperature: clamp(6.0 - (rating - 600) / 300, 0.15, 6.0),
  };
}

export interface BotSearchSnapshot {
  /** Final depth-6 MultiPV-5 infos, in multipv order (side-to-move POV). */
  shallow: EngineInfo[];
  /** Final depth-18 MultiPV-5 infos, in multipv order (side-to-move POV). */
  deep: EngineInfo[];
  legalMoveCount: number;
  inCheck: boolean;
}

export interface BotMoveChoice {
  uci: string;
  /** True when the shallow-good/deep-bad branch fired. */
  playedBlunder: boolean;
  /** Mover-POV win-prob loss of the chosen move vs the deep best line. */
  wpLoss: number;
  /** Effective pBlunder after phase scaling (diagnostics/logging). */
  effectivePBlunder: number;
}

const BLUNDER_MIN_LOSS = 15;
const BLUNDER_MAX_LOSS = 45;
const SHALLOW_TOP_N = 3;

function moverWp(info: EngineInfo): number {
  if (info.mateIn !== null) return info.mateIn > 0 ? 100 : 0;
  return winProb(info.scoreCp ?? 0);
}

/**
 * §6.5 phase scaling: ×1.4 in complex middlegames (legal moves > 35), ×0.5
 * in forced sequences. "Forced" is operationalized as in check or ≤ 5 legal
 * moves — the calibration fit absorbs the exact cut.
 */
export function phaseFactor(legalMoveCount: number, inCheck: boolean): number {
  if (inCheck || legalMoveCount <= 5) return 0.5;
  if (legalMoveCount > 35) return 1.4;
  return 1;
}

export function selectBotMove(
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

  // Human-plausible blunders: top-3 at depth 6, deep loss inside the window
  // (below 15 it isn't a blunder; above 45 it's an absurdity — the random
  // queen hang this design exists to avoid).
  const blunderCandidates = candidates.filter((candidate) => {
    const rank = shallowRank.get(candidate.uci);
    return (
      rank !== undefined &&
      rank < SHALLOW_TOP_N &&
      candidate.wpLoss >= BLUNDER_MIN_LOSS &&
      candidate.wpLoss <= BLUNDER_MAX_LOSS
    );
  });

  const effectivePBlunder = clamp(
    params.pBlunder * phaseFactor(snapshot.legalMoveCount, snapshot.inCheck),
    0,
    0.9
  );

  if (blunderCandidates.length > 0 && rng() < effectivePBlunder) {
    // The most plausible blunder = the one the shallow search liked most.
    const chosen = blunderCandidates.reduce((a, b) =>
      (shallowRank.get(a.uci) ?? 9) <= (shallowRank.get(b.uci) ?? 9) ? a : b
    );
    return { uci: chosen.uci, playedBlunder: true, wpLoss: chosen.wpLoss, effectivePBlunder };
  }

  // Softmax over −wpLoss with temperature T.
  const weights = candidates.map((candidate) => Math.exp(-candidate.wpLoss / params.temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i] as number;
    if (roll <= 0) {
      const chosen = candidates[i] as (typeof candidates)[number];
      return { uci: chosen.uci, playedBlunder: false, wpLoss: chosen.wpLoss, effectivePBlunder };
    }
  }
  const fallback = candidates[0] as (typeof candidates)[number];
  return { uci: fallback.uci, playedBlunder: false, wpLoss: fallback.wpLoss, effectivePBlunder };
}
