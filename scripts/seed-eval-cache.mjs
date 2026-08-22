/**
 * Idempotent, version-guarded seed for the GLOBAL eval cache. Every row in
 * the committed dataset is server-computed (scripts/build-eval-seed.mts);
 * a version change REPLACES previous seed rows but never touches organic
 * source='server' rows. Runs inside migrate-deploy on Vercel builds.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

const SEED = "src/db/seed/eval-cache.jsonl.gz";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — see .env.example");
  process.exit(1);
}
if (!existsSync(SEED)) {
  console.log("eval-cache: no committed seed — skipping (global cache grows organically only)");
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

async function checkGuard() {
  const [row] = await sql`SELECT obj_description('eval_cache_global'::regclass) AS comment`;
  const storedVersion = row?.comment ? row.comment.split(" | ")[0] : null;
  if (meta && storedVersion === meta.version) {
    console.log(`eval-cache: already at ${meta.version} — skipping`);
    await sql.end();
    process.exit(0);
  }
  // Replace SEED rows only; organic server-computed rows stay.
  await sql`DELETE FROM eval_cache_global WHERE source = 'seed'`;
}

async function flush() {
  if (batch.length === 0) return;
  const rows = batch;
  batch = [];
  await sql`
    INSERT INTO eval_cache_global (variant, epd, depth, multipv, lines, source)
    SELECT 'standard', t.epd, ${meta.depth}, ${meta.multipv}, t.lines, 'seed'
    FROM jsonb_to_recordset(${sql.json(rows)}) AS t(epd text, lines jsonb)
    ON CONFLICT (variant, epd, depth, multipv) DO NOTHING`;
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
  batch.push({ epd: row.epd, lines: row.lines });
  if (batch.length >= 500) await flush();
}
if (!meta) {
  console.log("eval-cache: seed has no meta line — refusing to guess, skipping");
  await sql.end();
  process.exit(0);
}
await flush();
await sql.unsafe(`COMMENT ON TABLE eval_cache_global IS '${meta.version.replaceAll("'", "''")}'`);
const [{ count }] = await sql`SELECT count(*)::int AS count FROM eval_cache_global`;
console.log(`eval-cache: seeded ${written} rows (${meta.version}), table now holds ${count}`);
await sql.end();
process.exit(0);
