/**
 * A3.4: seed the `openings` table from src/db/seed/openings.json (which
 * `npm run openings:build` compiles from the vendored Lichess TSVs).
 * Idempotent — upserts on fenKey. Requires DATABASE_URL.
 *
 *   npm run db:seed:openings
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — see .env.example");
  process.exit(1);
}

const raw = await readFile(path.resolve("src/db/seed/openings.json"), "utf8");
const entries = JSON.parse(raw);
const sql = postgres(url, { prepare: false });

// Version guard (#3): content hash in the table comment — an unchanged
// dataset skips the upsert entirely on every build.
const { createHash } = await import("node:crypto");
const version = `openings:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
const [existing] = await sql`SELECT obj_description('openings'::regclass) AS comment`;
if (existing?.comment === version) {
  console.log(`openings: already at ${version} — skipping`);
  await sql.end();
  process.exit(0);
}

const BATCH = 500;
let written = 0;
for (let i = 0; i < entries.length; i += BATCH) {
  const batch = entries.slice(i, i + BATCH).map((e) => ({
    fen_key: e.fenKey,
    eco: e.eco,
    name: e.name,
    pgn: e.pgn,
    ply: e.ply,
  }));
  await sql`
    insert into openings ${sql(batch, "fen_key", "eco", "name", "pgn", "ply")}
    on conflict (fen_key) do update
      set eco = excluded.eco, name = excluded.name, pgn = excluded.pgn, ply = excluded.ply
  `;
  written += batch.length;
}

const [{ count }] = await sql`select count(*)::int as count from openings`;
await sql.unsafe(`COMMENT ON TABLE openings IS '${version}'`);
console.log(`openings: upserted ${written}, table now holds ${count} rows`);
await sql.end();
