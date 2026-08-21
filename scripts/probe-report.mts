/**
 * Summarizes arena JSONLs: score, Elo estimate vs the anchor, candidate
 * availability (revision d), and move-kind distribution per file.
 *
 *   npx tsx scripts/probe-report.mts data/calibration/rev-*.jsonl
 */
import { readFileSync } from "node:fs";
import { eloFromMatch } from "../src/lib/rating/elo";

interface Record_ {
  score: number;
  opponent: string;
  moves?: number;
  blunderAvailable?: number;
  byKind?: { random: number; blunder: number; sampled: number };
  branchMoves?: number;
  branchAvailable?: number;
  plies: number;
  ms: number;
}

for (const file of process.argv.slice(2)) {
  const games = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
  if (games.length === 0) {
    console.log(`${file}: empty`);
    continue;
  }
  const points = games.reduce((sum, game) => sum + game.score, 0);
  const opponent = games[0]!.opponent;
  const anchorElo = Number(opponent.match(/sf-elo-(\d+)/)?.[1] ?? NaN);
  const totalMoves = games.reduce((sum, game) => sum + (game.moves ?? 0), 0);
  const availability = games.reduce((sum, game) => sum + (game.blunderAvailable ?? 0), 0);
  // Conditional on reaching the blunder branch (excludes pRandom-consumed
  // moves). Legacy files lack the fields — fall back to the raw rate.
  const branchMoves = games.reduce((sum, game) => sum + (game.branchMoves ?? game.moves ?? 0), 0);
  const branchAvailable = games.reduce(
    (sum, game) => sum + (game.branchAvailable ?? game.blunderAvailable ?? 0),
    0
  );
  const kinds = games.reduce(
    (acc, game) => ({
      random: acc.random + (game.byKind?.random ?? 0),
      blunder: acc.blunder + (game.byKind?.blunder ?? 0),
      sampled: acc.sampled + (game.byKind?.sampled ?? 0),
    }),
    { random: 0, blunder: 0, sampled: 0 }
  );
  const avgPlies = games.reduce((sum, game) => sum + game.plies, 0) / games.length;
  const avgSec = games.reduce((sum, game) => sum + game.ms, 0) / games.length / 1000;

  let eloText = "n/a (bot opponent)";
  if (!Number.isNaN(anchorElo)) {
    const estimate = eloFromMatch(anchorElo, points, games.length);
    eloText = `${Math.round(estimate.elo)} ±${Math.round(estimate.ci95)}`;
  }
  const availabilityPct = totalMoves > 0 ? ((availability / totalMoves) * 100).toFixed(1) : "n/a";
  const branchPct = branchMoves > 0 ? ((branchAvailable / branchMoves) * 100).toFixed(1) : "n/a";
  console.log(
    `${file}\n  games ${games.length}  score ${points}/${games.length} (${((points / games.length) * 100).toFixed(1)}%)  vs ${opponent}  → Elo ${eloText}\n  availability ${branchPct}% of ${branchMoves} branch-reaching moves (raw ${availabilityPct}% of ${totalMoves})  kinds r/b/s ${kinds.random}/${kinds.blunder}/${kinds.sampled}  avg ${avgPlies.toFixed(0)} plies ${avgSec.toFixed(0)}s`
  );
}
