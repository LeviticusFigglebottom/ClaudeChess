/**
 * Re-verification of every ply the d24 verify pass touched, after the
 * 20s-soft-stop finding: those searches ran with a ceiling below the
 * shape's median-to-tail wall-clock, so ~a quarter were truncated and
 * recorded at full depth. Re-runs them through verifyBorderline ITSELF
 * (selection forced to analyzedAtDepth ≥ 24) under the fitted watchdog
 * budgets — same update rules, honest depth this time.
 *
 * Checkpointed: the pre-run classification snapshot is written once and
 * games complete one at a time (JSONL); an interruption resumes. Three
 * games in flight (single-threaded engines, 4 cores).
 *
 *   npx tsx scripts/reverify-d24.mts
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { asc, eq, sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { AnalysisPool } from "../src/lib/analysis/pool";
import { createTablebaseClient } from "../src/lib/analysis/tablebase";
import { verifyBorderline, VERIFY_RULES } from "../src/lib/analysis/analyze-game";

const SNAPSHOT = "data/reverify-d24-baseline.json";
const PROGRESS = "data/reverify-d24-progress.jsonl";

const client = postgres(process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit", { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

async function main() {
  const rows = await client`
    SELECT p.id, p.game_id, p.ply, p.classification::text AS cls, p.wp_loss, p.analyzed_at_depth
    FROM plies p JOIN games g ON g.id=p.game_id JOIN users u ON u.id=g.user_id
    WHERE u.handle='gate-phase2' AND p.analyzed_at_depth >= ${VERIFY_RULES.depth}
    ORDER BY p.game_id, p.ply`;
  if (!existsSync(SNAPSHOT)) {
    writeFileSync(
      SNAPSHOT,
      JSON.stringify(rows.map((r) => ({ id: r.id, gameId: r.game_id, ply: r.ply, cls: r.cls, wpLoss: r.wp_loss })))
    );
    console.log(`baseline snapshot: ${rows.length} plies`);
  }
  const done = new Set<string>(
    existsSync(PROGRESS)
      ? readFileSync(PROGRESS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).gameId)
      : []
  );
  const gameIds = [...new Set(rows.map((r) => r.game_id as string))].filter((id) => !done.has(id));
  console.log(`${gameIds.length} games to re-verify (of ${new Set(rows.map((r) => r.game_id)).size})`);

  const pool = new AnalysisPool({ cap: 3, hashMb: 128 });
  const tb = createTablebaseClient(db);
  let index = 0;
  const worker = async () => {
    for (;;) {
      const my = index++;
      if (my >= gameIds.length) return;
      const gameId = gameIds[my]!;
      const t0 = Date.now();
      const result = await verifyBorderline(db, gameId, { pool, tb }, {
        force: (row) => (row.analyzedAtDepth ?? 0) >= VERIFY_RULES.depth,
      });
      appendFileSync(PROGRESS, JSON.stringify({ gameId, ...result, ms: Date.now() - t0 }) + "\n");
      console.log(`${my + 1}/${gameIds.length} ${gameId.slice(0, 8)} refined=${result.refined} positions=${result.positionsUsed} ${(Date.now() - t0) / 1000 | 0}s`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  pool.shutdown();

  // Diff report.
  const baseline = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { id: number; cls: string; wpLoss: number }[];
  const after = await client`
    SELECT p.id, p.classification::text AS cls, p.wp_loss, p.degraded
    FROM plies p WHERE p.id = ANY(${baseline.map((b) => b.id)})`;
  const afterById = new Map(after.map((r) => [Number(r.id), r]));
  const flips = new Map<string, number>();
  let changed = 0;
  let degradedCount = 0;
  for (const b of baseline) {
    const now = afterById.get(Number(b.id));
    if (!now) continue;
    if (now.degraded) degradedCount++;
    if (now.cls !== b.cls) {
      changed++;
      const key = `${b.cls} -> ${now.cls}`;
      flips.set(key, (flips.get(key) ?? 0) + 1);
    }
  }
  console.log(`\nre-verified ${baseline.length} plies: ${changed} classification changes, ${degradedCount} degraded`);
  for (const [flip, count] of [...flips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flip}: ${count}`);
  }
  await client.end();
  process.exit(0);
}

await main();
