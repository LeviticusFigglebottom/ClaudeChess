import { guardedStubHandler } from "@/lib/account/guarded-stub";

/**
 * POST /api/classify-blunder — LLM motif tagging (Phase 5 body, spec §9.2).
 * The A2.4 guard chain (verified account + monthly LLM cap) is live now.
 */
export const POST = guardedStubHandler({ kind: "llmCalls", arrivesIn: "Phase 5" });
