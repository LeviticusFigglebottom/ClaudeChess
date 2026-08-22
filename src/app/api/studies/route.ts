import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { games } from "@/db/schema";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { GameTree } from "@/lib/chess/tree";
import { isVariantId } from "@/lib/chess/variant";

/**
 * Studies (A3.1): free-form analysis saved from the analysis board. Stored
 * as games rows with isStudy=true and the RAV PGN as the payload — a study
 * never creates plies rows, so variations structurally cannot feed §9
 * statistics (plies is the canonical mainline record).
 */

export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const rows = await db
      .select({
        id: games.id,
        name: games.whiteName,
        variant: games.variant,
        importedAt: games.importedAt,
      })
      .from(games)
      .where(and(eq(games.userId, user.id), eq(games.isStudy, true)))
      .orderBy(desc(games.importedAt))
      .limit(100);
    return NextResponse.json({ studies: rows });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) throw new AccountError("bad_name", "Studies need a name.");
    if (typeof body.pgn !== "string" || body.pgn.length > 200_000) {
      throw new AccountError("bad_pgn", "Study PGN missing or too large.");
    }
    const variant =
      typeof body.variant === "string" && isVariantId(body.variant) ? body.variant : "standard";
    // Validate the PGN round-trips as a tree before storing.
    const tree = GameTree.fromPgn(body.pgn, variant);

    if (typeof body.id === "string") {
      const updated = await db
        .update(games)
        .set({ whiteName: name, pgn: body.pgn, startFen: tree.startFen })
        .where(and(eq(games.id, body.id), eq(games.userId, user.id), eq(games.isStudy, true)))
        .returning({ id: games.id });
      if (!updated[0]) throw new AccountError("study_missing", "No such study.", 404);
      return NextResponse.json({ id: updated[0].id });
    }
    const inserted = await db
      .insert(games)
      .values({
        userId: user.id,
        variant,
        startFen: tree.startFen,
        source: "local",
        pgn: body.pgn,
        whiteName: name,
        blackName: "(study)",
        userColor: "white",
        result: "*",
        isStudy: true,
      })
      .returning({ id: games.id });
    return NextResponse.json({ id: inserted[0]!.id });
  });
}

export async function DELETE(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    if (typeof body.id !== "string") throw new AccountError("bad_action", "id required.");
    const deleted = await db
      .delete(games)
      .where(and(eq(games.id, body.id), eq(games.userId, user.id), eq(games.isStudy, true)))
      .returning({ id: games.id });
    if (!deleted[0]) throw new AccountError("study_missing", "No such study.", 404);
    return NextResponse.json({ ok: true });
  });
}
