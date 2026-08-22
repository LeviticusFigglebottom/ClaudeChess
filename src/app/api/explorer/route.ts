import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { isValidFen } from "@/lib/chess/position";
import { EXPLORER_RATINGS, EXPLORER_SPEEDS, fetchExplorerPosition } from "@/lib/explorer";

/**
 * GET /api/explorer — Lichess opening-explorer proxy with a 24h Postgres
 * cache (Phase 3 gate: p95 < 300ms warm; a warm hit is one indexed read).
 * The upstream is queried politely and results are shared across users —
 * explorer data is user-independent per (position, speeds, ratings).
 */

const ALLOWED_SPEEDS = new Set<string>(EXPLORER_SPEEDS);
const ALLOWED_RATINGS = new Set<string>(EXPLORER_RATINGS);

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
    try {
      const { position, cached } = await fetchExplorerPosition(getDb(), fen, {
        speeds,
        ratings: ratingBands,
      });
      return NextResponse.json({ ...position, cached });
    } catch (error) {
      throw new AccountError(
        "explorer_upstream",
        error instanceof Error ? error.message : "Explorer upstream failed.",
        502
      );
    }
  });
}
