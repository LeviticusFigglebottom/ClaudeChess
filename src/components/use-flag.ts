"use client";

import { isEnabled, type FeatureFlag } from "@/lib/flags";
import { usePrefs } from "./prefs-context";

/**
 * §9 flag resolution: env default (build-time, ships dark) OR the user's
 * own Labs override (prefs.labs, synced to users.prefs in the DB). The
 * override can only turn features ON for that user — flags exist so
 * unfinished surfaces ship dark, not to take features away.
 */
export function useFlag(flag: FeatureFlag): boolean {
  const { prefs } = usePrefs();
  return isEnabled(flag) || prefs.labs[flag] === true;
}
