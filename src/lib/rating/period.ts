import { updateRating, type GameResult, type Glicko2Rating } from "./glicko2";

/**
 * Glicko-2 rating-period batching (spec §7): results accumulate and the
 * rating updates once per period — 12 games or 7 days, whichever first.
 * Per-game updates would defeat the estimator; this module is the only
 * place periods close. Keyed storage (per variant × time-control bucket)
 * is the caller's concern.
 */

export const RATING_PERIOD_GAMES = 12;
export const RATING_PERIOD_DAYS = 7;

export interface PendingResult extends GameResult {
  /** Epoch ms when the game finished. */
  at: number;
}

export interface RatingPeriodState {
  rating: Glicko2Rating;
  pending: PendingResult[];
}

export function createPeriodState(rating: Glicko2Rating): RatingPeriodState {
  return { rating, pending: [] };
}

function periodExpired(state: RatingPeriodState, now: number): boolean {
  const first = state.pending[0];
  return first !== undefined && now - first.at >= RATING_PERIOD_DAYS * 86_400_000;
}

function close(state: RatingPeriodState): RatingPeriodState {
  return { rating: updateRating(state.rating, state.pending), pending: [] };
}

/** Settles a due period (7-day rule) without adding a result. */
export function settleIfDue(state: RatingPeriodState, now: number): RatingPeriodState {
  return periodExpired(state, now) ? close(state) : state;
}

/**
 * Records a finished game. Closes the period first if the 7-day rule is
 * already due, then again immediately when this game is the 12th.
 */
export function addResult(
  state: RatingPeriodState,
  result: GameResult,
  now: number
): RatingPeriodState {
  const settled = settleIfDue(state, now);
  const withResult: RatingPeriodState = {
    rating: settled.rating,
    pending: [...settled.pending, { ...result, at: now }],
  };
  return withResult.pending.length >= RATING_PERIOD_GAMES ? close(withResult) : withResult;
}
