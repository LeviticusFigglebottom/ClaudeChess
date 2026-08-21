import { describe, expect, it } from "vitest";
import { newPlayerRating, updateRating } from "./glicko2";
import { addResult, createPeriodState, RATING_PERIOD_GAMES, settleIfDue } from "./period";

const DAY = 86_400_000;
const win = { opponentRating: 1500, opponentRd: 30, score: 1 };

describe("rating-period batching (spec §7)", () => {
  it("does not update the rating before the period closes", () => {
    let state = createPeriodState(newPlayerRating());
    for (let i = 0; i < RATING_PERIOD_GAMES - 1; i++) {
      state = addResult(state, win, i * 1000);
    }
    expect(state.rating.rating).toBe(1500);
    expect(state.pending).toHaveLength(11);
  });

  it("the 12th game closes the period and applies one batched update", () => {
    let state = createPeriodState(newPlayerRating());
    for (let i = 0; i < RATING_PERIOD_GAMES; i++) {
      state = addResult(state, win, i * 1000);
    }
    expect(state.pending).toHaveLength(0);
    expect(state.rating.rating).toBeGreaterThan(1500);
  });

  it("7 days closes a partial period", () => {
    let state = createPeriodState(newPlayerRating());
    state = addResult(state, win, 0);
    state = addResult(state, win, DAY);
    expect(state.pending).toHaveLength(2);
    state = settleIfDue(state, 7 * DAY);
    expect(state.pending).toHaveLength(0);
    expect(state.rating.rating).toBeGreaterThan(1500);
  });

  it("a result arriving after 7 days settles the old period first, then starts a new one", () => {
    let state = createPeriodState(newPlayerRating());
    state = addResult(state, win, 0);
    const ratingAfterFirstPeriodWouldBe = state.rating.rating; // still 1500
    state = addResult(state, win, 8 * DAY);
    expect(state.pending).toHaveLength(1); // new period holds only the new game
    expect(state.rating.rating).toBeGreaterThan(ratingAfterFirstPeriodWouldBe);
  });

  it("settleIfDue is a no-op with nothing pending or period still open", () => {
    const empty = createPeriodState(newPlayerRating());
    expect(settleIfDue(empty, 100 * DAY)).toBe(empty);
    const open = addResult(empty, win, 0);
    expect(settleIfDue(open, DAY).pending).toHaveLength(1);
  });

  it("batched update differs from per-game updates (the point of periods)", () => {
    // Same 12 results applied as one batch vs sequentially game-by-game.
    let batched = createPeriodState(newPlayerRating());
    for (let i = 0; i < 12; i++) batched = addResult(batched, win, i);

    let sequential = newPlayerRating();
    for (let i = 0; i < 12; i++) {
      sequential = updateRating(sequential, [win]);
    }
    expect(batched.rating.rating).not.toBeCloseTo(sequential.rating, 1);
  });
});
