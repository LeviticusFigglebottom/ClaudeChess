import { describe, expect, it } from "vitest";
import {
  applyMove,
  createClock,
  describeClock,
  isFlagged,
  remainingMs,
  startClock,
  timeControlBucket,
  type ClockConfig,
} from "./clock";

const fischer: ClockConfig = { mode: "fischer", initialMs: 180_000, incrementMs: 2_000 };
const bronstein: ClockConfig = { mode: "bronstein", initialMs: 180_000, incrementMs: 3_000 };
const delay: ClockConfig = { mode: "delay", initialMs: 300_000, incrementMs: 5_000 };

describe("Fischer increment (added after the move)", () => {
  it("charges thinking time and adds the full increment", () => {
    let state = startClock(createClock(fischer), 0);
    state = applyMove(state, 10_000); // white thought 10s
    expect(state.whiteMs).toBe(180_000 - 10_000 + 2_000);
    expect(state.turn).toBe("b");
  });

  it("can gain time by moving faster than the increment", () => {
    let state = startClock(createClock(fischer), 0);
    state = applyMove(state, 500);
    expect(state.whiteMs).toBe(180_000 - 500 + 2_000); // net +1.5s
  });
});

describe("Bronstein delay (give-back capped at time spent)", () => {
  it("gives back the full increment after a long think", () => {
    let state = startClock(createClock(bronstein), 0);
    state = applyMove(state, 10_000);
    expect(state.whiteMs).toBe(180_000 - 10_000 + 3_000);
  });

  it("never gains time: fast moves give back only what was spent", () => {
    let state = startClock(createClock(bronstein), 0);
    state = applyMove(state, 1_000); // spent 1s < 3s increment
    expect(state.whiteMs).toBe(180_000); // -1000 + 1000
  });
});

describe("Simple delay (countdown starts after the delay)", () => {
  it("does not charge within the delay window", () => {
    let state = startClock(createClock(delay), 0);
    expect(remainingMs(state, "w", 4_000)).toBe(300_000); // still inside 5s delay
    state = applyMove(state, 4_000);
    expect(state.whiteMs).toBe(300_000);
  });

  it("charges only the time beyond the delay, and adds nothing back", () => {
    let state = startClock(createClock(delay), 0);
    expect(remainingMs(state, "w", 12_000)).toBe(300_000 - 7_000);
    state = applyMove(state, 12_000);
    expect(state.whiteMs).toBe(293_000);
  });
});

describe("flagging", () => {
  it("detects flagfall mid-turn and refuses to complete the move", () => {
    const state = startClock(createClock(fischer), 0);
    expect(isFlagged(state, 179_999)).toBe(false);
    expect(isFlagged(state, 180_000)).toBe(true);
    const flagged = applyMove(state, 200_000);
    expect(flagged.flagged).toBe("w");
    expect(remainingMs(flagged, "w", 200_000)).toBe(0);
  });

  it("delay mode flags only after banked + delay elapses", () => {
    const short: ClockConfig = { mode: "delay", initialMs: 1_000, incrementMs: 5_000 };
    const state = startClock(createClock(short), 0);
    expect(isFlagged(state, 5_500)).toBe(false); // 5s delay + 0.5s charged
    expect(isFlagged(state, 6_000)).toBe(true);
  });

  it("opponent's clock does not run", () => {
    const state = startClock(createClock(fischer), 0);
    expect(remainingMs(state, "b", 60_000)).toBe(180_000);
  });
});

describe("pre-start and none mode", () => {
  it("moves before the clock starts are free", () => {
    let state = createClock(fischer);
    state = applyMove(state, 99_999);
    expect(state.whiteMs).toBe(180_000);
    expect(state.turn).toBe("b");
  });

  it("mode none never charges or flags", () => {
    let state = startClock(createClock({ mode: "none", initialMs: 0, incrementMs: 0 }), 0);
    state = applyMove(state, 10 ** 9);
    expect(isFlagged(state, 10 ** 10)).toBe(false);
  });
});

describe("bucketing and description", () => {
  it("estimates duration as base + 40×increment", () => {
    expect(timeControlBucket({ mode: "fischer", initialMs: 60_000, incrementMs: 0 })).toBe("bullet");
    expect(timeControlBucket({ mode: "fischer", initialMs: 120_000, incrementMs: 1_000 })).toBe(
      "bullet"
    ); // 160s
    expect(timeControlBucket({ mode: "fischer", initialMs: 180_000, incrementMs: 2_000 })).toBe(
      "blitz"
    ); // 260s
    expect(timeControlBucket({ mode: "fischer", initialMs: 600_000, incrementMs: 0 })).toBe("rapid");
    expect(timeControlBucket({ mode: "delay", initialMs: 1_800_000, incrementMs: 5_000 })).toBe(
      "classical"
    );
  });

  it("describes all modes", () => {
    expect(describeClock(fischer)).toBe("3+2");
    expect(describeClock(bronstein)).toBe("3 br3");
    expect(describeClock(delay)).toBe("5 d5");
    expect(describeClock({ mode: "none", initialMs: 0, incrementMs: 0 })).toBe("∞");
  });
});
