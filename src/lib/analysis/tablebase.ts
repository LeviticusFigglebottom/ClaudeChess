import { eq, sql } from "drizzle-orm";
import { tbCache } from "@/db/schema";
import type { Db } from "@/lib/account/types";

/**
 * Syzygy tablebase probe (B0.1): tablebase.lichess.ovh for ≤7-piece standard
 * positions, cached by epd in Postgres. Results write tbWdl/tbDtz/tbHit ONLY
 * — evalAfterCp is never overwritten; classification and win-prob consult
 * the WDL when tbHit. Network failure degrades to tbHit=false silently.
 */

export interface TbResult {
  /** Side-to-move WDL: 2 win, 1 cursed win, 0 draw, −1 blessed loss, −2 loss. */
  wdl: number;
  dtz: number | null;
}

export function pieceCountOfFen(fen: string): number {
  const board = fen.split(" ")[0] ?? "";
  return (board.match(/[pnbrqkPNBRQK]/g) ?? []).length;
}

const CATEGORY_WDL: Record<string, number> = {
  win: 2,
  "maybe-win": 2,
  "cursed-win": 1,
  draw: 0,
  "blessed-loss": -1,
  "maybe-loss": -2,
  loss: -2,
};

function epdOf(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

let lastProbeAt = 0;
const PROBE_GAP_MS = 120;

async function throttledFetch(url: string, fetchFn: typeof fetch): Promise<Response> {
  const wait = lastProbeAt + PROBE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastProbeAt = Date.now();
  return fetchFn(url, { headers: { Accept: "application/json" } });
}

export interface TablebaseClient {
  probe(fen: string): Promise<TbResult | null>;
}

/** DB-cached network probe. `enabled: false` (tests) makes every probe miss. */
export function createTablebaseClient(
  db: Db,
  opts: { enabled?: boolean; fetchFn?: typeof fetch } = {}
): TablebaseClient {
  const enabled = opts.enabled ?? true;
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async probe(fen: string): Promise<TbResult | null> {
      if (!enabled) return null;
      if (pieceCountOfFen(fen) > 7) return null;
      const key = epdOf(fen);
      const cached = (await db.select().from(tbCache).where(eq(tbCache.fenKey, key)))[0];
      if (cached) {
        return cached.wdl === null ? null : { wdl: cached.wdl, dtz: cached.dtz };
      }
      try {
        const response = await throttledFetch(
          `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen.replaceAll(" ", "_"))}`,
          fetchFn
        );
        if (!response.ok) return null;
        const body = (await response.json()) as { category?: string; dtz?: number | null };
        const wdl = body.category !== undefined ? CATEGORY_WDL[body.category] : undefined;
        const result: TbResult | null =
          wdl === undefined ? null : { wdl, dtz: body.dtz ?? null };
        await db
          .insert(tbCache)
          .values({ fenKey: key, wdl: result?.wdl ?? null, dtz: result?.dtz ?? null })
          .onConflictDoUpdate({
            target: tbCache.fenKey,
            set: {
              wdl: result?.wdl ?? null,
              dtz: result?.dtz ?? null,
              probedAt: sql`now()`,
            },
          });
        return result;
      } catch {
        return null; // network failure — analysis proceeds without tb truth
      }
    },
  };
}

/** Mover-POV win probability implied by a side-to-move WDL. */
export function wpFromWdl(wdlSideToMove: number): number {
  if (wdlSideToMove >= 2) return 100;
  if (wdlSideToMove <= -2) return 0;
  return 50; // draws, cursed wins and blessed losses are draws under best play
}
