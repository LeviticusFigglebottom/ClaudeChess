import { guardedStubHandler } from "@/lib/account/guarded-stub";

/**
 * POST /api/analyze — batch server-side analysis (Phase 2 body). The A2.4
 * guard chain (verified account + monthly deep-ply cap) is live now.
 */
export const POST = guardedStubHandler({ kind: "analysisPliesDeep", arrivesIn: "Phase 2" });
