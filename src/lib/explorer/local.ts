import { and, eq, inArray } from "drizzle-orm";
import { explorerAgg } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { GamePosition } from "@/lib/chess/position";
import { openingForEpd } from "@/lib/chess/openings";
import type { ExplorerMove, ExplorerPosition } from "./index";

/**
 * §9.4's LOCAL explorer source (Task 2b): the self-hosted aggregate,
 * seeded from a Lichess monthly dump — no external dependency. Sums rows
 * across the requested bands/speeds exactly as the live API would, so the
 * two sources are interchangeable; SANs are derived through the facade.
 * Returns null when the aggregate has nothing for this position (past the
 * pruned book) — the caller may then consult the live explorer as
 * enrichment, never as a requirement.
 */
export async function fetchAggregatePosition(
  db: Db,
  fen: string,
  opts: { speeds: string[]; ratings: string[] }
): Promise<ExplorerPosition | null> {
  const epd = fen.split(" ").slice(0, 4).join(" ");
  const rows = await db
    .select()
    .from(explorerAgg)
    .where(
      and(
        eq(explorerAgg.epd, epd),
        inArray(explorerAgg.ratingBand, opts.ratings),
        inArray(explorerAgg.speed, opts.speeds)
      )
    );
  if (rows.length === 0) return null;

  const byMove = new Map<string, { white: number; draws: number; black: number }>();
  for (const row of rows) {
    const entry = byMove.get(row.moveUci) ?? { white: 0, draws: 0, black: 0 };
    entry.white += row.white;
    entry.draws += row.draws;
    entry.black += row.black;
    byMove.set(row.moveUci, entry);
  }
  let position: GamePosition | null = null;
  try {
    position = GamePosition.fromFen(fen, "standard");
  } catch {
    return null;
  }
  const moves: ExplorerMove[] = [];
  for (const [uci, counts] of byMove) {
    const san = position.moveUci(uci)?.san ?? null;
    // Re-derive from the same position for the next move.
    position = GamePosition.fromFen(fen, "standard");
    if (!san) continue;
    moves.push({ uci, san, white: counts.white, draws: counts.draws, black: counts.black, averageRating: null });
  }
  moves.sort((a, b) => b.white + b.draws + b.black - (a.white + a.draws + a.black));
  const totals = moves.reduce(
    (acc, move) => ({
      white: acc.white + move.white,
      draws: acc.draws + move.draws,
      black: acc.black + move.black,
    }),
    { white: 0, draws: 0, black: 0 }
  );
  return {
    ...totals,
    moves: moves.slice(0, 12),
    opening: openingForEpd(epd) ?? null,
  };
}
