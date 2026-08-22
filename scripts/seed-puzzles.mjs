/**
 * Phase 3: upsert the committed puzzle subset into the puzzles table.
 *
 *   DATABASE_URL=... npm run db:seed:puzzles
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const file = path.resolve("src/db/seed/puzzles.jsonl.gz");
const rows = gunzipSync(readFileSync(file))
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const sql = postgres(DATABASE_URL, { prepare: false });
let upserted = 0;
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  await sql`
    insert into puzzles ${sql(
      batch.map((puzzle) => ({
        id: puzzle.id,
        fen: puzzle.fen,
        moves_uci: JSON.stringify(puzzle.movesUci),
        rating: puzzle.rating,
        rating_deviation: puzzle.ratingDeviation,
        themes: JSON.stringify(puzzle.themes),
        popularity: puzzle.popularity,
      }))
    )}
    on conflict (id) do update set
      rating = excluded.rating,
      rating_deviation = excluded.rating_deviation,
      themes = excluded.themes,
      popularity = excluded.popularity
  `;
  upserted += batch.length;
}
const count = await sql`select count(*)::int as n from puzzles`;
console.log(`upserted ${upserted}; puzzles table now holds ${count[0].n}`);
await sql.end();
