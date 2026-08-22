/**
 * Phase 2 gate — step 2: run the full §4 batch analysis over every
 * unanalyzed game of a user (default: the gate user), with the
 * variant-partitioned pool (B0.2) and tablebase probes (B0.1).
 *
 *   DATABASE_URL=... npx tsx scripts/analyze-batch.mts [--handle gate-phase2] \
 *       [--concurrency 3] [--depth 18] [--tb 1]
 *
 * Progress prints per ply; safe to interrupt and re-run (chunk resume).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { analyzeGameChunk } from "../src/lib/analysis/analyze-game";
import { AnalysisPool } from "../src/lib/analysis/pool";
import { createTablebaseClient } from "../src/lib/analysis/tablebase";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? (args[index + 1] ?? fallback) : fallback;
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const handle = flag("handle", "gate-phase2");
const concurrency = Number(flag("concurrency", "3"));
const depth = Number(flag("depth", "18"));
const tbEnabled = flag("tb", "1") === "1";

const client = postgres(DATABASE_URL, { prepare: false, max: concurrency + 2 });
const db = drizzle(client, { schema }) as unknown as Db;

async function main() {
  const user = await db.query.users.findFirst({
    where: (users, { eq: equals }) => equals(users.handle, handle),
  });
  if (!user) throw new Error(`no user with handle ${handle}`);

  const games = await db
    .select({ id: schema.games.id, variant: schema.games.variant })
    .from(schema.games)
    .where(and(eq(schema.games.userId, user.id), eq(schema.games.isStudy, false)))
    .orderBy(asc(schema.games.importedAt));
  console.log(`${games.length} games for ${handle}; pool=${concurrency}, depth=${depth}, tb=${tbEnabled}`);

  const pool = new AnalysisPool({ cap: concurrency, hashMb: 128 });
  const tb = createTablebaseClient(db, { enabled: tbEnabled });
  const startedAt = Date.now();
  let finished = 0;

  const queue = [...games];
  const worker = async (workerId: number) => {
    for (;;) {
      const game = queue.shift();
      if (!game) return;
      const t0 = Date.now();
      try {
        // Run chunks until the game completes (chunked for resumability).
        for (;;) {
          const result = await analyzeGameChunk(db, game.id, {
            pool,
            tb,
            depth,
            maxPositions: 500,
          });
          if (result.remainingPlies === 0) {
            finished++;
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            const totalMin = ((Date.now() - startedAt) / 60000).toFixed(1);
            console.log(
              `[w${workerId}] game ${game.id.slice(0, 8)} done: ${result.totalPlies} plies in ${elapsed}s ` +
                `(${finished}/${games.length} games, ${totalMin} min total)`
            );
            break;
          }
        }
      } catch (error) {
        console.error(`[w${workerId}] game ${game.id.slice(0, 8)} FAILED: ${(error as Error).message}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => worker(index + 1))
  );
  pool.shutdown();

  // Summary: null counts across the user's plies (the gate's falsifiable).
  const summary = await db.execute(sql`
    select count(*)::int as total,
           count(*) filter (where p.eval_before_cp is null and p.mate_before is null)::int as no_eval,
           count(*) filter (where p.wp_loss is null)::int as no_wploss,
           count(*) filter (where p.classification is null)::int as no_class,
           count(*) filter (where p.time_spent_ms is null)::int as no_time
    from plies p join games g on g.id = p.game_id
    where g.user_id = ${user.id}
  `);
  console.log("summary:", JSON.stringify(summary));
  await client.end();
  process.exit(0);
}

await main();
