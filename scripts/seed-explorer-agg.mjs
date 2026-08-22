/**
 * Idempotent seed for the self-hosted explorer aggregate (Task 2b) — the
 * same hermetic pattern as the openings seed: the committed dataset
 * (src/db/seed/explorer-agg.jsonl.gz) upserts into explorer_agg. Requires
 * DATABASE_URL. Runs inside migrate-deploy on Vercel builds.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

const SEED = "src/db/seed/explorer-agg.jsonl.gz";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — see .env.example");
  process.exit(1);
}
if (!existsSync(SEED)) {
  console.log("explorer-agg: no committed dataset — skipping (repertoire will use the live explorer only)");
  process.exit(0);
}

const sql = postgres(url, { prepare: false });
const lines = createInterface({
  input: createReadStream(SEED).pipe(createGunzip()),
  crlfDelay: Infinity,
});
let batch = [];
let written = 0;
let meta = null;
let guardChecked = false;
// Version guard (#3): the dataset version lives in the table comment; when
// it already matches, the 99k-row upsert is skipped — builds stop paying
// 1-2 minutes forever for an unchanged dataset.
async function checkGuard() {
  guardChecked = true;
  const [row] = await sql`SELECT obj_description('explorer_agg'::regclass) AS comment`;
  if (meta && row?.comment === meta.version) {
    console.log(`explorer-agg: already at ${meta.version} (source ${meta.source}, built ${meta.builtAt}) — skipping`);
    await sql.end();
    process.exit(0);
  }
  // Version differs (or table was never stamped): the table is a pure
  // projection of ONE dataset, so a dataset swap REPLACES — an upsert alone
  // would leave the previous month's keys behind and mix frequencies.
  await sql`DELETE FROM explorer_agg`;
}
async function flush() {
  if (batch.length === 0) return;
  const rows = batch;
  batch = [];
  await sql`
    INSERT INTO explorer_agg (epd, rating_band, speed, move_uci, white, draws, black)
    SELECT * FROM jsonb_to_recordset(${sql.json(rows)})
      AS t(epd text, rating_band text, speed text, move_uci text, white int, draws int, black int)
    ON CONFLICT (epd, rating_band, speed, move_uci)
    DO UPDATE SET white = EXCLUDED.white, draws = EXCLUDED.draws, black = EXCLUDED.black`;
  written += rows.length;
}
for await (const line of lines) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.meta) {
    meta = row.meta;
    await checkGuard();
    continue;
  }
  if (!guardChecked) await checkGuard(); // legacy file without meta line
  batch.push({
    epd: row.epd,
    rating_band: row.band,
    speed: row.speed,
    move_uci: row.uci,
    white: row.w,
    draws: row.d,
    black: row.b,
  });
  if (batch.length >= 2000) await flush();
}
await flush();
if (meta) {
  await sql`SELECT set_config('app.dummy', '', true)`;
  await sql.unsafe(`COMMENT ON TABLE explorer_agg IS '${meta.version.replaceAll("'", "''")}'`);
}
const [{ count }] = await sql`SELECT count(*)::int AS count FROM explorer_agg`;
console.log(`explorer-agg: upserted ${written} (source ${meta?.source ?? "unversioned"}), table now holds ${count} rows`);
await sql.end();
process.exit(0);
