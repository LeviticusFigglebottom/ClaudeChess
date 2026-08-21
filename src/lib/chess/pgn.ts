import { describeClock, type ClockConfig } from "@/lib/clock/clock";
import type { VariantId } from "./variant";

/**
 * PGN writer (Phase 1: games vs bots, with %clk). Emits the clock remaining
 * AFTER each move as `{[%clk h:mm:ss]}` — the convention chess.com and
 * Lichess exports use, and what §9.3's timeSpentMs reconstruction reads.
 * Chess960 games carry SetUp/FEN (X-FEN castling) and Variant headers.
 */

export interface PgnMove {
  san: string;
  /** Mover's clock after completing this move; omit when untimed. */
  clockMsAfter?: number;
}

export interface PgnMeta {
  white: string;
  black: string;
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  variant: VariantId;
  /** Required for chess960 (the Scharnagl start, X-FEN castling). */
  startFen?: string;
  startPositionId?: number;
  clock: ClockConfig;
  rated: boolean;
  playedAt: Date;
  /** e.g. "checkmate", "resignation", "time forfeit", "draw agreed". */
  termination?: string;
  eco?: { eco: string; name: string } | null;
}

export function formatClk(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** PGN TimeControl tag: "base+inc" seconds for Fischer, "base" otherwise, "-" untimed. */
function timeControlTag(clock: ClockConfig): string {
  if (clock.mode === "none") return "-";
  const base = Math.round(clock.initialMs / 1000);
  const inc = Math.round(clock.incrementMs / 1000);
  return clock.mode === "fischer" ? `${base}+${inc}` : String(base);
}

function pgnDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

export function writePgn(meta: PgnMeta, moves: PgnMove[]): string {
  const headers: [string, string][] = [
    ["Event", `GAMBIT ${meta.rated ? "rated" : "casual"} game`],
    ["Site", "GAMBIT"],
    ["Date", pgnDate(meta.playedAt)],
    ["Round", "-"],
    ["White", meta.white],
    ["Black", meta.black],
    ["Result", meta.result],
    ["TimeControl", timeControlTag(meta.clock)],
  ];
  if (meta.clock.mode === "delay" || meta.clock.mode === "bronstein") {
    // The PGN TimeControl grammar has no delay encoding — record it honestly
    // in auxiliary tags instead of lying in the standard one.
    headers.push(["TimeControlMode", meta.clock.mode]);
    headers.push(["TimeControlDelay", String(Math.round(meta.clock.incrementMs / 1000))]);
  }
  headers.push(["TimeControlDisplay", describeClock(meta.clock)]);
  if (meta.termination) headers.push(["Termination", meta.termination]);
  if (meta.variant === "chess960") {
    headers.push(["Variant", "Chess960"]);
    if (meta.startPositionId !== undefined) {
      headers.push(["StartPosition", `SP${meta.startPositionId}`]);
    }
    if (meta.startFen) {
      headers.push(["SetUp", "1"]);
      headers.push(["FEN", meta.startFen]);
    }
  } else if (meta.variant !== "standard") {
    headers.push(["Variant", meta.variant]);
  }
  if (meta.eco) {
    headers.push(["ECO", meta.eco.eco]);
    headers.push(["Opening", meta.eco.name]);
  }

  const headerText = headers.map(([key, value]) => `[${key} "${value}"]`).join("\n");

  const tokens: string[] = [];
  moves.forEach((move, index) => {
    if (index % 2 === 0) tokens.push(`${index / 2 + 1}.`);
    tokens.push(move.san);
    if (move.clockMsAfter !== undefined) {
      tokens.push(`{[%clk ${formatClk(move.clockMsAfter)}]}`);
    }
  });
  tokens.push(meta.result);

  // Wrap movetext near 80 columns.
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line.length + token.length + 1 > 80 && line.length > 0) {
      lines.push(line);
      line = token;
    } else {
      line = line.length === 0 ? token : `${line} ${token}`;
    }
  }
  if (line) lines.push(line);

  return `${headerText}\n\n${lines.join("\n")}\n`;
}
