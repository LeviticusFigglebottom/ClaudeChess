import { NextResponse } from "next/server";
import { handleApi, requireUser } from "./api";
import { AccountError, isVerified } from "./types";
import { checkUsage, type UsageKind } from "./usage";

/**
 * A2.4 requires rate limits on /api/analyze, /api/coach,
 * /api/classify-blunder, and /api/import. The route BODIES land in Phases 2
 * and 5; the ENFORCEMENT lands now (Phase 1.5) so the guard order is live
 * and testable from day one:
 *
 *   401 signed out → 403 unverified (A2.1) → 429 over monthly cap → 501 stub
 *
 * The check is non-consuming (checkUsage) — nothing books until a route
 * actually performs work. Phase 2/5 swap the 501 for the real body plus
 * consumeUsage, keeping the guards above it.
 */
export function guardedStubHandler(opts: {
  kind: UsageKind;
  amount?: number;
  arrivesIn: string;
}): () => Promise<NextResponse> {
  return () =>
    handleApi(async () => {
      const { db, user } = await requireUser();
      if (!isVerified(user)) {
        throw new AccountError(
          "verified_required",
          "This feature requires a verified account (A2.1). Create an account and confirm your email — your games and ratings come with you.",
          403
        );
      }
      const decision = await checkUsage(db, user, { kind: opts.kind, amount: opts.amount ?? 1 });
      if (!decision.allowed) {
        return NextResponse.json(
          {
            error: {
              code: "usage_capped",
              message: `Monthly ${opts.kind} limit reached (${decision.used}/${decision.cap}). Resets next month.`,
            },
            usage: decision,
          },
          { status: 429 }
        );
      }
      return NextResponse.json(
        {
          error: {
            code: "not_yet_implemented",
            message: `This endpoint arrives in ${opts.arrivesIn}. Rate limiting is already live: ${decision.used}/${decision.cap} ${opts.kind} used this month.`,
          },
          usage: decision,
        },
        { status: 501 }
      );
    });
}
