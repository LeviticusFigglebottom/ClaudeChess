import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { isVariantId } from "@/lib/chess/variant";
import {
  calibrationReport,
  nextCalibrationPosition,
  recordCalibrationAttempt,
} from "@/lib/train";

/** §9.1 — GET next position / ?report=1; POST records a prediction. */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const variantParam = url.searchParams.get("variant") ?? "standard";
    const variant = isVariantId(variantParam) ? variantParam : "standard";
    if (url.searchParams.get("report")) {
      return NextResponse.json({ report: await calibrationReport(db, user.id, variant) });
    }
    const position = await nextCalibrationPosition(db, user.id, variant);
    return NextResponse.json({ position });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const plyId = Number(body.plyId);
    const predictedWp = Number(body.predictedWp);
    if (!Number.isInteger(plyId)) throw new AccountError("bad_ply", "plyId required.");
    const reveal = await recordCalibrationAttempt(db, user.id, { plyId, predictedWp });
    return NextResponse.json({ reveal });
  });
}
