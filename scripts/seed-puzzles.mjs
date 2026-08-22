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

// Cheap idempotence guard for the migrate-deploy path: the dataset is
// insert-only from our side (attempt counters live elsewhere), so a table
// already holding the full set needs nothing. Rerun manually after
// changing the committed subset (row-count change makes it automatic).
const [{ n: existing }] = await sql`select count(*)::int as n from puzzles`;
if (existing >= rows.length) {
  console.log(`puzzles: table already holds ${existing} >= ${rows.length} — skipping`);
  await sql.end();
  process.exit(0);
}

let upserted = 0;
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  // jsonb_to_recordset (not the sql() insert helper): moves_uci and themes
  // are jsonb ARRAY columns — stringifying them client-side stored jsonb
  // string scalars, which broke every SQL-level operator on them (the
  // `themes ?|` filter matched nothing; migration 0020 repaired old rows).
  await sql`
    insert into puzzles (id, fen, moves_uci, rating, rating_deviation, themes, popularity)
    select t.id, t.fen, t.moves_uci, t.rating, t.rating_deviation, t.themes, t.popularity
    from jsonb_to_recordset(${sql.json(
      batch.map((puzzle) => ({
        id: puzzle.id,
        fen: puzzle.fen,
        moves_uci: puzzle.movesUci,
        rating: puzzle.rating,
        rating_deviation: puzzle.ratingDeviation,
        themes: puzzle.themes,
        popularity: puzzle.popularity,
      }))
    )}) as t(id text, fen text, moves_uci jsonb, rating int, rating_deviation int, themes jsonb, popularity int)
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
