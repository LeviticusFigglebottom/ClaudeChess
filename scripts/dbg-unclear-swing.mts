/**
 * For every blunder-UNCLEAR ply: net material swing across the stored
 * refutation (6 plies), whether one of the mover's pieces standing attacked
 * in posAfter is captured anywhere in it, and whether the refutation mates —
 * sizes the recoverable share for detector-widening before any code moves.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { GamePosition } from "../src/lib/chess/position";
import { posFromFen, attackersOf, SEE_VALUES, uciSquares } from "../src/lib/motifs/primitives";
import { opposite } from "chessops/util";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const client = postgres(DATABASE_URL, { prepare: false });
drizzle(client, { schema });

async function main() {
  const rows = await client`
    SELECT p.id, p.game_id, p.ply, p.fen_after, p.wp_loss
    FROM plies p JOIN games g ON g.id=p.game_id JOIN users u ON u.id=g.user_id
    WHERE u.handle='gate-phase2' AND p.classification::text='BLUNDER'
      AND (SELECT motif FROM blunder_tags bt WHERE bt.ply_id=p.id AND bt.rank=1)::text='UNCLEAR'`;
  let swingBig = 0;
  let attackedPieceFalls = 0;
  let mates = 0;
  let quiet = 0;
  for (const row of rows) {
    const next = await client`
      SELECT pv1 FROM plies WHERE game_id=${row.game_id} AND ply=${row.ply + 1}`;
    const refutation = ((next[0]?.pv1 as string[] | null) ?? []).slice(0, 6);
    const after = posFromFen(row.fen_after as string);
    const mover = after.turn === "white" ? "black" : "white"; // fenAfter turn = opponent
    const replay = GamePosition.fromFen(row.fen_after as string, "standard");
    let net = 0; // positive = opponent gains
    let fell = false;
    for (const uci of refutation) {
      const { to } = uciSquares(uci);
      const victim = replay.pieceAt(
        `${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`
      );
      const stepMoverWhite = replay.turn === "w";
      const stepMover = stepMoverWhite ? "white" : "black";
      let value = 0;
      if (victim) value = SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
      if (!replay.moveUci(uci)) break;
      if (value > 0) {
        if (stepMover === mover) net -= value;
        else {
          net += value;
          // Was the captured piece standing attacked already in posAfter?
          const before = after.board.get(to);
          if (
            before &&
            before.color === mover &&
            value >= 300 &&
            attackersOf(after.board, to, opposite(mover)).nonEmpty()
          ) {
            fell = true;
          }
        }
      }
    }
    if (replay.isCheckmate()) mates++;
    else if (net >= 300) {
      swingBig++;
      if (fell) attackedPieceFalls++;
    } else quiet++;
  }
  console.log(`blunder-UNCLEAR: ${rows.length}`);
  console.log(`  refutation mates:                       ${mates}`);
  console.log(`  net material ≥ 300 within 6 plies:      ${swingBig} (of which attacked-piece-falls: ${attackedPieceFalls})`);
  console.log(`  quiet refutations (positional):         ${quiet}`);
  await client.end();
  process.exit(0);
}

await main();
