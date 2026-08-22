/**
 * Offline builder for the GLOBAL eval-cache seed: the server engine — and
 * only the server engine — evaluates the most-reached opening positions
 * (ranked by real game counts from the self-hosted explorer aggregate) at
 * the review shape d18:MultiPV 3 under the fitted §3.3 budgets. Every row
 * in the committed seed is therefore server-computed by construction; the
 * global cache's trust model starts here.
 *
 * Checkpointed per position (JSONL append) — resumable.
 *
 *   npx tsx scripts/build-eval-seed.mts [--top 2000] [--out src/db/seed/eval-cache.jsonl.gz]
 */
import { appendFileSync, createWriteStream, existsSync, readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import postgres from "postgres";
import { AnalysisPool } from "../src/lib/analysis/pool";
import { budgetForMs } from "../src/lib/analysis/budgets";
import { GamePosition } from "../src/lib/chess/position";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1]! : fallback;
};
const TOP = Number(flag("--top", "2000"));
const OUT = flag("--out", "src/db/seed/eval-cache.jsonl.gz");
const CHECKPOINT = "data/eval-seed-progress.jsonl";
const DEPTH = 18;
const MULTIPV = 3;

const client = postgres(process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit", { prepare: false });

async function main() {
  const [meta] = await client`SELECT obj_description('explorer_agg'::regclass) AS comment`;
  const aggregateVersion = (meta?.comment as string | null)?.split(" | ")[0] ?? "unknown-aggregate";

  const epds = await client`
    SELECT epd, sum(white+draws+black)::bigint AS games
    FROM explorer_agg GROUP BY epd ORDER BY games DESC, epd LIMIT ${TOP}`;
  console.log(`${epds.length} candidate positions (top ${TOP} by game count, aggregate ${aggregateVersion})`);

  const done = new Set<string>(
    existsSync(CHECKPOINT)
      ? readFileSync(CHECKPOINT, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { epd: string }).epd)
      : []
  );
  const pending = epds.filter((row) => !done.has(row.epd as string));
  console.log(`${pending.length} to search (${done.size} checkpointed)`);

  const pool = new AnalysisPool({ cap: 3, hashMb: 128 });
  let index = 0;
  let searched = 0;
  let skipped = 0;
  const worker = async () => {
    for (;;) {
      const my = index++;
      if (my >= pending.length) return;
      const epd = pending[my]!.epd as string;
      const fen = `${epd} 0 1`;
      try {
        const position = GamePosition.fromFen(fen, "standard");
        if (position.outcome() !== null || position.isStalemate()) {
          skipped++;
          continue;
        }
      } catch {
        skipped++;
        continue;
      }
      try {
        const result = await pool.withEngine("standard", (engine) =>
          engine.analyze(fen, [], { depth: DEPTH, multipv: MULTIPV, maxMs: budgetForMs(DEPTH, MULTIPV) })
        );
        if (result.breach !== "none" || result.infos.length === 0) {
          skipped++;
          continue;
        }
        const lines = result.infos.map((info) => ({
          multipv: info.multipv,
          depth: info.depth,
          scoreCp: info.scoreCp,
          mateIn: info.mateIn,
          pv: info.pv.slice(0, 32),
        }));
        appendFileSync(CHECKPOINT, JSON.stringify({ epd, lines }) + "\n");
        searched++;
        if (searched % 50 === 0) process.stderr.write(`\r${searched + done.size}/${epds.length}   `);
      } catch {
        skipped++;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  pool.shutdown();
  process.stderr.write("\n");
  console.log(`searched ${searched}, skipped ${skipped}, total checkpointed ${done.size + searched}`);

  // Write the committed seed from the full checkpoint.
  const rows = readFileSync(CHECKPOINT, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { epd: string; lines: unknown[] });
  const wanted = new Set(epds.map((row) => row.epd as string));
  const gzip = createGzip({ level: 9 });
  const sink = createWriteStream(OUT);
  gzip.pipe(sink);
  const version = `evalseed:${aggregateVersion}:top${TOP}:d${DEPTH}mp${MULTIPV}`;
  gzip.write(
    JSON.stringify({
      meta: {
        source: `server-computed over ${aggregateVersion} top-${TOP} positions`,
        depth: DEPTH,
        multipv: MULTIPV,
        builtAt: new Date().toISOString().slice(0, 10),
        version,
      },
    }) + "\n"
  );
  let written = 0;
  for (const row of rows) {
    if (!wanted.has(row.epd)) continue;
    gzip.write(JSON.stringify(row) + "\n");
    written++;
  }
  await new Promise<void>((resolve) => {
    gzip.end();
    sink.on("finish", () => resolve());
  });
  console.log(`wrote ${written} rows → ${OUT} (version ${version})`);
  await client.end();
  process.exit(0);
}

await main();
