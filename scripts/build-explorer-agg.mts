/**
 * Task 2b offline pipeline: Lichess monthly PGN dump → self-hosted opening
 * aggregate for §9.4. First 16 plies only; each game buckets into ONE
 * rating band (EXPLORER_RATINGS floor of the players' average) and ONE
 * speed (EXPLORER_SPEEDS, derived from TimeControl with Lichess's
 * base+40×inc rule); rows below --min-games are pruned. Output is the
 * COMMITTED seed (gzipped JSONL) — hermetic like the ECO import: the build
 * environment never needs the dump or a database.
 *
 *   NODE_OPTIONS=--max-old-space-size=6144 npx tsx scripts/build-explorer-agg.mts \
 *     [--dump data/dumps/....pgn.zst] [--max-games N] [--min-games 10]
 *
 * Reports row counts at several prune thresholds so the committed choice is
 * a measured trade against the Supabase free tier, not a guess.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { GamePosition } from "../src/lib/chess/position";
import { EXPLORER_RATINGS } from "../src/lib/explorer/index";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1]! : fallback;
};
const DUMP = flag("--dump", "data/dumps/lichess_db_standard_rated_2014-07.pgn.zst");
const URL_SOURCE = flag("--url", "");
const MAX_GAMES = Number(flag("--max-games", "2000000"));
const MIN_GAMES = Number(flag("--min-games", "10"));
const OUT = flag("--out", "src/db/seed/explorer-agg.jsonl.gz");
const MAX_PLIES = 16;

const BANDS = EXPLORER_RATINGS.map(Number);
function bandOf(white: number, black: number): string {
  const avg = (white + black) / 2;
  let chosen = BANDS[0]!;
  for (const band of BANDS) if (band <= avg) chosen = band;
  return String(chosen);
}

function speedOf(timeControl: string): string | null {
  if (timeControl === "-") return "correspondence";
  const match = timeControl.match(/^(\d+)\+(\d+)$/);
  if (!match) return null;
  const estimate = Number(match[1]) + 40 * Number(match[2]);
  if (estimate < 30) return "ultraBullet";
  if (estimate < 180) return "bullet";
  if (estimate < 480) return "blitz";
  if (estimate < 1500) return "rapid";
  return "classical";
}

// counts packed as Int32Array [white, draws, black] per key.
const agg = new Map<string, Int32Array>();
let games = 0;
let used = 0;
let plies = 0;

function processGame(headers: Map<string, string>, movetext: string): void {
  games++;
  if ((headers.get("Variant") ?? "Standard") !== "Standard") return;
  const result = headers.get("Result");
  if (result !== "1-0" && result !== "0-1" && result !== "1/2-1/2") return;
  const whiteElo = Number(headers.get("WhiteElo"));
  const blackElo = Number(headers.get("BlackElo"));
  if (!Number.isFinite(whiteElo) || !Number.isFinite(blackElo)) return;
  const speed = speedOf(headers.get("TimeControl") ?? "");
  if (!speed) return;
  const band = bandOf(whiteElo, blackElo);
  const slot = result === "1-0" ? 0 : result === "1/2-1/2" ? 1 : 2;

  // Lean SAN tokenizer: strip comments/NAGs/move numbers/result.
  const tokens = movetext
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\$\d+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^\d+\.+$/.test(t) && t !== result);

  const position = GamePosition.initial("standard");
  for (let i = 0; i < Math.min(tokens.length, MAX_PLIES); i++) {
    const epd = position.fen().split(" ").slice(0, 4).join(" ");
    const move = position.moveSan(tokens[i]!);
    if (!move) return; // malformed movetext — abandon this game's remainder
    const key = `${epd}\t${band}\t${speed}\t${move.uci}`;
    let counts = agg.get(key);
    if (!counts) {
      counts = new Int32Array(3);
      agg.set(key, counts);
    }
    counts[slot]!++;
    plies++;
  }
  used++;
}

async function main() {
  // --url streams the dump straight through curl|zstd — a PREFIX of the
  // month (first days) with --max-games, so a recent month costs only the
  // bytes actually consumed instead of a 30GB download.
  const zstd = URL_SOURCE
    ? spawn("sh", ["-c", `curl -sL "${URL_SOURCE}" | zstd -dc`], { stdio: ["ignore", "pipe", "inherit"] })
    : spawn("zstd", ["-dc", DUMP], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: zstd.stdout, crlfDelay: Infinity });
  let headers = new Map<string, string>();
  let movetext = "";
  let inMoves = false;
  for await (const line of lines) {
    if (line.startsWith("[")) {
      if (inMoves) {
        processGame(headers, movetext);
        if (used >= MAX_GAMES) break;
        headers = new Map();
        movetext = "";
        inMoves = false;
        if (games % 20000 === 0) {
          process.stderr.write(`\r${games} games, ${used} used, ${agg.size} keys, ${plies} plies   `);
        }
      }
      const match = line.match(/^\[(\w+)\s+"([^"]*)"\]/);
      if (match) headers.set(match[1]!, match[2]!);
    } else if (line.trim().length > 0) {
      inMoves = true;
      movetext += " " + line;
    }
  }
  if (inMoves && used < MAX_GAMES) processGame(headers, movetext);
  zstd.kill();
  process.stderr.write("\n");

  // Prune-threshold report: the committed choice is a measured trade.
  const thresholds = [1, 3, 5, 10, 20, 50];
  const rows = new Map<number, number>(thresholds.map((t) => [t, 0]));
  for (const counts of agg.values()) {
    const total = counts[0]! + counts[1]! + counts[2]!;
    for (const t of thresholds) if (total >= t) rows.set(t, rows.get(t)! + 1);
  }
  console.log(`games seen ${games}, used ${used}, plies ${plies}, distinct keys ${agg.size}`);
  for (const t of thresholds) console.log(`  min-games ≥ ${String(t).padStart(2)} → ${rows.get(t)} rows`);

  const gzip = createGzip({ level: 9 });
  const sink = createWriteStream(OUT);
  gzip.pipe(sink);
  let written = 0;
  const source = URL_SOURCE ? URL_SOURCE.split("/").pop()!.replace(".pgn.zst", "") : DUMP.split("/").pop()!.replace(".pgn.zst", "");
  // Sampling method, derived: hitting --max-games means the input was cut
  // off mid-month — a CHRONOLOGICAL PREFIX (the month's first hours,
  // timezone-skewed), NOT a random sample. Stamped so it is never read
  // later as random.
  const sampling =
    used >= MAX_GAMES
      ? `chronological-prefix (first ${used} games of the month — not a random sample; skewed toward the month's first hours)`
      : "complete-dump";
  // First line: seed metadata — the source month and sampling method are
  // recorded so staleness and method are visible, and the version string
  // drives the seed guard.
  gzip.write(
    JSON.stringify({
      meta: {
        source,
        gamesUsed: used,
        minGames: MIN_GAMES,
        sampling,
        builtAt: new Date().toISOString().slice(0, 10),
        version: `${source}:min${MIN_GAMES}`,
      },
    }) + "\n"
  );
  for (const [key, counts] of agg) {
    const total = counts[0]! + counts[1]! + counts[2]!;
    if (total < MIN_GAMES) continue;
    const [epd, band, speed, uci] = key.split("\t");
    gzip.write(
      JSON.stringify({ epd, band, speed, uci, w: counts[0], d: counts[1], b: counts[2] }) + "\n"
    );
    written++;
  }
  await new Promise<void>((resolve) => {
    gzip.end();
    sink.on("finish", () => resolve());
  });
  console.log(`wrote ${written} rows (min-games ${MIN_GAMES}) → ${OUT}`);
  process.exit(0);
}

await main();
