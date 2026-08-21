/**
 * A3.4 build step: compile the vendored Lichess chess-openings TSVs
 * (data/chess-openings/*.tsv, CC0) into src/db/seed/openings.json.
 *
 * Each line's PGN is replayed with chessops; the key is the resulting
 * position's epd (board, turn, castling, ep — no move counters), which makes
 * matching transposition-aware. Deduped by fenKey keeping the SHALLOWEST
 * line (canonical name for a position); depth ("ply") is stored so the
 * matcher can report and reason about line depth. Standard chess only.
 *
 * The JSON is committed — regenerate with `npm run openings:build` after
 * updating the TSVs, and expect the script to fail loudly on any PGN that
 * does not replay.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";

const FILES = ["a", "b", "c", "d", "e"];
const sourceDir = path.resolve("data/chess-openings");
const outFile = path.resolve("src/db/seed/openings.json");

const byFenKey = new Map();
let lines = 0;
let duplicates = 0;

for (const file of FILES) {
  const tsv = await readFile(path.join(sourceDir, `${file}.tsv`), "utf8");
  for (const row of tsv.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith("eco\t")) continue;
    const [eco, name, pgn] = trimmed.split("\t");
    if (!eco || !name || !pgn) {
      console.error(`malformed row in ${file}.tsv: ${trimmed.slice(0, 80)}`);
      process.exit(1);
    }
    lines++;

    const pos = Chess.default();
    const sanMoves = pgn
      .split(/\s+/)
      .filter((token) => token && !/^\d+\.(\.\.)?$/.test(token));
    for (const san of sanMoves) {
      const move = parseSan(pos, san);
      if (!move) {
        console.error(`SAN failed to replay in ${file}.tsv: "${pgn}" at "${san}" (${eco} ${name})`);
        process.exit(1);
      }
      pos.play(move);
    }

    const fenKey = makeFen(pos.toSetup(), { epd: true });
    const ply = sanMoves.length;
    const existing = byFenKey.get(fenKey);
    if (existing) {
      duplicates++;
      if (ply < existing.ply) byFenKey.set(fenKey, { fenKey, eco, name, pgn, ply });
      continue;
    }
    byFenKey.set(fenKey, { fenKey, eco, name, pgn, ply });
  }
}

const entries = [...byFenKey.values()].sort(
  (a, b) => a.eco.localeCompare(b.eco) || a.ply - b.ply || a.name.localeCompare(b.name)
);
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(entries, null, 1) + "\n");
console.log(
  `openings: ${lines} TSV lines → ${entries.length} unique positions (${duplicates} transposition duplicates collapsed) → ${path.relative(process.cwd(), outFile)}`
);
