/**
 * Re-run motif detection (idempotent) over a user's analyzed games with the
 * CURRENT detectors — the backfill path after detector changes.
 *
 *   npx tsx scripts/rerun-motifs.mts [--handle gate-phase2]
 */
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { detectAndStoreMotifs } from "../src/lib/motifs/apply";

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
    .select({ id: schema.games.id })
    .from(schema.games)
    .where(eq(schema.games.userId, user.id))
    .orderBy(asc(schema.games.importedAt));
  let done = 0;
  for (const game of games) {
    await detectAndStoreMotifs(db, game.id);
    process.stderr.write(`\r${++done}/${games.length}`);
  }
  process.stderr.write("\n");
  await client.end();
  process.exit(0);
}

await main();
