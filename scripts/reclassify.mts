/**
 * Re-derive loss-band classifications from stored wpLoss after the §4.2
 * threshold correction (10/20/30 → 5/10/15; see LOSS_THRESHOLDS in
 * src/lib/eval/classify.ts). Only plies currently in a loss-band class are
 * touched — BOOK/BEST/BRILLIANT/GREAT/MISS are decided before the bands in
 * classifyMove and are threshold-independent, so their stored values stand.
 *
 *   DATABASE_URL=... npx tsx scripts/reclassify.mts [--handle gate-phase2]
 */
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { LOSS_THRESHOLDS, type Classification } from "../src/lib/eval/classify";

const args = process.argv.slice(2);
const handle = args.includes("--handle") ? args[args.indexOf("--handle") + 1]! : "gate-phase2";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

const BAND_CLASSES: Classification[] = ["EXCELLENT", "GOOD", "INACCURACY", "MISTAKE", "BLUNDER"];

function bandFor(loss: number): Classification {
  if (loss < LOSS_THRESHOLDS.excellent) return "EXCELLENT";
  if (loss < LOSS_THRESHOLDS.good) return "GOOD";
  if (loss < LOSS_THRESHOLDS.inaccuracy) return "INACCURACY";
  if (loss < LOSS_THRESHOLDS.mistake) return "MISTAKE";
  return "BLUNDER";
}

async function main() {
  const user = await db.query.users.findFirst({
    where: (users, { eq: equals }) => equals(users.handle, handle),
  });
  if (!user) throw new Error(`no user ${handle}`);
  const games = await db
    .select({ id: schema.games.id })
    .from(schema.games)
    .where(eq(schema.games.userId, user.id));
  const plies = await db
    .select({
      id: schema.plies.id,
      wpLoss: schema.plies.wpLoss,
      classification: schema.plies.classification,
    })
    .from(schema.plies)
    .where(
      inArray(
        schema.plies.gameId,
        games.map((game) => game.id)
      )
    );

  const moves = new Map<Classification, number>();
  let changed = 0;
  for (const ply of plies) {
    const current = ply.classification as Classification | null;
    if (current === null || !BAND_CLASSES.includes(current)) continue;
    if (ply.wpLoss === null) continue;
    const next = bandFor(ply.wpLoss);
    if (next === current) continue;
    await db
      .update(schema.plies)
      .set({ classification: next })
      .where(eq(schema.plies.id, ply.id));
    changed++;
    moves.set(next, (moves.get(next) ?? 0) + 1);
  }
  console.log(`${plies.length} plies scanned, ${changed} reclassified`);
  for (const [cls, count] of [...moves.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  → ${cls}: ${count}`);
  }
  await client.end();
  process.exit(0);
}

await main();
