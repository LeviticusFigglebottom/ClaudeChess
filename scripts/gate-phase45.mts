/**
 * Phase 4.5 gate evidence — the two variant-rule implementations must agree
 * and the analysis path must produce sane variant evals:
 *
 *  1. perft cross-check: chessops (rules facade) vs Fairy-Stockfish
 *     `go perft` on three-check and King-of-the-Hill positions where the
 *     variant rules PRUNE the tree (a delivered third check / a centered
 *     king ends the game), so vanilla-chess perft would disagree — the
 *     cross-check is meaningful, same method as gate G2.
 *  2. ServerEngine smoke: init({variant}) routes to the vendored Fairy
 *     build, evaluates a position in each variant, and still REFUSES
 *     crazyhouse (A1.3 invariant).
 *
 *   npx tsx scripts/gate-phase45.mts
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { GamePosition } from "../src/lib/chess/position";
import type { VariantId } from "../src/lib/chess/variant";
import { ServerEngine } from "../src/lib/engine/server";

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

const FAIRY_CLI = path.resolve(process.cwd(), "public", "engine", "fairy", "fairy-uci.cjs");
const FAIRY_NAME: Record<string, string> = { threecheck: "3check", koth: "kingofthehill" };

function fairyPerft(variant: string, fen: string, depth: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAIRY_CLI], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("fairy perft timeout"));
    }, 120_000);
    child.stdin.on("error", () => undefined); // EPIPE after self-exit is fine
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/Nodes searched\s*:\s*(\d+)/);
      if (match) {
        clearTimeout(timer);
        child.kill();
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      `setoption name UCI_Variant value ${FAIRY_NAME[variant] ?? variant}\n` +
        `position fen ${fen}\ngo perft ${depth}\n`
    );
  });
}

/**
 * Positions chosen so variant ends occur INSIDE the perft horizon:
 * three-check with both sides one check from winning and checks available;
 * KotH with both kings a move or two from the center.
 */
const CASES: { variant: VariantId; fen: string; depth: number }[] = [
  {
    variant: "threecheck",
    // One check each to win; queens and open lines — checks inside depth 3.
    fen: "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 1+1 0 6",
    depth: 3,
  },
  {
    variant: "threecheck",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2+3 0 2",
    depth: 4,
  },
  {
    variant: "koth",
    // Kings marching — e4/d4/e5/d5 reachable within the horizon.
    fen: "8/2k5/8/3p4/3P4/4K3/8/8 w - - 0 1",
    depth: 4,
  },
  {
    variant: "koth",
    // Kings one step off the hill — center reached at ply 1 inside the tree.
    fen: "1nbq1bn1/pppp1ppp/3k4/4p3/4P3/3K4/PPPP1PPP/1NBQ1BN1 w - - 0 1",
    depth: 3,
  },
];

async function main() {
  for (const { variant, fen, depth } of CASES) {
    const ours = GamePosition.fromFen(fen, variant).perft(depth);
    const theirs = await fairyPerft(variant, fen, depth);
    record(
      `perft(${depth}) agreement — ${variant}`,
      ours === theirs,
      `${fen} → chessops=${ours} fairy=${theirs}`
    );
  }

  // --- ServerEngine routing smoke ---
  for (const variant of ["threecheck", "koth"] as VariantId[]) {
    const engine = new ServerEngine(variant);
    await engine.init({ hashMb: 32 });
    const result = await engine.analyze(
      variant === "threecheck"
        ? "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 1+1 0 6"
        : "1nbq1bn1/pppp1ppp/3k4/4p3/4P3/3K4/PPPP1PPP/1NBQ1BN1 w - - 0 1",
      [],
      { depth: 12, multipv: 2, maxMs: 30_000 }
    );
    engine.quit();
    const pv1 = result.infos[0];
    record(
      `ServerEngine evaluates ${variant} through the Fairy build`,
      Boolean(pv1 && pv1.pv.length > 0 && (pv1.scoreCp !== null || pv1.mateIn !== null)),
      pv1
        ? `depth ${pv1.depth}, score ${pv1.mateIn !== null ? `#${pv1.mateIn}` : pv1.scoreCp}, pv ${pv1.pv.slice(0, 3).join(" ")}`
        : "no line produced"
    );
  }

  // --- refusal invariant intact ---
  try {
    await new ServerEngine("crazyhouse").init({ hashMb: 16 });
    record("crazyhouse still refused (A1.3)", false, "init unexpectedly succeeded");
  } catch (error) {
    record(
      "crazyhouse still refused (A1.3)",
      true,
      (error as Error).message.slice(0, 90)
    );
  }

  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} gate checks pass`);
  process.exit(failed.length ? 1 : 0);
}

await main();
