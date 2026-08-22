/**
 * Feature flags (spec §9). Every original trainer ships behind a flag,
 * default OFF, so the clone half stays independently shippable.
 *
 * Env-driven for now; per-user DB overrides and the dev toggle panel land
 * with Phase 5. NEXT_PUBLIC_* vars are statically inlined by Next at build
 * time, so each flag must be referenced literally — no dynamic
 * `process.env[name]` lookups.
 */

export const FEATURE_FLAGS = [
  "FF_VARIANTS",
  "FF_CALIBRATION",
  "FF_FINGERPRINT",
  "FF_TEMPO",
  "FF_REPERTOIRE",
  "FF_POSTMORTEM",
  "FF_MAIA",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

function on(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

const flagValues: Record<FeatureFlag, boolean> = {
  FF_VARIANTS: on(process.env.NEXT_PUBLIC_FF_VARIANTS),
  FF_CALIBRATION: on(process.env.NEXT_PUBLIC_FF_CALIBRATION),
  FF_FINGERPRINT: on(process.env.NEXT_PUBLIC_FF_FINGERPRINT),
  FF_TEMPO: on(process.env.NEXT_PUBLIC_FF_TEMPO),
  FF_REPERTOIRE: on(process.env.NEXT_PUBLIC_FF_REPERTOIRE),
  FF_POSTMORTEM: on(process.env.NEXT_PUBLIC_FF_POSTMORTEM),
  FF_MAIA: on(process.env.NEXT_PUBLIC_FF_MAIA),
};

export function isEnabled(flag: FeatureFlag): boolean {
  return flagValues[flag];
}

export function enabledFlags(): FeatureFlag[] {
  return FEATURE_FLAGS.filter((flag) => flagValues[flag]);
}
