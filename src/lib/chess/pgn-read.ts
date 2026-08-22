import { GamePosition } from "./position";
import { isVariantId, type VariantId } from "./variant";

/**
 * PGN reader (Phase 2 import). Hand-rolled tokenizer — no chessops here; SAN
 * legality and UCI/FEN production go through the GamePosition facade, which
 * keeps the rules-engine boundary where it belongs. Mainline only: variations
 * are skipped (imported games are linear; trees are the analysis board's
 * concern, A3.2).
 *
 * Extracts per move: SAN, NAG judgments (from `$n` and from `?`/`??`/`?!`
 * suffixes), `[%clk h:mm:ss]` and `[%eval x | #n]` comment tags — the inputs
 * §9.3 (clocks) and the Phase 2 agreement gate (Lichess's own judgments)
 * need.
 */

export interface RawPgnMove {
  san: string;
  /** Numeric Annotation Glyphs: 1 !, 2 ?, 3 !!, 4 ??, 5 !?, 6 ?! */
  nags: number[];
  /** Clock remaining for the mover after the move, from [%clk]. */
  clockMs: number | null;
  /** [%eval] centipawns (White-POV, Lichess convention); null if absent or mate. */
  evalCp: number | null;
  /** [%eval #n] mate distance (White-POV). */
  evalMate: number | null;
  comment: string | null;
}

export interface RawPgnGame {
  headers: Record<string, string>;
  moves: RawPgnMove[];
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
}

const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

const SUFFIX_NAGS: Record<string, number> = {
  "!": 1,
  "?": 2,
  "!!": 3,
  "??": 4,
  "!?": 5,
  "?!": 6,
};

function parseClk(tag: string): number | null {
  // h:mm:ss or h:mm:ss.t
  const match = tag.match(/(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?/);
  if (!match) return null;
  const [, h, m, s, frac] = match;
  const ms =
    Number(h) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1000 +
    (frac ? Number(`0.${frac}`) * 1000 : 0);
  return Math.round(ms);
}

function parseEval(tag: string): { cp: number | null; mate: number | null } {
  const mate = tag.match(/#(-?\d+)/);
  if (mate) return { cp: null, mate: Number(mate[1]) };
  const cp = tag.match(/(-?\d+(?:\.\d+)?)/);
  if (cp) return { cp: Math.round(Number(cp[1]) * 100), mate: null };
  return { cp: null, mate: null };
}

/** Splits a multi-game PGN file into raw games. Tolerant of blank lines and BOM. */
export function parseMultiPgn(text: string): RawPgnGame[] {
  const source = text.replace(/^﻿/, "");
  const games: RawPgnGame[] = [];
  let index = 0;
  const length = source.length;

  while (index < length) {
    // Skip whitespace between games.
    while (index < length && /\s/.test(source[index] as string)) index++;
    if (index >= length) break;

    const headers: Record<string, string> = {};
    // Header section.
    while (index < length && source[index] === "[") {
      const close = source.indexOf("]", index);
      if (close === -1) break;
      const line = source.slice(index + 1, close);
      const match = line.match(/^(\w+)\s+"([\s\S]*)"$/);
      if (match) headers[match[1] as string] = (match[2] as string).replace(/\\"/g, '"');
      index = close + 1;
      while (index < length && /[ \t\r\n]/.test(source[index] as string)) index++;
    }

    // Movetext until a result token at depth 0 (or next game's header block).
    const moves: RawPgnMove[] = [];
    let result: RawPgnGame["result"] = "*";
    let depth = 0;
    let current: RawPgnMove | null = null;
    let sawMovetext = false;

    while (index < length) {
      const char = source[index] as string;
      if (char === "{") {
        const close = source.indexOf("}", index);
        const body = source.slice(index + 1, close === -1 ? length : close);
        index = close === -1 ? length : close + 1;
        if (depth > 0) continue;
        const target = current;
        if (target) {
          for (const tagMatch of body.matchAll(/\[%(\w+)\s+([^\]]*)\]/g)) {
            const [, name, value] = tagMatch;
            if (name === "clk") target.clockMs = parseClk(value as string);
            if (name === "eval") {
              const parsed = parseEval(value as string);
              target.evalCp = parsed.cp;
              target.evalMate = parsed.mate;
            }
          }
          const prose = body.replace(/\[%\w+\s+[^\]]*\]/g, "").trim();
          if (prose) target.comment = target.comment ? `${target.comment} ${prose}` : prose;
        }
        continue;
      }
      if (char === "(") {
        depth++;
        index++;
        continue;
      }
      if (char === ")") {
        depth = Math.max(0, depth - 1);
        index++;
        continue;
      }
      if (char === "[" && depth === 0 && sawMovetext) {
        // Next game's headers (a "*"-less truncated game) — stop here.
        break;
      }
      if (/\s/.test(char)) {
        index++;
        continue;
      }

      // Plain token.
      let end = index;
      while (end < length && !/[\s{}()]/.test(source[end] as string)) end++;
      const token = source.slice(index, end);
      index = end;
      sawMovetext = true;
      if (depth > 0) continue;

      if (RESULT_TOKENS.has(token)) {
        result = token as RawPgnGame["result"];
        break;
      }
      if (/^\d+\.+$/.test(token) || token === "..") continue; // move numbers
      if (token.startsWith("$")) {
        const nag = Number(token.slice(1));
        if (current && Number.isFinite(nag)) current.nags.push(nag);
        continue;
      }
      // SAN with optional suffix annotation.
      const suffixMatch = token.match(/^([^!?]+)([!?]{1,2})?$/);
      if (!suffixMatch) continue;
      let san = suffixMatch[1] as string;
      // Strip leading move numbers glued to the SAN ("12.Nf3", "3...c5").
      san = san.replace(/^\d+\.+/, "");
      if (san.length === 0) continue;
      const move: RawPgnMove = {
        san,
        nags: [],
        clockMs: null,
        evalCp: null,
        evalMate: null,
        comment: null,
      };
      const suffix = suffixMatch[2];
      if (suffix && SUFFIX_NAGS[suffix] !== undefined) move.nags.push(SUFFIX_NAGS[suffix]);
      moves.push(move);
      current = move;
    }

    if (Object.keys(headers).length > 0 || moves.length > 0) {
      if (headers.Result && RESULT_TOKENS.has(headers.Result)) {
        result = headers.Result as RawPgnGame["result"];
      }
      games.push({ headers, moves, result });
    }
  }
  return games;
}

/** Lichess "variant" header / API values → our VariantId; null = unsupported. */
export function variantFromHeader(value: string | undefined): VariantId | null {
  if (!value) return "standard";
  const normalized = value.toLowerCase().replace(/[\s-]/g, "");
  switch (normalized) {
    case "standard":
    case "chess":
    case "fromposition": // Lichess custom-start standard games
      return "standard";
    case "chess960":
    case "fischerandom":
    case "fischerrandom":
      return "chess960";
    case "threecheck":
    case "3check":
      return "threecheck";
    case "kingofthehill":
    case "koth":
      return "koth";
    case "crazyhouse":
      return "crazyhouse";
    default:
      return isVariantId(normalized) ? (normalized as VariantId) : null;
  }
}

export interface ReplayedPly {
  ply: number;
  moveNumber: number;
  color: "w" | "b";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  nags: number[];
  clockMs: number | null;
  evalCp: number | null;
  evalMate: number | null;
  comment: string | null;
}

export interface ReplayedGame {
  variant: VariantId;
  startFen: string;
  /** True when the game starts from the variant's default initial position. */
  isDefaultStart: boolean;
  plies: ReplayedPly[];
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  headers: Record<string, string>;
}

/**
 * Replays a raw game through the rules facade, producing UCI + FENs per ply.
 * Throws with a precise ply reference when a SAN move is illegal — an import
 * must never silently truncate a game.
 */
export function replayPgnGame(raw: RawPgnGame): ReplayedGame {
  const variant = variantFromHeader(raw.headers.Variant);
  if (variant === null) {
    throw new Error(`unsupported variant "${raw.headers.Variant}"`);
  }
  const startFen =
    raw.headers.SetUp === "1" || raw.headers.FEN ? raw.headers.FEN : undefined;
  const position = startFen
    ? GamePosition.fromFen(startFen, variant)
    : variant === "chess960"
      ? (() => {
          throw new Error("chess960 game without a FEN header");
        })()
      : GamePosition.initial(variant);

  const plies: ReplayedPly[] = [];
  let moveNumber = startFen ? Number(startFen.split(" ")[5] ?? 1) : 1;
  let color: "w" | "b" = position.turn;

  for (const [i, move] of raw.moves.entries()) {
    const fenBefore = position.fen();
    const applied = position.moveSan(move.san);
    if (!applied) {
      throw new Error(`illegal SAN "${move.san}" at ply ${i + 1}`);
    }
    plies.push({
      ply: i + 1,
      moveNumber,
      color,
      san: applied.san,
      uci: applied.uci,
      fenBefore,
      fenAfter: position.fen(),
      nags: move.nags,
      clockMs: move.clockMs,
      evalCp: move.evalCp,
      evalMate: move.evalMate,
      comment: move.comment,
    });
    if (color === "b") moveNumber++;
    color = color === "w" ? "b" : "w";
  }

  return {
    variant,
    startFen: position.startFen,
    isDefaultStart: !startFen,
    plies,
    result: raw.result,
    headers: raw.headers,
  };
}

/**
 * Per-ply think time from %clk (§9.3): spent = previous own clock − own clock
 * + increment (the increment was added after the move under Fischer timing).
 * First move per side charges against the base time. Clamped at ≥ 0.
 */
export function timeSpentFromClocks(
  plies: { color: "w" | "b"; clockMs: number | null }[],
  baseMs: number | null,
  incrementMs: number
): (number | null)[] {
  const lastClock: Record<"w" | "b", number | null> = {
    w: baseMs,
    b: baseMs,
  };
  return plies.map((ply) => {
    const clock = ply.clockMs;
    if (clock === null) return null;
    const previous = lastClock[ply.color];
    lastClock[ply.color] = clock;
    if (previous === null) return null;
    return Math.max(0, previous - clock + incrementMs);
  });
}

/** Parses "300+3" / "1/86400" / "-" time-control tags → base/increment ms. */
export function parseTimeControlTag(
  tag: string | undefined
): { baseMs: number; incrementMs: number; daily: boolean } | null {
  if (!tag || tag === "-" || tag === "?") return null;
  const daily = tag.match(/^1\/(\d+)$/);
  if (daily) return { baseMs: Number(daily[1]) * 1000, incrementMs: 0, daily: true };
  const match = tag.match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  return {
    baseMs: Number(match[1]) * 1000,
    incrementMs: Number(match[2] ?? 0) * 1000,
    daily: false,
  };
}
