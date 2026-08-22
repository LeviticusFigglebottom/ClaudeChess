import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import { checkUsage, consumeUsage } from "@/lib/account/usage";
import { llmAvailable } from "@/lib/llm/client";
import { explainBlunder } from "@/lib/train";

/**
 * POST /api/classify-blunder {plyId} — §9.2 on the C5 pipeline: motif
 * DETECTION happened deterministically in the Phase 2 analysis pass
 * (blunder_tags); this endpoint only produces the cached prose EXPLANATION
 * of the proven chain (C0: the LLM cannot be wrong about chess here).
 * Guard chain per A2.4: 401 → 403 unverified → 429 capped. A usage unit is
 * consumed only on a real model call — cache hits are free, and without an
 * LLM key the feature degrades to the rendered chain (200, available:false).
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "Explanations require a verified account (A2.1).",
        403
      );
    }
    const body = await readJson(request);
    const plyId = Number(body.plyId);
    if (!Number.isInteger(plyId)) throw new AccountError("bad_ply", "plyId required.");

    if (!llmAvailable()) {
      return NextResponse.json({ available: false, explanation: null });
    }
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
    const result = await explainBlunder(db, user.id, plyId);
    if (result && !result.cached) {
      await consumeUsage(db, user, { kind: "llmCalls", amount: 1 });
    }
    return NextResponse.json({
      available: result !== null,
      explanation: result?.explanation ?? null,
      cached: result?.cached ?? false,
    });
  });
}
