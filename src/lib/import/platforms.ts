/**
 * Platform API clients (Phase 2 import). Read-only public endpoints, polite
 * by construction: serial requests, delay between calls, exponential backoff
 * on 429, and a descriptive User-Agent (chess.com asks for one). Fetch is
 * injectable for tests.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const USER_AGENT = "GAMBIT chess trainer (self-hosted; github.com/LeviticusFigglebottom/ClaudeChess)";

export class PlatformError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function politeFetch(
  fetchFn: FetchLike,
  url: string,
  accept: string,
  retries = 3
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
    });
    if (response.status === 429 && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after")) || 2 ** attempt * 5;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!response.ok) {
      throw new PlatformError(`${url} → HTTP ${response.status}`, response.status);
    }
    return response;
  }
}

// --- chess.com (https://www.chess.com/news/view/published-data-api) ---

export interface ChesscomGame {
  url: string;
  uuid?: string;
  pgn?: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  rules: string;
  time_class: string;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
}

export async function chesscomPlayerExists(
  username: string,
  fetchFn: FetchLike = fetch
): Promise<boolean> {
  try {
    await politeFetch(
      fetchFn,
      `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`,
      "application/json"
    );
    return true;
  } catch (error) {
    if (error instanceof PlatformError && error.status === 404) return false;
    throw error;
  }
}

/** Monthly archive URLs, oldest first. */
export async function chesscomArchives(
  username: string,
  fetchFn: FetchLike = fetch
): Promise<string[]> {
  const response = await politeFetch(
    fetchFn,
    `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
    "application/json"
  );
  const body = (await response.json()) as { archives?: string[] };
  return body.archives ?? [];
}

export async function chesscomArchiveGames(
  archiveUrl: string,
  fetchFn: FetchLike = fetch
): Promise<ChesscomGame[]> {
  const response = await politeFetch(fetchFn, archiveUrl, "application/json");
  const body = (await response.json()) as { games?: ChesscomGame[] };
  return body.games ?? [];
}

/** chess.com `rules` → our variant vocabulary; null = unsupported (skip). */
export function chesscomRulesToVariant(rules: string): string | null {
  switch (rules) {
    case "chess":
      return "standard";
    case "chess960":
      return "chess960";
    case "threecheck":
      return "threecheck";
    case "kingofthehill":
      return "koth";
    case "crazyhouse":
      return "crazyhouse";
    default:
      return null;
  }
}

// --- Lichess (https://lichess.org/api#tag/Games) ---

export async function lichessPlayerExists(
  username: string,
  fetchFn: FetchLike = fetch
): Promise<boolean> {
  try {
    await politeFetch(
      fetchFn,
      `https://lichess.org/api/user/${encodeURIComponent(username)}`,
      "application/json"
    );
    return true;
  } catch (error) {
    if (error instanceof PlatformError && error.status === 404) return false;
    throw error;
  }
}

export interface LichessExportOpts {
  /** Epoch ms lower bound (exclusive semantics handled by caller via +1). */
  since?: number;
  max?: number;
  /** Include Lichess server analysis ([%eval]) when the game has it. */
  evals?: boolean;
  /** Only games that HAVE server analysis (the agreement-gate source). */
  analysed?: boolean;
  /** Textual judgments (Mistake/Blunder + ?!-style NAG suffixes) in the PGN. */
  literate?: boolean;
  /** dateAsc (incremental import cursor) or dateDesc (recent-first sampling). */
  sort?: "dateAsc" | "dateDesc";
  /** e.g. "blitz,rapid,classical". */
  perfType?: string;
  fetchFn?: FetchLike;
}

/**
 * Streams a user's games as one multi-game PGN (dateAsc by default so the
 * incremental cursor advances monotonically). Clocks and opening tags
 * always requested.
 */
export async function lichessExportPgn(
  username: string,
  opts: LichessExportOpts = {}
): Promise<string> {
  const params = new URLSearchParams({
    clocks: "true",
    opening: "true",
    sort: opts.sort ?? "dateAsc",
  });
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.max !== undefined) params.set("max", String(opts.max));
  if (opts.evals) params.set("evals", "true");
  if (opts.analysed) params.set("analysed", "true");
  if (opts.literate) params.set("literate", "true");
  if (opts.perfType) params.set("perfType", opts.perfType);
  const response = await politeFetch(
    opts.fetchFn ?? fetch,
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`,
    "application/x-chess-pgn"
  );
  return response.text();
}
