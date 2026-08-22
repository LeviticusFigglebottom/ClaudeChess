import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import { ingestPositionEvals, type IngestPosition } from "@/lib/analysis/ingest";
import { createTablebaseClient } from "@/lib/analysis/tablebase";

/**
 * Client-side batch analysis ingest: the browser engine does the searching,
 * this route derives and stores the record (POV, wp, classification, verify
 * semantics — same code as the server-search path). No engine spawns here
 * and no usage is consumed: client-side engine compute is deliberately
 * unmetered (A2.4); the DB writes are bounded by the caller's own games.
 * Verified account required — parity with /api/analyze.
 */

export const maxDuration = 60;

const MAX_POSITIONS_PER_CALL = 24;

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "Storing batch analysis requires a verified account (A2.1).",
        403
      );
    }
    const body = await readJson(request);
    if (typeof body.gameId !== "string" || !Array.isArray(body.positions)) {
      throw new AccountError("bad_action", "gameId and positions[] required.");
    }
    if (body.positions.length === 0 || body.positions.length > MAX_POSITIONS_PER_CALL) {
      throw new AccountError(
        "bad_action",
        `positions must contain 1–${MAX_POSITIONS_PER_CALL} entries.`
      );
    }
    try {
      const result = await ingestPositionEvals(
        db,
        body.gameId,
        user.id,
        createTablebaseClient(db),
        body.positions as IngestPosition[]
      );
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "game_missing") {
        throw new AccountError("game_missing", "No such game.", 404);
      }
      throw error;
    }
  });
}
