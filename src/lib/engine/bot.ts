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

/**
 * Revisions (a) + (b), amended after the sweep-1 availability finding:
 * pinning the shallow pass at depth 6 narrowed the shallow/truth gap to 8
 * plies exactly at the low bands, which need the widest gap. The shallow
 * pass now keeps a constant 12-ply gap (floor 2) and its MultiPV scales
 * with band like the truth pass — an intersection bounded by 5 shallow
 * candidates could never exceed 5.
 */
export function bandSearchSettings(rating: number): { shallow: SearchSettings; deep: SearchSettings } {
  const multipv = clamp(Math.round(24 - (rating - 600) / 100), 4, 24);
  const truthDepth = rating < 1600 ? 14 : 18;
  return {
    shallow: { depth: Math.max(2, truthDepth - 12), multipv },
    deep: { depth: truthDepth, multipv },
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

/* ------------------------------------------------------------------ */
/* Policy v2 — ORGANIC (owner directive 2026-08-23, supersedes §6).    */
/*                                                                     */
/* The v1 texture (wide-MultiPV temperature + a deliberate-blunder     */
/* branch) measured on-label but read as "strong moves + arbitrary     */
/* howlers". v2 weakens the way humans are weak:                       */
/*                                                                     */
/*  · 1400–2200: Stockfish's own UCI_LimitStrength — the engine's      */
/*    native skill limiter, played via its REAL bestmove (the limiter  */
/*    deliberately picks moves that are not the top info line).        */
/*    Ruler-anchored by construction: the v1 gate DEFINED this scale   */
/*    with sf-elo anchors at 400ms/move, so SF@label at 400ms IS the   */
/*    label (1400 uses SF@1320 — the 1400 label is defective at this   */
/*    movetime, data/calibration/ruler-checks.txt).                    */
/*  · 600–1200: below SF's UCI_Elo floor (1320) — ONE shallow search   */
/*    at low MultiPV, mild-temperature softmax over its lines, no      */
/*    blunder branch, no random floor. Mistakes come from the shallow  */
/*    eval itself (exactly like a weak human), and every candidate is  */
/*    something the engine considered playable. Depth carries the      */
/*    band; temperature adds variety. Params live in                   */
/*    bot-calibration-v2.json, measured by the arena.                  */
/* ------------------------------------------------------------------ */

/** The ruler movetime the v1 gate defined the label scale at. */
export const REFERENCE_MOVETIME_MS = 400;

export interface OrganicParams {
  depth: number;
  multipv: number;
  temperature: number;
}

export type BotPlan =
  | {
      kind: "limitStrength";
      uciElo: number;
      /** Ruler condition for the anchor bands (400ms, single thread). */
      movetimeMs?: number;
      /**
       * Node cap for the sub-floor bands (600–1400): SF's UCI_Elo cannot go
       * below 1320, so those bands keep the limiter's native error model at
       * 1320 and throttle NODES — hardware-independent (unlike movetime in
       * a browser) and measured on the same 400ms ruler scale.
       */
      nodes?: number;
    }
  | ({ kind: "organic" } & OrganicParams);

/**
 * Softmax over one search's lines (mover POV) at temperature. Returns null
 * only when the engine produced no usable line.
 */
export function selectOrganicMove(
  params: OrganicParams,
  infos: EngineInfo[],
  rng: Rng
): BotMoveChoice | null {
  const usable = infos.filter((info) => info.pv.length > 0);
  if (usable.length === 0) return null;
  const bestWp = moverWp(usable[0] as EngineInfo);
  const candidates = usable.map((info) => ({
    uci: info.pv[0] as string,
    wpLoss: Math.max(0, bestWp - moverWp(info)),
  }));
  const weights = candidates.map((candidate) =>
    Math.exp(-candidate.wpLoss / Math.max(0.05, params.temperature))
  );
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
        blunderAvailable: false,
        effectivePBlunder: 0,
      };
    }
  }
  const fallback = candidates[0] as (typeof candidates)[number];
  return {
    uci: fallback.uci,
    kind: "sampled",
    wpLoss: fallback.wpLoss,
    blunderAvailable: false,
    effectivePBlunder: 0,
  };
}
