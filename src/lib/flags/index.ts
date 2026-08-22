/**
 * Feature flags (spec §9). The original spec shipped every trainer dark;
 * the owner overrode that (2026-08-22): the five trainers are pure
 * analysis-derived read paths with no effect on normal gameplay, so they
 * DEFAULT ON. An explicit env "0"/"false" still force-disables one
 * deployment-wide (kill switch); FF_VARIANTS (adds live-play queue modes)
 * and FF_MAIA (unbuilt) keep the original default-off contract.
 *
 * NEXT_PUBLIC_* vars are statically inlined by Next at build time, so each
 * flag must be referenced literally — no dynamic `process.env[name]`
 * lookups.
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

/** Default-on unless explicitly disabled ("0"/"false"). */
function onUnlessDisabled(value: string | undefined): boolean {
  return !(value === "0" || value === "false");
}

const flagValues: Record<FeatureFlag, boolean> = {
  FF_VARIANTS: on(process.env.NEXT_PUBLIC_FF_VARIANTS),
  FF_CALIBRATION: onUnlessDisabled(process.env.NEXT_PUBLIC_FF_CALIBRATION),
  FF_FINGERPRINT: onUnlessDisabled(process.env.NEXT_PUBLIC_FF_FINGERPRINT),
  FF_TEMPO: onUnlessDisabled(process.env.NEXT_PUBLIC_FF_TEMPO),
  FF_REPERTOIRE: onUnlessDisabled(process.env.NEXT_PUBLIC_FF_REPERTOIRE),
  FF_POSTMORTEM: onUnlessDisabled(process.env.NEXT_PUBLIC_FF_POSTMORTEM),
  FF_MAIA: on(process.env.NEXT_PUBLIC_FF_MAIA),
};

export function isEnabled(flag: FeatureFlag): boolean {
  return flagValues[flag];
}

export function enabledFlags(): FeatureFlag[] {
  return FEATURE_FLAGS.filter((flag) => flagValues[flag]);
}
