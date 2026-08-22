import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { explorerCache } from "@/db/schema";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { isValidFen } from "@/lib/chess/position";

/**
 * GET /api/explorer — Lichess opening-explorer proxy with a 24h Postgres
 * cache (Phase 3 gate: p95 < 300ms warm; a warm hit is one indexed read).
 * The upstream is queried politely and results are shared across users —
 * explorer data is user-independent per (position, speeds, ratings).
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_SPEEDS = new Set(["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"]);
const ALLOWED_RATINGS = new Set(["400", "1000", "1200", "1400", "1600", "1800", "2000", "2200", "2500"]);

export async function GET(request: Request) {
  return handleApi(async () => {
    if (!accountsConfigured()) {
      throw new AccountError("accounts_disabled", "Explorer needs the database cache.", 503);
    }
    const url = new URL(request.url);
    const fen = url.searchParams.get("fen") ?? "";
    if (!isValidFen(fen, "standard")) {
      throw new AccountError("bad_fen", "Explorer requires a valid standard-chess FEN.");
    }
    const speeds = (url.searchParams.get("speeds") ?? "blitz,rapid,classical")
      .split(",")
      .filter((speed) => ALLOWED_SPEEDS.has(speed));
    const ratingBands = (url.searchParams.get("ratings") ?? "1400,1600,1800")
      .split(",")
      .filter((band) => ALLOWED_RATINGS.has(band));
    if (speeds.length === 0 || ratingBands.length === 0) {
      throw new AccountError("bad_params", "Bad speeds/ratings filter.");
    }

    const epd = fen.split(" ").slice(0, 4).join(" ");
    const key = `lichess:${epd}:${speeds.join("+")}:${ratingBands.join("+")}`;
    const db = getDb();
    const cached = (await db.select().from(explorerCache).where(eq(explorerCache.key, key)))[0];
    if (cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
      return NextResponse.json({ ...cached.payload, cached: true });
    }

    const upstream = new URL("https://explorer.lichess.ovh/lichess");
    upstream.searchParams.set("variant", "standard");
    upstream.searchParams.set("fen", fen);
    upstream.searchParams.set("speeds", speeds.join(","));
    upstream.searchParams.set("ratings", ratingBands.join(","));
    upstream.searchParams.set("moves", "12");
    upstream.searchParams.set("topGames", "0");
    upstream.searchParams.set("recentGames", "0");
    const response = await fetch(upstream, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      // Serve a stale cache entry over failing outright.
      if (cached) return NextResponse.json({ ...cached.payload, cached: "stale" });
      throw new AccountError("explorer_upstream", `Explorer upstream HTTP ${response.status}.`, 502);
    }
    const body = (await response.json()) as {
      white: number;
      draws: number;
      black: number;
      moves: { uci: string; san: string; white: number; draws: number; black: number; averageRating?: number }[];
      opening?: { eco: string; name: string } | null;
    };
    const payload = {
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
      .values({ key, payload })
      .onConflictDoUpdate({
        target: explorerCache.key,
        set: { payload, fetchedAt: new Date() },
      });
    return NextResponse.json({ ...payload, cached: false });
  });
}
