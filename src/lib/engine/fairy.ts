import type { VariantId } from "@/lib/chess/variant";

/**
 * Fairy-Stockfish integration constants (Phase 4.5). UCI option values are
 * engine-internal vocabulary and must never escape src/lib/engine
 * (invariant 2) — the rest of the app speaks VariantId only.
 */

/** Fairy-Stockfish's UCI_Variant value for each of our variant ids. */
export const FAIRY_UCI_VARIANT: Partial<Record<VariantId, string>> = {
  threecheck: "3check",
  koth: "kingofthehill",
};

/** Browser worker bootstrap for the vendored build (public/engine/fairy). */
export const FAIRY_WORKER_URL = "/engine/fairy/fairy-worker.js";

/** Node CLI shell for the same build (ServerEngine child process). */
export const FAIRY_NODE_CLI = ["public", "engine", "fairy", "fairy-uci.cjs"] as const;
