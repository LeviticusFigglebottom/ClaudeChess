/**
 * Phase 2 gate report:
 *  A. every ply non-null on evalBeforeCp/wpLoss/classification/isCritical;
 *  B. timeSpentMs non-null wherever the source PGN carried %clk;
 *  C. blunder/mistake agreement vs Lichess's own judgments (their NAG
 *     annotations in the imported literate PGNs), ±20% per side across the
 *     sample, per-game table, >50% divergences investigated;
 *  D. C4 detector stats over every error ply: UNCLEAR < 15%, no detector
 *     over 40%.
 *
 * Re-runs the idempotent motif/finalize pass first so results reflect the
 * CURRENT detectors (the long burn may have started on older code).
 *
 *   DATABASE_URL=... npx tsx scripts/gate-phase2-report.mts [--handle gate-phase2]
 */
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { finalizeDerived, verifyBorderline } from "../src/lib/analysis/analyze-game";
import { AnalysisPool } from "../src/lib/analysis/pool";
import { createTablebaseClient } from "../src/lib/analysis/tablebase";
import { parseMultiPgn } from "../src/lib/chess/pgn-read";
import { LOSS_THRESHOLDS } from "../src/lib/eval/classify";

const args = process.argv.slice(2);
const handle = args.includes("--handle") ? args[args.indexOf("--handle") + 1]! : "gate-phase2";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

async function main() {
  const user = await db.query.users.findFirst({
    where: (users, { eq: equals }) => equals(users.handle, handle),
  });
  if (!user) throw new Error(`no user ${handle}`);
  const games = await db
    .select()
    .from(schema.games)
    .where(eq(schema.games.userId, user.id))
    .orderBy(asc(schema.games.importedAt));
  console.log(`${games.length} games for ${handle}\n`);

  // Borderline verification to completion (deeper re-search at the §4.2
  // decision boundaries), then refresh derived data with the CURRENT
  // detectors (idempotent).
  const pool = new AnalysisPool({ cap: 3, hashMb: 64 });
  const tb = createTablebaseClient(db, { enabled: true });
  let totalRefined = 0;
  for (const [index, game] of games.entries()) {
    for (;;) {
      const verify = await verifyBorderline(db, game.id, { pool, tb });
      totalRefined += verify.refined;
      if (verify.remaining === 0) break;
    }
    await finalizeDerived(db, game.id, { pool, tb });
    process.stderr.write(`\rverified+finalized ${index + 1}/${games.length} (refined ${totalRefined})`);
  }
  process.stderr.write("\n");
  pool.shutdown();

  // --- A/B: completeness ---
  const gameIds = games.map((game) => game.id);
  const plies = await db
    .select()
    .from(schema.plies)
    .where(inArray(schema.plies.gameId, gameIds))
    .orderBy(asc(schema.plies.gameId), asc(schema.plies.ply));
  const missingEval = plies.filter((p) => p.evalBeforeCp === null && p.mateBefore === null);
  const missingWpLoss = plies.filter((p) => p.wpLoss === null);
  const missingClass = plies.filter((p) => p.classification === null);
  const criticalCount = plies.filter((p) => p.isCritical).length;
  const clockPlies = plies.filter((p) => p.clockMsRemaining !== null);
  const clockButNoSpent = clockPlies.filter((p) => p.timeSpentMs === null);
  console.log(`— completeness (gate A/B) —`);
  console.log(
    `plies=${plies.length} nullEval=${missingEval.length} nullWpLoss=${missingWpLoss.length} nullClassification=${missingClass.length}`
  );
  console.log(
    `isCritical stored on ${criticalCount} plies (${((criticalCount / plies.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `%clk plies=${clockPlies.length}; with timeSpentMs=${clockPlies.length - clockButNoSpent.length} (${clockButNoSpent.length} missing)`
  );
  const verdictA =
    missingEval.length === 0 && missingWpLoss.length === 0 && missingClass.length === 0;
  console.log(`gate A: ${verdictA ? "PASS" : "FAIL"}, gate B: ${clockButNoSpent.length === 0 ? "PASS" : "FAIL"}\n`);

  // --- C: agreement vs Lichess judgments ---
  const pliesByGame = new Map<string, typeof plies>();
  for (const ply of plies) {
    const list = pliesByGame.get(ply.gameId) ?? [];
    list.push(ply);
    pliesByGame.set(ply.gameId, list);
  }

  interface SideCounts {
    blunders: number;
    mistakes: number;
  }
  const totals = {
    ours: { white: { blunders: 0, mistakes: 0 }, black: { blunders: 0, mistakes: 0 } },
    lichess: { white: { blunders: 0, mistakes: 0 }, black: { blunders: 0, mistakes: 0 } },
  };
  const table: string[] = [];
  const divergent: string[] = [];
  console.log(`— agreement vs Lichess (gate C) — per-game table —`);
  console.log(
    `game      | ours W (B/M) | lich W (B/M) | ours B (B/M) | lich B (B/M)`
  );
  for (const game of games) {
    const raw = parseMultiPgn(game.pgn)[0];
    if (!raw) continue;
    const lichess = { white: { blunders: 0, mistakes: 0 }, black: { blunders: 0, mistakes: 0 } };
    raw.moves.forEach((move, index) => {
      const side = index % 2 === 0 ? "white" : "black";
      if (move.nags.includes(4)) lichess[side].blunders++;
      else if (move.nags.includes(2)) lichess[side].mistakes++;
    });
    const ours = { white: { blunders: 0, mistakes: 0 }, black: { blunders: 0, mistakes: 0 } };
    for (const ply of pliesByGame.get(game.id) ?? []) {
      const side = ply.color as "white" | "black";
      // MISS folds into the band its wp-loss implies — the apples-to-apples
      // §4.2 comparison (Lichess has no MISS class; its missed wins carry
      // ?/?? by loss size, same as ours would without the MISS override).
      const cls = ply.classification;
      const loss = ply.wpLoss ?? 0;
      if (cls === "BLUNDER" || (cls === "MISS" && loss >= LOSS_THRESHOLDS.mistake))
        ours[side].blunders++;
      else if (
        cls === "MISTAKE" ||
        (cls === "MISS" && loss >= LOSS_THRESHOLDS.inaccuracy && loss < LOSS_THRESHOLDS.mistake)
      )
        ours[side].mistakes++;
    }
    for (const side of ["white", "black"] as const) {
      totals.ours[side].blunders += ours[side].blunders;
      totals.ours[side].mistakes += ours[side].mistakes;
      totals.lichess[side].blunders += lichess[side].blunders;
      totals.lichess[side].mistakes += lichess[side].mistakes;
    }
    const line = `${game.externalId} |     ${ours.white.blunders}/${ours.white.mistakes}      |     ${lichess.white.blunders}/${lichess.white.mistakes}      |     ${ours.black.blunders}/${ours.black.mistakes}      |     ${lichess.black.blunders}/${lichess.black.mistakes}`;
    table.push(line);
    console.log(line);
    const oursTotal = ours.white.blunders + ours.black.blunders + ours.white.mistakes + ours.black.mistakes;
    const lichessTotal =
      lichess.white.blunders + lichess.black.blunders + lichess.white.mistakes + lichess.black.mistakes;
    if (lichessTotal >= 4 && Math.abs(oursTotal - lichessTotal) / lichessTotal > 0.5) {
      divergent.push(`${game.externalId}: ours=${oursTotal} lichess=${lichessTotal}`);
    }
  }
  console.log(`\naggregate per side across the sample:`);
  for (const side of ["white", "black"] as const) {
    for (const kind of ["blunders", "mistakes"] as const) {
      const ours = totals.ours[side][kind as keyof SideCounts];
      const theirs = totals.lichess[side][kind as keyof SideCounts];
      const delta = theirs > 0 ? (Math.abs(ours - theirs) / theirs) * 100 : ours === 0 ? 0 : 100;
      console.log(
        `  ${side} ${kind}: ours=${ours} lichess=${theirs} → ${delta.toFixed(1)}% ${delta <= 20 ? "PASS" : "FAIL"} (±20%)`
      );
    }
  }
  if (divergent.length) {
    console.log(`\ngames diverging >50% (to investigate): ${divergent.length}`);
    for (const line of divergent.slice(0, 10)) console.log(`  ${line}`);
  }

  // --- D: detector stats over every error ply ---
  const errorPlies = plies.filter((p) =>
    ["MISTAKE", "BLUNDER", "MISS"].includes(p.classification ?? "")
  );
  const tags = errorPlies.length
    ? await db
        .select()
        .from(schema.blunderTags)
        .where(
          inArray(
            schema.blunderTags.plyId,
            errorPlies.map((p) => p.id)
          )
        )
    : [];
  const rank1 = new Map<number, string>();
  for (const tag of tags) if (tag.rank === 1) rank1.set(tag.plyId, tag.motif);
  const counts = new Map<string, number>();
  for (const ply of errorPlies) {
    const motif = rank1.get(ply.id) ?? "UNCLEAR";
    counts.set(motif, (counts.get(motif) ?? 0) + 1);
  }
  const n = errorPlies.length;
  console.log(`\n— detector distribution (gate D) over ${n} error plies —`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let unclearRate = 0;
  let maxRate = 0;
  let maxName = "";
  for (const [motif, count] of sorted) {
    const rate = (count / n) * 100;
    if (motif === "UNCLEAR") unclearRate = rate;
    else if (rate > maxRate) {
      maxRate = rate;
      maxName = motif;
    }
    console.log(`  ${motif.padEnd(28)} ${String(count).padStart(4)}  ${rate.toFixed(1)}%`);
  }
  console.log(
    `UNCLEAR ${unclearRate.toFixed(1)}% ${unclearRate < 15 ? "PASS" : "FAIL"} (<15%); ` +
      `max detector ${maxName} ${maxRate.toFixed(1)}% ${maxRate <= 40 ? "PASS" : "FAIL"} (≤40%)`
  );
  console.log(`(error-ply sample size: ${n} — the C4 500-sample statement is scaled to it)`);
  await client.end();
  process.exit(0);
}

await main();
