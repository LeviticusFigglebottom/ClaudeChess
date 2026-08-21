import { guardedStubHandler } from "@/lib/account/guarded-stub";

/**
 * POST /api/import — chess.com / Lichess ingest (Phase 2 body). The A2.4
 * guard chain (verified account + monthly import cap) is live now.
 */
export const POST = guardedStubHandler({ kind: "importsRun", arrivesIn: "Phase 2" });
