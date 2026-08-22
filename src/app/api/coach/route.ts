import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import { checkUsage, consumeUsage } from "@/lib/account/usage";
import { submitPostmortem } from "@/lib/train";

/**
 * POST /api/coach {plyId, userReasoning} — §9.5 post-mortem verdict, the
 * one REQUIRED LLM use (C0: free-prose input). Server-side only; guard
 * chain per A2.4 (401 → 403 unverified → 429 capped); gated to isCritical
 * plies inside the domain layer; cached by (fen, san, reasoning-hash) so a
 * usage unit is consumed only on real model calls.
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "The coach requires a verified account (A2.1).",
        403
      );
    }
    const body = await readJson(request);
    const plyId = Number(body.plyId);
    const userReasoning = typeof body.userReasoning === "string" ? body.userReasoning : "";
    if (!Number.isInteger(plyId)) throw new AccountError("bad_ply", "plyId required.");

    const decision = await checkUsage(db, user, { kind: "llmCalls", amount: 1 });
    if (!decision.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "usage_capped",
            message: `Monthly llmCalls limit reached (${decision.used}/${decision.cap}).`,
          },
          usage: decision,
        },
        { status: 429 }
      );
    }
    const result = await submitPostmortem(db, user.id, { plyId, userReasoning });
    if (!result.cached) {
      await consumeUsage(db, user, { kind: "llmCalls", amount: 1 });
    }
    return NextResponse.json(result);
  });
}
