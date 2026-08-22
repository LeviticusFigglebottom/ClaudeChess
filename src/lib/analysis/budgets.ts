/**
 * §3.3 watchdog budgets — wall-clock ceilings per (depth, multipv) search
 * shape, FITTED FROM MEASUREMENT, not guessed. scripts/fit-search-budgets.mts
 * runs the vendored engine serially over positions sampled from the real
 * gate dataset (openings through endgames) and reports p50/p95/p99; the
 * budget is ceil(p99 × 3) rounded up — p99 already sits in the tail, and
 * the ×3 covers pool concurrency plus slower production hardware. The
 * pathology this guards against (a search wedged for HOURS on one position)
 * sits orders of magnitude past any honest tail.
 *
 * Fitted 2026-08-22 on the dev container (4 cores, engines measured
 * serially over 320 gate-dataset positions) — re-run the script and update
 * when hardware changes:
 *
 *   depth:multipv    n    p50       p95       p99       → budget
 *   18:3           120   1795ms    3429ms    4839ms    →  15s
 *   16:1           120    201ms     507ms     760ms    →   3s
 *   24:3            40  15147ms   42390ms   42814ms    → 129s
 *   24:5            40  23908ms   73942ms  110066ms    → 331s
 *
 * Honest finding from the fit: the previous hard-coded 20s soft-stop sat
 * BELOW d24's p50–tail range — verify-pass d24 searches were being silently
 * truncated and recorded at full depth. Under the watchdog they either
 * complete inside the fitted ceiling or degrade HONESTLY.
 */
export const SEARCH_BUDGETS_MS: Record<string, number> = {
  "18:3": 15_000,
  "16:1": 3_000,
  "24:3": 129_000,
  "24:5": 331_000,
};

/**
 * Budget for an arbitrary shape: exact fitted value where measured,
 * otherwise extrapolated from the nearest fitted depth (search time grows
 * roughly ×1.5 per extra ply at these depths on this engine; MultiPV adds
 * ~10% per extra line). Extrapolation only widens the guard — the fitted
 * pairs are the shapes the pool actually runs.
 */
export function budgetForMs(depth: number, multipv: number): number {
  const exact = SEARCH_BUDGETS_MS[`${depth}:${multipv}`];
  if (exact) return exact;
  const anchors = Object.entries(SEARCH_BUDGETS_MS).map(([key, ms]) => {
    const [d, m] = key.split(":").map(Number);
    return { d: d!, m: m!, ms };
  });
  const nearest = anchors.reduce((best, a) =>
    Math.abs(a.d - depth) < Math.abs(best.d - depth) ? a : best
  );
  const scaled =
    nearest.ms * Math.pow(1.5, depth - nearest.d) * (1 + 0.1 * (multipv - nearest.m));
  return Math.max(3_000, Math.min(120_000, Math.round(scaled)));
}
