/**
 * Policy-v2 organic band measurement (the v2 gate math): reads an arena
 * JSONL played against ONE known-Elo opponent, estimates the band's Elo
 * (src/lib/rating/elo.ts — same math as v1 and the ruler audit), and with
 * --finalize writes the measurement AND the exact params the games used
 * into bot-calibration-v2.json (file = measured config, by construction).
 *
 *   npx tsx scripts/fit-organic.mts --band 1200 \
 *       --jsonl data/calibration/v2-b1200.jsonl --anchor-elo 1320 \
 *       --anchor-label sf-elo-1320@400ms --anchor-kind direct [--finalize]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { eloFromMatch } from "../src/lib/rating/elo";

const get = (flag: string): string | undefined => {
  const index = process.argv.indexOf(`--${flag}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const band = get("band");
const jsonl = get("jsonl");
const anchorElo = Number(get("anchor-elo"));
const anchorLabel = get("anchor-label") ?? `elo-${anchorElo}`;
const anchorKind = get("anchor-kind") ?? "direct";
/** Chained links: the anchor bot's own ±ci95, combined in quadrature so a
 * chained band's ci95 reports TOTAL uncertainty (v1 convention — 600's
 * ±111 was match ⊕ anchor). Omit for engine-reference anchors. */
const anchorCi = get("anchor-ci") ? Number(get("anchor-ci")) : 0;
if (!band || !jsonl || !anchorElo) {
  throw new Error("--band, --jsonl, --anchor-elo required");
}

const records = readFileSync(jsonl, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (records.length === 0) throw new Error("empty JSONL");

// The params the games actually used must be uniform — a mixed file would
// average incomparable configs.
const paramsKey = (r: { botParams: Record<string, unknown> }) => JSON.stringify(r.botParams);
const firstKey = paramsKey(records[0]);
const mixed = records.filter((r) => paramsKey(r) !== firstKey).length;
if (mixed > 0) {
  throw new Error(`JSONL mixes ${mixed} records with different botParams — refuse to fit`);
}
const usedParams = records[0].botParams;

const points = records.reduce((sum: number, r: { score: number }) => sum + r.score, 0);
const estimate = eloFromMatch(anchorElo, points, records.length);
const totalCi = Math.sqrt(estimate.ci95 ** 2 + anchorCi ** 2);
const byReason: Record<string, number> = {};
for (const r of records) byReason[r.endReason] = (byReason[r.endReason] ?? 0) + 1;

console.log(`band ${band} vs ${anchorLabel} (${anchorElo})`);
console.log(`  games ${records.length}, score ${points} (${(estimate.score * 100).toFixed(1)}%)`);
console.log(
  `  measured ${Math.round(estimate.elo)} ±${Math.round(totalCi)}` +
    (anchorCi > 0 ? ` (match ±${Math.round(estimate.ci95)} ⊕ anchor ±${anchorCi})` : "")
);
console.log(`  params ${JSON.stringify(usedParams)}`);
console.log(`  ends ${JSON.stringify(byReason)}`);

if (process.argv.includes("--finalize")) {
  const file = "src/lib/engine/bot-calibration-v2.json";
  const calibration = JSON.parse(readFileSync(file, "utf8"));
  const entry = calibration.bands[band];
  if (!entry) throw new Error(`band ${band} missing in ${file}`);
  if (usedParams.kind === "limitStrength") {
    entry.method = "sf-limitstrength";
    entry.uciElo = usedParams.uciElo;
    entry.nodes = usedParams.nodes;
    delete entry.depth;
    delete entry.multipv;
    delete entry.temperature;
  } else {
    entry.method = "organic";
    entry.depth = usedParams.depth;
    entry.multipv = usedParams.multipv;
    entry.temperature = usedParams.temperature;
    delete entry.uciElo;
    delete entry.nodes;
  }
  entry.measuredElo = Math.round(estimate.elo);
  entry.ci95 = Math.round(totalCi);
  entry.games = records.length;
  entry.anchor = anchorKind;
  entry.anchors = [`${anchorLabel} (${records.length}g)`];
  writeFileSync(file, JSON.stringify(calibration, null, 2) + "\n");
  console.log(`finalized ${band} into ${file}`);
}
