import type { EngineBuild } from "./types";
import { StockfishClient } from "./worker-client";

export const MULTI_THREADED_BUILD: EngineBuild = {
  url: "/engine/stockfish-18-lite.js",
  variant: "multi-threaded",
  maxThreads: 8,
};

export const SINGLE_THREADED_BUILD: EngineBuild = {
  url: "/engine/stockfish-18-lite-single.js",
  variant: "single-threaded",
  maxThreads: 1,
};

/**
 * True when the page is cross-origin isolated and SharedArrayBuffer exists —
 * the preconditions for the multi-threaded build (spec §3.1).
 */
export function isEngineIsolated(): boolean {
  return (
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated &&
    typeof SharedArrayBuffer !== "undefined"
  );
}

export function detectEngineBuild(): EngineBuild {
  return isEngineIsolated() ? MULTI_THREADED_BUILD : SINGLE_THREADED_BUILD;
}

/**
 * Interactive-analysis thread count (spec §3.3 sizing): leave one core for
 * the UI, cap at 4.
 */
export function defaultThreads(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
  return Math.max(1, Math.min(cores - 1, 4));
}

export function createEngine(): StockfishClient {
  return new StockfishClient(detectEngineBuild());
}
