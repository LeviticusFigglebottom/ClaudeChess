/**
 * Loss histogram of plies where Lichess judged ?? / ? but our fold differs
 * (and the reverse) — quantifies how much of the agreement-gate residual is
 * borderline threshold noise vs structural disagreement.
 */
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { parseMultiPgn } from "../src/lib/chess/pgn-read";
import { LOSS_THRESHOLDS } from "../src/lib/eval/classify";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

function foldBlunder(cls: string | null, loss: number): boolean {
  return cls === "BLUNDER" || (cls === "MISS" && loss >= LOSS_THRESHOLDS.mistake);
}

async function main() {
  const user = await db.query.users.findFirst({
    where: (users, { eq: equals }) => equals(users.handle, "gate-phase2"),
  });
  const games = await db.select().from(schema.games).where(eq(schema.games.userId, user!.id));
  const buckets = new Map<string, number>();
  let theirBlunderNotOurs = 0;
  let oursNotTheirs = 0;
  for (const game of games) {
    const raw = parseMultiPgn(game.pgn)[0]!;
    const plies = await db
      .select()
      .from(schema.plies)
      .where(eq(schema.plies.gameId, game.id))
      .orderBy(asc(schema.plies.ply));
    raw.moves.forEach((move, index) => {
      const ply = plies[index];
      if (!ply) return;
      const loss = ply.wpLoss ?? 0;
      const ours = foldBlunder(ply.classification, loss);
      const theirs = move.nags.includes(4);
      if (theirs && !ours) {
        theirBlunderNotOurs++;
        const bucket =
          loss >= 12 ? "loss 12–15 (borderline)" : loss >= 8 ? "loss 8–12" : loss >= 4 ? "loss 4–8" : "loss < 4";
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      } else if (ours && !theirs) {
        oursNotTheirs++;
      }
    });
  }
  console.log(`Lichess ?? but not our blunder-fold: ${theirBlunderNotOurs}`);
  for (const [bucket, count] of [...buckets.entries()].sort()) console.log(`  ${bucket}: ${count}`);
  console.log(`our blunder-fold but not Lichess ??: ${oursNotTheirs}`);
  await client.end();
  process.exit(0);
}

await main();
