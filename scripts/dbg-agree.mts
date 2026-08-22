/**
 * Per-ply divergence investigation for the Phase 2 agreement gate: for the
 * given games, print every ply where our folded judgment (?!/?/?? from
 * classification + MISS loss-fold) differs from Lichess's NAG, alongside
 * both engines' evals — separates threshold disagreement from eval
 * disagreement.
 *
 *   npx tsx scripts/dbg-agree.mts lui2jTCm rmwJLV3U b4dyuTvM
 */
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { parseMultiPgn } from "../src/lib/chess/pgn-read";
import { LOSS_THRESHOLDS } from "../src/lib/eval/classify";

const externalIds = process.argv.slice(2);
if (!externalIds.length) throw new Error("pass lichess game ids");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

function ourNag(cls: string | null, loss: number): number | null {
  if (cls === "BLUNDER") return 4;
  if (cls === "MISTAKE") return 2;
  if (cls === "INACCURACY") return 6;
  if (cls === "MISS") {
    if (loss >= LOSS_THRESHOLDS.mistake) return 4;
    if (loss >= LOSS_THRESHOLDS.inaccuracy) return 2;
    if (loss >= LOSS_THRESHOLDS.good) return 6;
  }
  return null;
}

async function main() {
  for (const externalId of externalIds) {
    const game = await db.query.games.findFirst({
      where: (games, { eq: equals }) => equals(games.externalId, externalId),
    });
    if (!game) {
      console.log(`${externalId}: not found`);
      continue;
    }
    const plies = await db
      .select()
      .from(schema.plies)
      .where(eq(schema.plies.gameId, game.id))
      .orderBy(asc(schema.plies.ply));
    const raw = parseMultiPgn(game.pgn)[0]!;
    console.log(`\n=== ${externalId} (${plies.length} plies) ===`);
    console.log(
      `ply  move        ourClass    loss   lichessNAG  their[%eval] before→after   ours(cp/mate before→after, white-POV)`
    );
    raw.moves.forEach((move, index) => {
      const ply = plies[index];
      if (!ply) return;
      const judged = move.nags.find((nag) => [2, 4, 6].includes(nag)) ?? null;
      const mine = ourNag(ply.classification, ply.wpLoss ?? 0);
      if (judged === mine) return;
      const prev = index > 0 ? raw.moves[index - 1] : undefined;
      const theirBefore =
        prev == null ? "start" : prev.evalCp !== null ? prev.evalCp : prev.evalMate !== null ? `#${prev.evalMate}` : "?";
      const theirAfter =
        move.evalCp !== null ? move.evalCp : move.evalMate !== null ? `#${move.evalMate}` : "?";
      const oursBefore = ply.mateBefore !== null ? `#${ply.mateBefore}` : ply.evalBeforeCp;
      const oursAfter = ply.mateAfter !== null ? `#${ply.mateAfter}` : ply.evalAfterCp;
      console.log(
        `${String(ply.ply).padStart(3)}  ${move.san.padEnd(10)} ${(ply.classification ?? "-").padEnd(11)} ${String(ply.wpLoss?.toFixed(1) ?? "-").padStart(5)}  ${String(judged ?? "-").padStart(4)}→ours ${String(mine ?? "-").padEnd(4)} ${String(theirBefore).padStart(6)}→${String(theirAfter).padEnd(7)} ${String(oursBefore).padStart(6)}→${String(oursAfter)}`
      );
    });
  }
  await client.end();
  process.exit(0);
}

await main();
