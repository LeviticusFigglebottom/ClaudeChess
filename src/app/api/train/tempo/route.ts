import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { isVariantId } from "@/lib/chess/variant";
import {
  nextRecognitionPosition,
  recordRecognitionAttempt,
  tempoReport,
} from "@/lib/train";

/** §9.3 — GET report / ?recognition=1 next round; POST records a call. */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const variantParam = url.searchParams.get("variant") ?? "standard";
    const variant = isVariantId(variantParam) ? variantParam : "standard";
    if (url.searchParams.get("recognition")) {
      return NextResponse.json({ position: await nextRecognitionPosition(db, user.id, variant) });
    }
    return NextResponse.json({ report: await tempoReport(db, user.id, variant) });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const plyId = Number(body.plyId);
    if (!Number.isInteger(plyId)) throw new AccountError("bad_ply", "plyId required.");
    const result = await recordRecognitionAttempt(db, user.id, {
      plyId,
      guessedCritical: Boolean(body.guessedCritical),
      answeredInMs: Number(body.answeredInMs) || 0,
    });
    return NextResponse.json(result);
  });
}
