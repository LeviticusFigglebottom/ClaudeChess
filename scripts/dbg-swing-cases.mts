/** Dump the material-swing blunder-UNCLEAR survivors with full detection context. */
import postgres from "postgres";
import { GamePosition } from "../src/lib/chess/position";
import { uciSquares, SEE_VALUES } from "../src/lib/motifs/primitives";
import { detectMotifs, type MotifDetectionInput } from "../src/lib/motifs/detect";

const client = postgres(process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit", { prepare: false });

const rows = await client`
  SELECT p.id, p.game_id, p.ply, p.fen_before, p.fen_after, p.san, p.uci, p.pv1 AS best_pv, p.wp_loss
  FROM plies p JOIN games g ON g.id=p.game_id JOIN users u ON u.id=g.user_id
  WHERE u.handle='gate-phase2' AND p.classification::text='BLUNDER'
    AND (SELECT motif FROM blunder_tags bt WHERE bt.ply_id=p.id AND bt.rank=1)::text='UNCLEAR'`;

for (const row of rows) {
  const next = await client`SELECT pv1 FROM plies WHERE game_id=${row.game_id} AND ply=${row.ply + 1}`;
  const refutation = ((next[0]?.pv1 as string[] | null) ?? []).slice(0, 6);
  const replay = GamePosition.fromFen(row.fen_after as string, "standard");
  const moverIsWhite = replay.turn === "b";
  let net = 0;
  for (const uci of refutation) {
    const { to } = uciSquares(uci);
    const victim = replay.pieceAt(`${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`);
    const stepIsMover = (replay.turn === "w") === moverIsWhite;
    let value = 0;
    if (victim) value = SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
    if (!replay.moveUci(uci)) break;
    if (value > 0) net += stepIsMover ? -value : value;
  }
  if (net < 300 || replay.isCheckmate()) continue;
  const input: MotifDetectionInput = {
    variant: "standard",
    fenBefore: row.fen_before as string,
    fenAfter: row.fen_after as string,
    movedUci: row.uci as string,
    movedSan: row.san as string,
    bestPv: (row.best_pv as string[] | null) ?? [],
    refutationPv: refutation,
    wpLoss: Number(row.wp_loss),
    clockMsRemaining: null,
    tbBefore: null, tbBeforeHit: false, tbAfter: null,
    priorForcingRun: false, recentOwnSans: [],
  };
  const dets = detectMotifs(input);
  console.log(`--- ply ${row.ply} loss ${row.wp_loss} moved ${row.san} (${row.uci})`);
  console.log(`  fenBefore: ${row.fen_before}`);
  console.log(`  refutation: ${refutation.join(" ")}  net +${net}`);
  console.log(`  detections: [${dets.map(d => `${d.motif}@${d.confidence}`).join(", ")}]`);
}
await client.end();
process.exit(0);
