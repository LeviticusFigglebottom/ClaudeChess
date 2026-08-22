import { eq } from "drizzle-orm";
import { explorerCache } from "@/db/schema";
import type { Db } from "@/lib/account/types";

/**
 * Cached Lichess opening-explorer client (Phase 3; shared by the explorer
 * panel, §9.1's empirical calibration score, and §9.4's EV tree). 24h
 * Postgres cache keyed by (epd, speeds, ratings) — explorer data is
 * user-independent, so hits are shared across users. Standard chess only
 * (A3.4); stale cache beats a failing upstream.
 */

export interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
}

export interface ExplorerPosition {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  opening: { eco: string; name: string } | null;
}

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Upstream base. Overridable because some egress networks are refused by
 * explorer.lichess.ovh (nginx 401 — observed while tablebase.lichess.ovh
 * answers 200); gates run against a local stand-in via EXPLORER_BASE_URL
 * while production talks to the real service.
 */
const EXPLORER_BASE = process.env.EXPLORER_BASE_URL ?? "https://explorer.lichess.ovh";
export const EXPLORER_SPEEDS = [
  "ultraBullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
] as const;
export const EXPLORER_RATINGS = [
  "400",
  "1000",
  "1200",
  "1400",
  "1600",
  "1800",
  "2000",
  "2200",
  "2500",
] as const;

/** Nearest explorer rating bands around a Glicko-style rating. */
export function bandsForRating(rating: number): string[] {
  const numeric = EXPLORER_RATINGS.map(Number);
  let closest = 0;
  for (const [index, band] of numeric.entries()) {
    if (Math.abs(band - rating) < Math.abs(numeric[closest]! - rating)) closest = index;
  }
  const picks = new Set<number>([closest]);
  if (closest > 0) picks.add(closest - 1);
  if (closest < numeric.length - 1) picks.add(closest + 1);
  return [...picks].sort((a, b) => a - b).map((index) => EXPLORER_RATINGS[index]!);
}

export async function fetchExplorerPosition(
  db: Db,
  fen: string,
  opts: { speeds: string[]; ratings: string[] }
): Promise<{ position: ExplorerPosition; cached: boolean | "stale" }> {
  const epd = fen.split(" ").slice(0, 4).join(" ");
  const key = `lichess:${epd}:${opts.speeds.join("+")}:${opts.ratings.join("+")}`;
  const cached = (await db.select().from(explorerCache).where(eq(explorerCache.key, key)))[0];
  if (cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
    return { position: cached.payload as unknown as ExplorerPosition, cached: true };
  }

  const upstream = new URL(`${EXPLORER_BASE}/lichess`);
  upstream.searchParams.set("variant", "standard");
  upstream.searchParams.set("fen", fen);
  upstream.searchParams.set("speeds", opts.speeds.join(","));
  upstream.searchParams.set("ratings", opts.ratings.join(","));
  upstream.searchParams.set("moves", "12");
  upstream.searchParams.set("topGames", "0");
  upstream.searchParams.set("recentGames", "0");
  const response = await fetch(upstream, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    if (cached) {
      return { position: cached.payload as unknown as ExplorerPosition, cached: "stale" };
    }
    throw new Error(`explorer upstream HTTP ${response.status}`);
  }
  const body = (await response.json()) as ExplorerPosition & {
    moves: (ExplorerMove & { averageRating?: number })[];
  };
  const position: ExplorerPosition = {
    white: body.white,
    draws: body.draws,
    black: body.black,
    moves: (body.moves ?? []).slice(0, 12).map((move) => ({
      uci: move.uci,
      san: move.san,
      white: move.white,
      draws: move.draws,
      black: move.black,
      averageRating: move.averageRating ?? null,
    })),
    opening: body.opening ?? null,
  };
  await db
    .insert(explorerCache)
    .values({ key, payload: position as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: explorerCache.key, set: { payload: position as unknown as Record<string, unknown>, fetchedAt: new Date() } });
  return { position, cached: false };
}

/** White-POV empirical score (0..100) of a position sample; null when thin. */
export function empiricalWhiteWp(position: ExplorerPosition, minGames = 200): number | null {
  const total = position.white + position.draws + position.black;
  if (total < minGames) return null;
  return ((position.white + position.draws / 2) / total) * 100;
}
