/**
 * Calibration fit (Phase 1 gate). Two modes:
 *
 * 1. --propose : read probe results (data/calibration/rev2-*.jsonl by
 *    default; override with --prefix), fit the measured-strength curve over
 *    the formula parameter family, and invert it to propose per-band params
 *    targeting nominal Elo. Writes data/calibration/proposed-params.json for
 *    the final runs.
 *
 *    The fit is SEGMENT-AWARE: §6 revision (b) changes the search shape at
 *    1600 (truth depth 14 below, 18 at or above; shallow pass tracks it), so
 *    the measured curve is two curves — one per shape. Params fitted on one
 *    shape's curve say nothing about the other, so each target band inverts
 *    only against probe points sharing its shape. Sweeps (0% or 100%) carry
 *    no point estimate and are excluded from the inversion nodes.
 *
 * 2. --finalize: read final results (data/calibration/final-*.jsonl, played
 *    at the proposed params), compute measured Elo + CI per band (direct
 *    UCI_Elo anchors; ladder bands combine estimates and inherit anchor
 *    uncertainty), and write src/lib/engine/bot-calibration.json. Amended
 *    gate: direct bands must land within ±75 of nominal, chained bands
 *    report their measured CI with an anchor tag; ≥150 games everywhere.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clamp } from "../src/lib/eval/winprob";
import { combineEstimates, eloDiffFromScore, eloFromMatch } from "../src/lib/rating/elo";

const BANDS = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200];
const DIRECT_ANCHOR: Record<number, number> = {
  1000: 1320,
  1200: 1320,
  1400: 1400,
  1600: 1600,
  1800: 1800,
  2000: 2000,
  2200: 2200,
};

/**
 * The spec §6 formula family extended beyond its clamps so the inverse fit
 * can target strengths outside the family's nominal range (the formula runs
 * strong at every band; the true 600 needs params weaker than formula-600).
 */
function extendedParams(r: number): { pBlunder: number; temperature: number } {
  return {
    pBlunder: clamp(0.45 - (r - 600) / 3000, 0.02, 0.6),
    temperature: clamp(6.0 - (r - 600) / 300, 0.15, 12),
  };
}

interface GameRecord {
  score: number;
  opponent: string;
  botParams: { pBlunder: number; temperature: number };
}

function readGames(file: string): GameRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GameRecord);
}

function matchStats(games: GameRecord[]): { points: number; n: number } {
  return {
    points: games.reduce((sum, game) => sum + game.score, 0),
    n: games.length,
  };
}

const mode = process.argv.includes("--finalize") ? "finalize" : "propose";
const dir = path.resolve("data/calibration");

if (mode === "propose") {
  const prefixIndex = process.argv.indexOf("--prefix");
  const prefix = prefixIndex === -1 ? "rev2-" : (process.argv[prefixIndex + 1] ?? "rev2-");

  // Measured strength of the FORMULA params at each probed band. The anchor
  // comes from each shard's own opponent field (probes below 1320 play the
  // UCI_Elo floor, not their nominal). Ladder shards (bot opponents) cannot
  // anchor a fit and are skipped.
  interface ProbePoint {
    formulaRating: number;
    measured: number;
    ci95: number;
    score: number;
    games: number;
    anchor: number;
    segment: "d14" | "d18";
    sweep: boolean;
  }
  const segmentOf = (band: number): "d14" | "d18" => (band < 1600 ? "d14" : "d18");
  const points: ProbePoint[] = [];
  for (const band of BANDS) {
    const games = readGames(path.join(dir, `${prefix}${band}.jsonl`));
    if (games.length === 0) continue;
    const anchorMatch = games[0]!.opponent.match(/^sf-elo-(\d+)$/);
    if (!anchorMatch) continue;
    const anchor = Number(anchorMatch[1]);
    const { points: pts, n } = matchStats(games);
    const estimate = eloFromMatch(anchor, pts, n);
    points.push({
      formulaRating: band,
      measured: estimate.elo,
      ci95: estimate.ci95,
      score: pts,
      games: n,
      anchor,
      segment: segmentOf(band),
      // Shutouts carry no point estimate (only a rule-of-three bound) and
      // must not become inversion nodes.
      sweep: pts === 0 || pts === n,
    });
  }
  points.sort((a, b) => a.formulaRating - b.formulaRating);

  console.log(`probe measurements (${prefix}*.jsonl, formula params → measured Elo):`);
  for (const point of points) {
    if (point.sweep) {
      const bound =
        point.score === 0
          ? `≤ ~${Math.round(point.anchor + eloDiffFromScore(3 / point.games))}`
          : `≥ ~${Math.round(point.anchor - eloDiffFromScore(3 / point.games))}`;
      console.log(
        `  formula-${point.formulaRating} [${point.segment}]: ${point.score}/${point.games} sweep — no point estimate (${bound} at 95%, rule of three); excluded from fit`
      );
    } else {
      console.log(
        `  formula-${point.formulaRating} [${point.segment}]: measured ~${Math.round(point.measured)} ±${Math.round(point.ci95)} (${point.score}/${point.games} vs SF@${point.anchor})`
      );
    }
  }

  // Per-segment shift-first fit: model measured(r) = r + c within the shape
  // segment; fall back to piecewise-linear inversion (with edge extrapolation
  // on the nearest pair's slope) when residuals demand curvature.
  const proposal: Record<
    string,
    { pBlunder: number; temperature: number; formulaEquivalent: number; segment: string; extrapolated: boolean }
  > = {};
  const fitMeta: Record<string, unknown> = {};
  for (const segment of ["d14", "d18"] as const) {
    const nodes = points.filter((point) => point.segment === segment && !point.sweep);
    if (nodes.length < 2) {
      console.error(`segment ${segment}: need at least two non-sweep probe points, have ${nodes.length}`);
      process.exit(1);
    }
    const shift =
      nodes.reduce((sum, point) => sum + (point.measured - point.formulaRating), 0) / nodes.length;
    const residuals = nodes.map((point) => ({
      band: point.formulaRating,
      residual: Math.round(point.measured - point.formulaRating - shift),
    }));
    const maxResidual = Math.max(...residuals.map((r) => Math.abs(r.residual)));
    const useShift = maxResidual <= 60;
    console.log(
      `\n${segment} segment: constant shift c=+${Math.round(shift)}; residuals ${residuals
        .map((r) => `${r.band}:${r.residual >= 0 ? "+" : ""}${r.residual}`)
        .join(" ")} (max |${maxResidual}|) → ${useShift ? "shift fit" : "piecewise inversion (curvature demanded)"}`
    );

    const low = nodes[0]!;
    const high = nodes[nodes.length - 1]!;
    const invert = (target: number): number => {
      if (useShift) return target - shift;
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i]!;
        const b = nodes[i + 1]!;
        if ((target >= a.measured && target <= b.measured) || (target <= a.measured && target >= b.measured)) {
          const t = (target - a.measured) / (b.measured - a.measured || 1);
          return a.formulaRating + t * (b.formulaRating - a.formulaRating);
        }
      }
      if (target < Math.min(low.measured, high.measured)) {
        const next = nodes[1]!;
        const slope = (next.formulaRating - low.formulaRating) / (next.measured - low.measured || 1);
        return low.formulaRating + (target - low.measured) * slope;
      }
      const prev = nodes[nodes.length - 2]!;
      const slope = (high.formulaRating - prev.formulaRating) / (high.measured - prev.measured || 1);
      return high.formulaRating + (target - high.measured) * slope;
    };

    for (const band of BANDS.filter((b) => segmentOf(b) === segment)) {
      const rStar = invert(band);
      const params = extendedParams(rStar);
      const extrapolated = band < Math.min(low.measured, high.measured) || band > Math.max(low.measured, high.measured);
      proposal[String(band)] = {
        ...params,
        formulaEquivalent: Math.round(rStar),
        segment,
        extrapolated,
      };
      console.log(
        `  target ${band} → r*=${Math.round(rStar)} → T=${params.temperature.toFixed(2)} pB=${params.pBlunder.toFixed(3)}${extrapolated ? "  (extrapolated beyond the segment's measured range)" : ""}`
      );
    }
    fitMeta[segment] = {
      method: useShift ? "constant-shift" : "piecewise",
      shift: Math.round(shift),
      maxResidual,
      nodes: nodes.map((node) => ({
        formulaRating: node.formulaRating,
        measured: Math.round(node.measured),
        ci95: Math.round(node.ci95),
        games: node.games,
      })),
    };
  }

  writeFileSync(
    path.join(dir, "proposed-params.json"),
    JSON.stringify({ probePrefix: prefix, fit: fitMeta, bands: proposal }, null, 2) + "\n"
  );
  console.log("\nwrote data/calibration/proposed-params.json");
} else {
  // Finalize: direct bands first (their measured Elo anchors the ladder).
  interface BandResult {
    pBlunder: number;
    temperature: number;
    measuredElo: number;
    ci95: number;
    games: number;
    anchors: string[];
    /** Gate amendment: how this band is anchored — chained bands report CI, not ±75. */
    anchor: "direct" | "chained(1)" | "chained(2)";
  }
  const proposed = JSON.parse(readFileSync(path.join(dir, "proposed-params.json"), "utf8")) as {
    bands: Record<string, { pBlunder: number; temperature: number }>;
  };
  const results: Record<string, BandResult> = {};

  const finalGames = (band: number) => readGames(path.join(dir, `final-${band}.jsonl`));

  for (const band of BANDS.filter((b) => DIRECT_ANCHOR[b])) {
    const games = finalGames(band);
    const anchor = DIRECT_ANCHOR[band]!;
    const { points, n } = matchStats(games);
    if (n === 0) continue;
    const estimate = eloFromMatch(anchor, points, n);
    const params = proposed.bands[String(band)]!;
    results[String(band)] = {
      pBlunder: params.pBlunder,
      temperature: params.temperature,
      measuredElo: Math.round(estimate.elo),
      ci95: Math.round(estimate.ci95),
      games: n,
      anchors: [`sf-elo-${anchor}@400ms`],
      anchor: "direct",
    };
  }

  // Ladder bands: opponents are calibrated bots; combine every opponent's
  // match into one estimate, inheriting the opponent-anchor uncertainty.
  for (const band of [800, 600]) {
    const games = finalGames(band);
    if (games.length === 0) continue;
    const byOpponent = new Map<string, GameRecord[]>();
    for (const game of games) {
      const list = byOpponent.get(game.opponent) ?? [];
      list.push(game);
      byOpponent.set(game.opponent, list);
    }
    const estimates: { elo: number; ci95: number; anchorCi95?: number }[] = [];
    const anchors: string[] = [];
    for (const [opponent, matchGames] of byOpponent) {
      const { points, n } = matchStats(matchGames);
      let anchorElo: number;
      let anchorCi: number | undefined;
      const botMatch = opponent.match(/^bot-(\d+)$/);
      if (botMatch) {
        const anchorBand = results[botMatch[1]!];
        if (!anchorBand) {
          console.error(`ladder band ${band} needs calibrated opponent ${opponent} first`);
          process.exit(1);
        }
        anchorElo = anchorBand.measuredElo;
        anchorCi = anchorBand.ci95;
      } else {
        anchorElo = Number(opponent.replace("sf-elo-", ""));
      }
      const estimate = eloFromMatch(anchorElo, points, n);
      estimates.push({ elo: estimate.elo, ci95: estimate.ci95, anchorCi95: anchorCi });
      anchors.push(`${opponent} (${n}g)`);
    }
    const combined = combineEstimates(estimates);
    const params = proposed.bands[String(band)]!;
    results[String(band)] = {
      pBlunder: params.pBlunder,
      temperature: params.temperature,
      measuredElo: Math.round(combined.elo),
      ci95: Math.round(combined.ci95),
      games: games.length,
      anchors,
      anchor: band === 600 ? "chained(2)" : "chained(1)",
    };
  }

  // Amended gate: direct bands must land within ±75 of nominal; chained bands
  // report their measured CI and are never claimed to a tolerance they did
  // not meet. Minimum 150 games everywhere.
  console.log("\nband | anchor     | games | measured | CI95 | Δ nominal | verdict");
  let allPass = true;
  for (const band of BANDS) {
    const result = results[String(band)];
    if (!result) {
      console.log(`${band}  | MISSING`);
      allPass = false;
      continue;
    }
    const delta = result.measuredElo - band;
    let verdict: string;
    if (result.games < 150) {
      verdict = "FAIL (games<150)";
      allPass = false;
    } else if (result.anchor === "direct") {
      const pass = Math.abs(delta) <= 75;
      verdict = pass ? "PASS (±75)" : "FAIL (±75)";
      if (!pass) allPass = false;
    } else {
      verdict = `CHAINED (±${result.ci95} reported)`;
    }
    console.log(
      `${String(band).padEnd(4)} | ${result.anchor.padEnd(10)} | ${String(result.games).padStart(5)} | ${String(result.measuredElo).padStart(8)} | ±${String(result.ci95).padEnd(3)} | ${delta >= 0 ? "+" : ""}${String(delta).padStart(3)}      | ${verdict}`
    );
  }

  const output = {
    method:
      "Fitted from self-play vs Stockfish 18 Lite UCI_LimitStrength anchors at 400ms/move (bands 1000-2200 direct; 1320 floor for 1000/1200) and calibrated-bot ladder opponents for 800/600. Adjudication: forced mate <=6, dead draws, 140-ply cap. Bot side runs the exact shipping policy (revised section 6: band-scaled MultiPV 4-24, truth depth 14 below 1600 / 18 at or above, shallow pass 12 plies behind truth at the same MultiPV) on the shipping engine. Params fitted segment-aware per search shape.",
    referenceMovetimeMs: 400,
    fittedAt: new Date().toISOString(),
    bands: Object.fromEntries(
      BANDS.map((band) => {
        const result = results[String(band)];
        return [
          String(band),
          result
            ? {
                pBlunder: result.pBlunder,
                temperature: result.temperature,
                measuredElo: result.measuredElo,
                ci95: result.ci95,
                games: result.games,
                anchors: result.anchors,
                anchor: result.anchor,
              }
            : null,
        ];
      })
    ),
  };
  writeFileSync(
    path.resolve("src/lib/engine/bot-calibration.json"),
    JSON.stringify(output, null, 2) + "\n"
  );
  console.log(`\nwrote src/lib/engine/bot-calibration.json — ${allPass ? "ALL BANDS PASS" : "FAILURES PRESENT"}`);
  process.exit(allPass ? 0 : 1);
}
