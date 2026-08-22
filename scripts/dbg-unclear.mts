/**
 * What ARE the UNCLEAR error plies? Prints position, played move, best
 * move, and the refutation line (next ply's stored pv1) in SAN for a
 * sample, so detector gaps can be identified by inspection.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { GamePosition } from "../src/lib/chess/position";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

function sanLine(fen: string, ucis: string[], max = 5): string {
  try {
    const position = GamePosition.fromFen(fen, "standard");
    const sans: string[] = [];
    for (const uci of ucis.slice(0, max)) {
      const move = position.moveUci(uci);
      if (!move) break;
      sans.push(move.san);
    }
    return sans.join(" ");
  } catch {
    return "?";
  }
}

async function main() {
  const rows = await client`
    SELECT p.id, p.game_id, p.ply, p.fen_before, p.fen_after, p.san, p.uci,
           p.best_move_uci, p.wp_loss, p.classification, p.pv1
    FROM plies p
    JOIN games g ON g.id = p.game_id
    JOIN users u ON u.id = g.user_id
    JOIN blunder_tags bt ON bt.ply_id = p.id AND bt.rank = 1 AND bt.motif = 'UNCLEAR'
    WHERE u.handle = 'gate-phase2'
    ORDER BY random() LIMIT 18`;
  for (const row of rows) {
    const next = await client`
      SELECT pv1 FROM plies WHERE game_id = ${row.game_id} AND ply = ${row.ply + 1}`;
    const refutation = (next[0]?.pv1 as string[] | null) ?? [];
    console.log(`— ply ${row.ply} ${row.classification} loss=${Number(row.wp_loss).toFixed(1)}`);
    console.log(`  fen    ${row.fen_before}`);
    console.log(`  played ${row.san}   best ${sanLine(row.fen_before, [row.best_move_uci])}`);
    console.log(`  best line: ${sanLine(row.fen_before, (row.pv1 as string[]) ?? [], 6)}`);
    console.log(`  refutation after played: ${sanLine(row.fen_after, refutation, 6)}`);
  }
  await client.end();
  process.exit(0);
}

await main();
