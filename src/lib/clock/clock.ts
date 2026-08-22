/**
 * Chess clock semantics (spec Phase 1, A3.6 — specified explicitly and
 * tested). Pure model: state in, state out, no timers — the UI ticks by
 * asking `remainingMs(state, color, now)` and applies moves with
 * `applyMove(state, now)`. Server-authoritative clocks (Phase 4) reuse this
 * module unchanged.
 *
 * Modes:
 * - fischer:   increment added AFTER each move.
 * - bronstein: after the move, min(timeSpent, increment) is added back —
 *              you can never gain time on your clock.
 * - delay:     (simple/US delay) the clock does not start counting down
 *              until `incrementMs` of the turn has elapsed; nothing is
 *              added back.
 * - none:      no time control (casual analysis).
 */

export type ClockMode = "fischer" | "bronstein" | "delay" | "none";

export interface ClockConfig {
  mode: ClockMode;
  initialMs: number;
  /** Increment (fischer/bronstein) or delay budget (delay), per move. */
  incrementMs: number;
}

export interface ClockState {
  config: ClockConfig;
  /** Banked time per color, as of `turnStartedAt`. */
  whiteMs: number;
  blackMs: number;
  /** Whose clock is conceptually running. */
  turn: "w" | "b";
  /** Timestamp when the current turn began; null before the clock starts. */
  turnStartedAt: number | null;
  flagged: "w" | "b" | null;
}

export function createClock(config: ClockConfig): ClockState {
  return {
    config,
    whiteMs: config.initialMs,
    blackMs: config.initialMs,
    turn: "w",
    turnStartedAt: null,
    flagged: null,
  };
}

/** Starts the clock (conventionally after Black's first opportunity — callers decide). */
export function startClock(state: ClockState, now: number): ClockState {
  if (state.turnStartedAt !== null || state.config.mode === "none") return state;
  return { ...state, turnStartedAt: now };
}

function elapsedInTurn(state: ClockState, now: number): number {
  if (state.turnStartedAt === null) return 0;
  return Math.max(0, now - state.turnStartedAt);
}

/** Chargeable time consumed so far this turn (delay mode absorbs the budget first). */
function chargeableElapsed(state: ClockState, now: number): number {
  const elapsed = elapsedInTurn(state, now);
  if (state.config.mode === "delay") {
    return Math.max(0, elapsed - state.config.incrementMs);
  }
  return elapsed;
}

/** Remaining time for a color at `now` — what the UI displays. */
export function remainingMs(state: ClockState, color: "w" | "b", now: number): number {
  if (state.flagged === color) return 0;
  const banked = color === "w" ? state.whiteMs : state.blackMs;
  if (state.config.mode === "none") return banked;
  if (state.turn !== color || state.turnStartedAt === null || state.flagged) {
    return Math.max(0, banked);
  }
  return Math.max(0, banked - chargeableElapsed(state, now));
}

/**
 * Signed remaining for a color at `now` — negative once past flagfall.
 * The display clamp lives in remainingMs; this is the evidence value
 * (Phase 4 gate: |remaining at verified claim| is the clock drift).
 */
export function remainingRawMs(state: ClockState, color: "w" | "b", now: number): number {
  const banked = color === "w" ? state.whiteMs : state.blackMs;
  if (state.config.mode === "none") return banked;
  if (state.turn !== color || state.turnStartedAt === null || state.flagged) {
    return banked;
  }
  return banked - chargeableElapsed(state, now);
}

/** True when the side to move has run out at `now`. */
export function isFlagged(state: ClockState, now: number): boolean {
  if (state.config.mode === "none" || state.turnStartedAt === null) return false;
  return remainingMs(state, state.turn, now) <= 0;
}

/**
 * The side to move completes a move at `now`. Applies the mode's
 * increment/give-back and hands the turn over. If the mover was already out
 * of time, the state flags instead — callers must treat that as flagfall,
 * not a completed move.
 */
export function applyMove(state: ClockState, now: number): ClockState {
  if (state.config.mode === "none") {
    return { ...state, turn: state.turn === "w" ? "b" : "w" };
  }
  if (state.turnStartedAt === null) {
    // Clock not started yet (opening moves by convention): no charge.
    return { ...state, turn: state.turn === "w" ? "b" : "w" };
  }

  const banked = state.turn === "w" ? state.whiteMs : state.blackMs;
  const charged = chargeableElapsed(state, now);

  if (banked - charged <= 0) {
    return {
      ...state,
      whiteMs: state.turn === "w" ? 0 : state.whiteMs,
      blackMs: state.turn === "b" ? 0 : state.blackMs,
      flagged: state.turn,
    };
  }

  let credit = 0;
  if (state.config.mode === "fischer") {
    credit = state.config.incrementMs;
  } else if (state.config.mode === "bronstein") {
    const spent = elapsedInTurn(state, now);
    credit = Math.min(spent, state.config.incrementMs);
  }

  const nextBanked = banked - charged + credit;
  return {
    ...state,
    whiteMs: state.turn === "w" ? nextBanked : state.whiteMs,
    blackMs: state.turn === "b" ? nextBanked : state.blackMs,
    turn: state.turn === "w" ? "b" : "w",
    turnStartedAt: now,
  };
}

/** Marks the side to move as flagged (call when isFlagged turns true). */
export function flag(state: ClockState): ClockState {
  return { ...state, flagged: state.turn };
}

/** Time-control buckets for rating keys (spec §7): estimate = base + 40×increment. */
export function timeControlBucket(config: ClockConfig): "bullet" | "blitz" | "rapid" | "classical" {
  const estimateSec = (config.initialMs + 40 * config.incrementMs) / 1000;
  if (estimateSec < 180) return "bullet";
  if (estimateSec < 480) return "blitz";
  if (estimateSec < 1500) return "rapid";
  return "classical";
}

/** "3+2", "5 d5", "3 br2", or "∞" for display and PGN TimeControl-ish uses. */
export function describeClock(config: ClockConfig): string {
  if (config.mode === "none") return "∞";
  const baseMin = Math.round(config.initialMs / 60000);
  const incSec = Math.round(config.incrementMs / 1000);
  if (config.mode === "fischer") return `${baseMin}+${incSec}`;
  if (config.mode === "delay") return `${baseMin} d${incSec}`;
  return `${baseMin} br${incSec}`;
}
