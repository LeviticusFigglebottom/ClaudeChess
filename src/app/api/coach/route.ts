import { guardedStubHandler } from "@/lib/account/guarded-stub";

/**
 * POST /api/coach — LLM coach commentary (Phase 5 body, spec §6/§9.5). The
 * A2.4 guard chain (verified account + monthly LLM cap) is live now.
 */
export const POST = guardedStubHandler({ kind: "llmCalls", arrivesIn: "Phase 5" });
