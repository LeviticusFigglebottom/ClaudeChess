/**
 * For every blunder-UNCLEAR ply: net material swing across the stored
 * refutation (6 plies), whether one of the mover's pieces standing attacked
 * in posAfter is captured anywhere in it, and whether the refutation mates —
 * sizes the recoverable share for detector-widening before any code moves.
 *
 * Also characterizes the BEST-MOVE side for the quiet survivors: when
 * bestPv nets ≥300 material (or mates), the error was a MISSED tactic —
 * the punishment is the forgone win, not the refutation, so no
 * refutation-driven vocabulary (tactical or structural) can name it.
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
    SELECT p.id, p.game_id, p.ply, p.fen_before, p.fen_after, p.uci, p.pv1 AS best_pv, p.wp_loss
    FROM plies p JOIN games g ON g.id=p.game_id JOIN users u ON u.id=g.user_id
    WHERE u.handle='gate-phase2' AND p.classification::text='BLUNDER'
      AND (SELECT motif FROM blunder_tags bt WHERE bt.ply_id=p.id AND bt.rank=1)::text='UNCLEAR'`;
  let swingBig = 0;
  let attackedPieceFalls = 0;
  let mates = 0;
  let quiet = 0;
  let quietMissedTactic = 0; // quiet refutation, but bestPv cashes ≥300 or mates
  for (const row of rows) {
    const next = await client`
      SELECT pv1 FROM plies WHERE game_id=${row.game_id} AND ply=${row.ply + 1}`;
    const refutation = ((next[0]?.pv1 as string[] | null) ?? []).slice(0, 6);
    const after = posFromFen(row.fen_after as string);
    const mover = after.turn === "white" ? "black" : "white"; // fenAfter turn = opponent
    const replay = GamePosition.fromFen(row.fen_after as string, "standard");
    // Net includes the mover's own capture on the blunder move itself —
    // otherwise "captured a knight, got recaptured" counts as a 300 swing.
    let net = 0; // positive = opponent gains
    {
      const beforePos = GamePosition.fromFen(row.fen_before as string, "standard");
      const { to } = uciSquares(row.uci as string);
      const victim = beforePos.pieceAt(`${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`);
      if (victim) net -= SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
    }
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
    } else {
      quiet++;
      // Best-move side: replay bestPv from fenBefore — mover's POV this time.
      const bestPv = ((row.best_pv as string[] | null) ?? []).slice(0, 6);
      const bestReplay = GamePosition.fromFen(row.fen_before as string, "standard");
      const moverIsWhite = bestReplay.turn === "w";
      let bestNet = 0; // positive = mover gains
      for (const uci of bestPv) {
        const { to } = uciSquares(uci);
        const victim = bestReplay.pieceAt(
          `${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`
        );
        const stepIsMover = (bestReplay.turn === "w") === moverIsWhite;
        let value = 0;
        if (victim) value = SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
        if (!bestReplay.moveUci(uci)) break;
        if (value > 0) bestNet += stepIsMover ? value : -value;
      }
      if (bestNet >= 300 || bestReplay.isCheckmate()) quietMissedTactic++;
    }
  }
  console.log(`blunder-UNCLEAR: ${rows.length}`);
  console.log(`  refutation mates:                       ${mates}`);
  console.log(`  net material ≥ 300 within 6 plies:      ${swingBig} (of which attacked-piece-falls: ${attackedPieceFalls})`);
  console.log(`  quiet refutations (positional):         ${quiet}`);
  console.log(`    of which bestPv cashes ≥300 or mates: ${quietMissedTactic} (missed tactic — punishment is the forgone win)`);
  await client.end();
  process.exit(0);
}

await main();
