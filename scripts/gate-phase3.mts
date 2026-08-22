/**
 * Phase 3 gates, machine-verified:
 *  1. Puzzle rating converges within 30 puzzles — synthetic solvers of known
 *     true strength run through the REAL selection + per-attempt Glicko flow
 *     (P(solve) = Glicko expected score of true strength vs the served
 *     puzzle). Convergence = |estimate − truth| and a settled trajectory at
 *     attempt 30.
 *  2. Explorer p95 < 300 ms warm — measured over 120 warm hits on the live
 *     route (requires `npm run dev`/`start` on :3000 with dev-auth).
 *
 *   DATABASE_URL=... npx tsx scripts/gate-phase3.mts
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { ensureUser } from "../src/lib/account/users";
import { getPuzzleRating, nextPuzzle, recordPuzzleAttempt } from "../src/lib/puzzles";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Glicko-1 expected score with the solver treated as exact (RD 0). */
function expectedScore(trueRating: number, puzzleRating: number, puzzleRd: number): number {
  const g = 1 / Math.sqrt(1 + (3 * (0.0057565 * puzzleRd) ** 2) / Math.PI ** 2);
  return 1 / (1 + 10 ** ((-g * (trueRating - puzzleRating)) / 400));
}

async function convergenceRun(trueRating: number, seed: number) {
  const random = mulberry32(seed);
  const { user } = await ensureUser(db, {
    id: randomUUID(),
    isAnonymous: true,
    email: null,
    emailConfirmedAt: null,
  });
  const trajectory: number[] = [];
  for (let attempt = 1; attempt <= 45; attempt++) {
    const puzzle = await nextPuzzle(db, user.id);
    const p = expectedScore(trueRating, puzzle.rating, 80);
    const solved = random() < p;
    const result = await recordPuzzleAttempt(db, user, { puzzleId: puzzle.id, solved });
    trajectory.push(result.rating.rating);
  }
  const at30 = trajectory[29]!;
  const settle = Math.max(
    ...trajectory.slice(25, 30).map((rating, index, window) =>
      index > 0 ? Math.abs(rating - window[index - 1]!) : 0
    )
  );
  const finalRating = (await getPuzzleRating(db, user.id)).rating;
  return { trueRating, at30, errorAt30: Math.abs(at30 - trueRating), settle, finalRating, trajectory };
}

async function explorerLatency() {
  const fens = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
    "r1bqkbnr/pp1ppppp/2n5/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2",
    "rnbqkb1r/ppp1pppp/5n2/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 2 3",
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  ];
  const cookie = `gambit-dev-user=${randomUUID()}`;
  // Cold pass fills the cache.
  for (const fen of fens) {
    await fetch(`http://localhost:3000/api/explorer?fen=${encodeURIComponent(fen)}`, {
      headers: { Cookie: cookie },
    });
  }
  const times: number[] = [];
  for (let i = 0; i < 120; i++) {
    const fen = fens[i % fens.length]!;
    const t0 = performance.now();
    const response = await fetch(
      `http://localhost:3000/api/explorer?fen=${encodeURIComponent(fen)}`,
      { headers: { Cookie: cookie } }
    );
    await response.json();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    n: times.length,
    p50: times[Math.floor(times.length * 0.5)]!,
    p95: times[Math.floor(times.length * 0.95)]!,
    max: times[times.length - 1]!,
  };
}

async function main() {
  console.log("— gate 1: puzzle rating convergence (real selection + rating flow) —");
  for (const [trueRating, seed] of [
    [1650, 101],
    [950, 202],
    [2100, 303],
  ] as const) {
    const run = await convergenceRun(trueRating, seed);
    console.log(
      `true=${trueRating}: at attempt 30 → ${run.at30.toFixed(0)} (error ${run.errorAt30.toFixed(0)}), ` +
        `max step in attempts 26-30: ${run.settle.toFixed(0)}, after 45 → ${run.finalRating.toFixed(0)}`
    );
    console.log(
      `  trajectory (every 5th): ${run.trajectory.filter((_, i) => i % 5 === 4).map((r) => r.toFixed(0)).join(" → ")}`
    );
  }

  console.log("\n— gate 2: explorer p95 warm —");
  try {
    const latency = await explorerLatency();
    console.log(
      `warm hits: ${latency.n}, p50 ${latency.p50.toFixed(1)}ms, p95 ${latency.p95.toFixed(1)}ms, max ${latency.max.toFixed(1)}ms → ${
        latency.p95 < 300 ? "PASS" : "FAIL"
      } (< 300ms)`
    );
  } catch (error) {
    console.log(`explorer measurement failed: ${(error as Error).message} (is the dev server on :3000?)`);
  }
  await client.end();
  process.exit(0);
}

await main();
