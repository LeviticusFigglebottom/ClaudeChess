import { and, eq, gte, inArray } from "drizzle-orm";
import { evalCache, evalCacheGlobal } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import type { IngestLine } from "./ingest";

/**
 * Per-user eval cache (see the schema comment for scope + honesty rules).
 * Only the opening zone is cached — that is where a user's own library
 * actually repeats positions.
 */

export const CACHE_MAX_POSITION = 40;

export function epdOf(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

export interface CachedPosition {
  epd: string;
  depth: number;
  multipv: number;
  lines: IngestLine[];
}

/**
 * Deepest cached row per epd with depth ≥ requested and multipv ≥ requested,
 * from the UNION of the trusted GLOBAL cache (seed + organic server rows —
 * shared by everyone) and the requester's own per-user cache. On equal
 * depth the global row wins (server-computed beats self-computed).
 */
export async function lookupCachedLines(
  db: Db,
  userId: string,
  variant: string,
  epds: string[],
  depth: number,
  multipv: number
): Promise<Map<string, CachedPosition>> {
  if (epds.length === 0) return new Map();
  const wanted = [...new Set(epds)];
  const [own, global] = await Promise.all([
    db
      .select()
      .from(evalCache)
      .where(
        and(
          eq(evalCache.userId, userId),
          eq(evalCache.variant, variant),
          inArray(evalCache.epd, wanted),
          gte(evalCache.depth, depth),
          gte(evalCache.multipv, multipv)
        )
      ),
    db
      .select()
      .from(evalCacheGlobal)
      .where(
        and(
          eq(evalCacheGlobal.variant, variant),
          inArray(evalCacheGlobal.epd, wanted),
          gte(evalCacheGlobal.depth, depth),
          gte(evalCacheGlobal.multipv, multipv)
        )
      ),
  ]);
  const best = new Map<string, CachedPosition>();
  const consider = (row: { epd: string; depth: number; multipv: number; lines: unknown }, prefer: boolean) => {
    const existing = best.get(row.epd);
    if (!existing || row.depth > existing.depth || (prefer && row.depth === existing.depth)) {
      best.set(row.epd, {
        epd: row.epd,
        depth: row.depth,
        multipv: row.multipv,
        lines: row.lines as IngestLine[],
      });
    }
  };
  for (const row of own) consider(row, false);
  for (const row of global) consider(row, true);
  return best;
}

/** Organic growth: server-computed sweep lines join the global cache. */
export async function storeGlobalLines(
  db: Db,
  variant: string,
  entries: CachedPosition[]
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(evalCacheGlobal)
    .values(
      entries.map((entry) => ({
        variant,
        epd: entry.epd,
        depth: entry.depth,
        multipv: entry.multipv,
        lines: entry.lines,
        source: "server",
      }))
    )
    .onConflictDoNothing();
}

/** First write wins per key — identical re-writes are free no-ops. */
export async function storeCachedLines(
  db: Db,
  userId: string,
  variant: string,
  entries: CachedPosition[]
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(evalCache)
    .values(
      entries.map((entry) => ({
        userId,
        variant,
        epd: entry.epd,
        depth: entry.depth,
        multipv: entry.multipv,
        lines: entry.lines,
      }))
    )
    .onConflictDoNothing();
}
