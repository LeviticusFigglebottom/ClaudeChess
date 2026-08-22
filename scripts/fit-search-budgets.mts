/**
 * Fit §3.3 watchdog budgets from MEASUREMENT: run the vendored engine
 * serially over positions sampled from the real gate dataset (openings
 * through endgames) at each search shape the pool actually uses, and report
 * p50/p95/p99 wall-clock per shape. The budget constant is ceil(p99 × 3)
 * rounded to the second. Checkpoints per sample (JSONL append) — resumable.
 *
 *   npx tsx scripts/fit-search-budgets.mts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { ServerEngine } from "../src/lib/engine/server";

const OUT = "data/search-budget-samples.jsonl";
const SHAPES: { depth: number; multipv: number; n: number }[] = [
  { depth: 18, multipv: 3, n: 120 },
  { depth: 16, multipv: 1, n: 120 },
  { depth: 24, multipv: 3, n: 40 },
  { depth: 24, multipv: 5, n: 40 },
];

const client = postgres(process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit", { prepare: false });

async function main() {
  const done = new Map<string, number>();
  if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { shape: string };
      done.set(row.shape, (done.get(row.shape) ?? 0) + 1);
    }
  }
  // Deterministic sample: ordered by md5 of id so re-runs see the same set.
  const fens = await client`
    SELECT p.fen_before AS fen FROM plies p
    JOIN games g ON g.id = p.game_id JOIN users u ON u.id = g.user_id
    WHERE u.handle = 'gate-phase2' AND g.variant = 'standard'
    ORDER BY md5(p.id::text) LIMIT 150`;
  const engine = new ServerEngine("standard");
  await engine.init({ hashMb: 128 });

  for (const shape of SHAPES) {
    const key = `${shape.depth}:${shape.multipv}`;
    const already = done.get(key) ?? 0;
    for (let index = already; index < shape.n; index++) {
      const fen = fens[index % fens.length]!.fen as string;
      const t0 = Date.now();
      await engine.analyze(fen, [], {
        depth: shape.depth,
        multipv: shape.multipv,
        maxMs: 300_000, // measurement pass: no budget, we ARE the budget source
      });
      const ms = Date.now() - t0;
      appendFileSync(OUT, JSON.stringify({ shape: key, ms }) + "\n");
      process.stderr.write(`\r${key} ${index + 1}/${shape.n} (${ms}ms)   `);
    }
    process.stderr.write("\n");
  }
  engine.quit();

  // Report.
  const byShape = new Map<string, number[]>();
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { shape: string; ms: number };
    const list = byShape.get(row.shape) ?? [];
    list.push(row.ms);
    byShape.set(row.shape, list);
  }
  console.log("\nshape      n     p50      p95      p99      -> budget (ceil(p99*3), s-rounded)");
  for (const [shape, list] of byShape) {
    list.sort((a, b) => a - b);
    const q = (p: number) => list[Math.min(list.length - 1, Math.floor(list.length * p))]!;
    const budget = Math.ceil((q(0.99) * 3) / 1000) * 1000;
    console.log(
      `${shape.padEnd(9)} ${String(list.length).padStart(3)}  ${String(q(0.5)).padStart(6)}ms ${String(q(0.95)).padStart(7)}ms ${String(q(0.99)).padStart(7)}ms  -> ${budget}ms`
    );
  }
  await client.end();
  process.exit(0);
}

await main();
