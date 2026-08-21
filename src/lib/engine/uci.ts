import type { EngineInfo } from "./types";

/**
 * Parses a UCI `info` line into an EngineInfo. Returns null for lines that
 * carry no principal variation or no score (e.g. `info string ...`,
 * `info currmove ...`) and for upperbound/lowerbound reports, which are
 * transient search artifacts not meant for display.
 *
 * Scores are left in side-to-move POV — see /lib/eval/pov.ts for the one
 * place they are normalized.
 */
export function parseInfoLine(line: string): EngineInfo | null {
  if (!line.startsWith("info ")) return null;

  const tokens = line.split(/\s+/);
  let depth: number | null = null;
  let multipv = 1;
  let scoreCp: number | null = null;
  let mateIn: number | null = null;
  let nodes = 0;
  let nps = 0;
  let pv: string[] | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case "depth":
        depth = Number(tokens[++i]);
        break;
      case "multipv":
        multipv = Number(tokens[++i]);
        break;
      case "score": {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === "cp") scoreCp = value;
        else if (kind === "mate") mateIn = value;
        break;
      }
      case "lowerbound":
      case "upperbound":
        return null;
      case "nodes":
        nodes = Number(tokens[++i]);
        break;
      case "nps":
        nps = Number(tokens[++i]);
        break;
      case "pv":
        pv = tokens.slice(i + 1).filter((t): t is string => t !== undefined && t !== "");
        i = tokens.length;
        break;
      case "string":
        return null;
      default:
        break;
    }
  }

  if (depth === null || pv === null || pv.length === 0) return null;
  if (scoreCp === null && mateIn === null) return null;

  return { depth, multipv, scoreCp, mateIn, pv, nodes, nps };
}

export function parseBestmoveLine(line: string): string | null {
  if (!line.startsWith("bestmove")) return null;
  const move = line.split(/\s+/)[1];
  return move ?? null;
}

export function parseIdNameLine(line: string): string | null {
  if (!line.startsWith("id name ")) return null;
  return line.slice("id name ".length);
}
