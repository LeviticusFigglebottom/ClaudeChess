/**
 * Explorer upstream URL + response mapping as PURE functions, shared by the
 * server client (db-cached, src/lib/explorer/index.ts) and the browser's
 * client-direct path. No db or server imports — safe in client bundles.
 *
 * Why a client-direct path exists: explorer.lichess.ovh blocks datacenter
 * egress (nginx 401 from both the dev container and Vercel — deployment
 * pass 2026-08-22), but the user's browser is a residential IP. Measured on
 * the deployment: the page's COEP (require-corp) does NOT block the CORS
 * fetch — tablebase returns 200 through it and the explorer 401 comes back
 * readable — so the only barrier is the upstream's IP policy, which the
 * browser doesn't share. The server proxy remains the fallback (and the
 * cache/enrichment path) — never a requirement.
 */

export interface ExplorerMoveShape {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
}

export interface ExplorerPositionShape {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMoveShape[];
  opening: { eco: string; name: string } | null;
}

export const EXPLORER_PUBLIC_BASE = "https://explorer.lichess.ovh";

export function buildExplorerUrl(
  base: string,
  fen: string,
  opts: { speeds: string[]; ratings: string[] }
): string {
  const url = new URL(`${base}/lichess`);
  url.searchParams.set("variant", "standard");
  url.searchParams.set("fen", fen);
  url.searchParams.set("speeds", opts.speeds.join(","));
  url.searchParams.set("ratings", opts.ratings.join(","));
  url.searchParams.set("moves", "12");
  url.searchParams.set("topGames", "0");
  url.searchParams.set("recentGames", "0");
  return url.toString();
}

export function mapExplorerResponse(body: unknown): ExplorerPositionShape {
  const raw = body as ExplorerPositionShape & {
    moves?: (ExplorerMoveShape & { averageRating?: number })[];
  };
  return {
    white: raw.white ?? 0,
    draws: raw.draws ?? 0,
    black: raw.black ?? 0,
    moves: (raw.moves ?? []).slice(0, 12).map((move) => ({
      uci: move.uci,
      san: move.san,
      white: move.white,
      draws: move.draws,
      black: move.black,
      averageRating: move.averageRating ?? null,
    })),
    opening: raw.opening ?? null,
  };
}

/**
 * Browser-side direct fetch. Returns null on ANY failure (IP-blocked
 * network, CORS surprise, non-200) — the caller falls back to the server
 * proxy. Never throws.
 */
export async function fetchExplorerDirect(
  fen: string,
  opts: { speeds: string[]; ratings: string[] } = {
    speeds: ["blitz", "rapid", "classical"],
    ratings: ["1400", "1600", "1800"],
  },
  timeoutMs = 4_000
): Promise<ExplorerPositionShape | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(buildExplorerUrl(EXPLORER_PUBLIC_BASE, fen, opts), {
      mode: "cors",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return mapExplorerResponse(await response.json());
  } catch {
    return null;
  }
}
