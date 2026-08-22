/**
 * C4 gate evidence: SEE vs the exhaustive reference on 1000 random capture
 * positions (random legal playouts, seeded — reproducible).
 *
 *   npx tsx scripts/see-crosscheck.mts
 */
import { collectCaptureChecks } from "../src/lib/motifs/see-crosscheck";

const checks = collectCaptureChecks(1000, 0xc4c4);
const disagreements = checks.filter((check) => check.fast !== check.reference);
console.log(`SEE cross-check: ${checks.length} random capture positions`);
console.log(`agreements: ${checks.length - disagreements.length}`);
console.log(`disagreements: ${disagreements.length}`);
for (const d of disagreements.slice(0, 10)) {
  console.log(`  ${d.fen} ${d.uci}: swap=${d.fast} reference=${d.reference}`);
}
process.exit(disagreements.length === 0 ? 0 : 1);
