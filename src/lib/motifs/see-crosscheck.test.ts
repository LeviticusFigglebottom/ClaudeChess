import { describe, expect, it } from "vitest";
import { collectCaptureChecks } from "./see-crosscheck";

/**
 * C4 gate: SEE vs an independent exhaustive reference. The full
 * 1000-position run is scripts/see-crosscheck.mts; this seeded 250-position
 * version keeps the property pinned in CI.
 */
describe("SEE cross-check (C4)", () => {
  it("agrees with the exhaustive reference on 250 seeded random captures", () => {
    const checks = collectCaptureChecks(250, 0xc4c4);
    const disagreements = checks.filter((check) => check.fast !== check.reference);
    expect(
      disagreements,
      disagreements
        .slice(0, 3)
        .map((d) => `${d.fen} ${d.uci}: fast=${d.fast} ref=${d.reference}`)
        .join("; ")
    ).toHaveLength(0);
  });
});
