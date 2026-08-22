/**
 * Phase 3: compile the committed puzzle subset from the Lichess puzzle dump
 * (CC0, https://database.lichess.org/#puzzles). Mirrors the A3.4/B0.3
 * pattern: the RAW dump (1.1 GB) stays out of the repo; the filtered,
 * stratified subset is committed so builds and seeds are hermetic.
 *
 * Filters: popularity ≥ 90, ≥ 600 plays, rating 500–2900, legal replay
 * through the rules facade. Stratified by 100-point rating band so every
 * difficulty is served. ~30k puzzles ≈ 3 MB gzipped.
 *
 *   npx tsx scripts/build-puzzle-subset.mts   (needs data/puzzles-raw/*.csv)
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { GamePosition } from "../src/lib/chess/position";

const CSV = path.resolve("data/puzzles-raw/lichess_db_puzzle.csv");
const OUT = path.resolve("src/db/seed/puzzles.jsonl.gz");
const PER_BAND = 1300; // 24 bands (500–2900) → ~31k
const bandOf = (rating: number) => Math.floor(rating / 100) * 100;

interface SubsetPuzzle {
  id: string;
  fen: string;
  movesUci: string[];
  rating: number;
  ratingDeviation: number;
  themes: string[];
  popularity: number;
}

async function main() {
  const bands = new Map<number, SubsetPuzzle[]>();
  const reader = createInterface({ input: createReadStream(CSV), crlfDelay: Infinity });
  let lines = 0;
  let kept = 0;
  for await (const line of reader) {
    if (lines++ === 0) continue;
    const cols = line.split(",");
    const [id, fen, moves, rating, rd, popularity, plays, themes] = cols;
    if (!id || !fen || !moves || !themes) continue;
    const ratingNumber = Number(rating);
    if (Number(popularity) < 90 || Number(plays) < 600) continue;
    if (ratingNumber < 500 || ratingNumber > 2900) continue;
    const band = bandOf(ratingNumber);
    const bucket = bands.get(band) ?? [];
    if (bucket.length >= PER_BAND) continue;

    const movesUci = moves.split(" ");
    if (movesUci.length < 2) continue;
    // Legality: the full line must replay through the facade.
    try {
      const position = GamePosition.fromFen(fen, "standard");
      let legal = true;
      for (const uci of movesUci) {
        if (!position.moveUci(uci)) {
          legal = false;
          break;
        }
      }
      if (!legal) continue;
    } catch {
      continue;
    }

    bucket.push({
      id,
      fen,
      movesUci,
      rating: ratingNumber,
      ratingDeviation: Number(rd) || 90,
      themes: themes.split(" ").filter(Boolean),
      popularity: Number(popularity),
    });
    bands.set(band, bucket);
    kept++;
    if (lines % 500_000 === 0) console.log(`…scanned ${lines}, kept ${kept}`);
    if ([...bands.values()].every((b) => b.length >= PER_BAND) && bands.size >= 24) break;
  }
  reader.close();

  const all = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, bucket]) => bucket);
  const jsonl = all.map((puzzle) => JSON.stringify(puzzle)).join("\n");
  writeFileSync(OUT, gzipSync(Buffer.from(jsonl), { level: 9 }));
  console.log(`bands: ${bands.size}, puzzles: ${all.length}`);
  console.log(
    `band sizes: ${[...bands.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([band, bucket]) => `${band}:${bucket.length}`)
      .join(" ")}`
  );
  console.log(`wrote ${OUT} (${(gzipSync(Buffer.from(jsonl)).length / 1e6).toFixed(1)} MB)`);
}

await main();
