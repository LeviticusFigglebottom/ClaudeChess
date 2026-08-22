import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { isVariantId } from "@/lib/chess/variant";
import { fingerprintReport, listErrorPlies } from "@/lib/train";

/** §9.2 presentation layer — distribution, trend, drill deck, error list. */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const variantParam = url.searchParams.get("variant") ?? "standard";
    const variant = isVariantId(variantParam) ? variantParam : "standard";
    if (url.searchParams.get("list")) {
      const motif = url.searchParams.get("motif") ?? undefined;
      return NextResponse.json({
        errors: await listErrorPlies(db, user.id, variant, motif),
      });
    }
    return NextResponse.json({ report: await fingerprintReport(db, user.id, variant) });
  });
}
