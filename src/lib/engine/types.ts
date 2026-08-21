/**
 * Engine worker contract (spec §3.2).
 *
 * The rest of the app must never touch UCI strings — this module boundary is
 * the only place they exist. `EngineInfo.scoreCp`/`mateIn` are reported from
 * the SIDE TO MOVE's point of view, exactly as UCI gives them. Normalization
 * to White-POV happens once, at the boundary of `/lib/eval` (pov.ts), and
 * never again.
 */

import type { VariantId } from "@/lib/chess/variant";

export interface EngineInitOpts {
  threads: number;
  hashMb: number;
  /**
   * Rules variant this engine instance will analyze (addendum A0.3/A1.3).
   * chess960 turns on the engine's 960 castling/X-FEN handling. Variants
   * vanilla Stockfish cannot evaluate are rejected at init — a meaningless
   * eval silently corrupts every downstream trainer.
   */
  variant: VariantId;
}

export interface AnalyzeOpts {
  depth?: number;
  movetimeMs?: number;
  multipv?: number;
}

export interface EngineInfo {
  depth: number;
  /** 1-indexed MultiPV line number. */
  multipv: number;
  /** Centipawns from the side to move's POV; null when the score is a mate. */
  scoreCp: number | null;
  /** Signed moves-to-mate from the side to move's POV; null when not a mate. */
  mateIn: number | null;
  /** Principal variation as UCI moves. */
  pv: string[];
  nodes: number;
  nps: number;
}

export interface EngineClient {
  init(opts: EngineInitOpts): Promise<void>;
  setPosition(fen: string, moves?: string[]): void;
  /** Streams intermediate results; the last yield before completion is final. */
  analyze(opts: AnalyzeOpts): AsyncIterable<EngineInfo>;
  stop(): void;
  quit(): void;
}

export interface EngineBuild {
  /** Public URL of the worker script. */
  url: string;
  /** Human-readable variant name for diagnostics. */
  variant: "multi-threaded" | "single-threaded";
  /** Max threads this build supports. */
  maxThreads: number;
}
