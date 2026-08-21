import { newPlayerRating } from "@/lib/rating/glicko2";
import {
  addResult,
  createPeriodState,
  settleIfDue,
  type RatingPeriodState,
} from "@/lib/rating/period";
import type { VariantId } from "@/lib/chess";

/**
 * Local player ratings, keyed (variant, timeControlBucket) per A1.4 —
 * localStorage until accounts land in Phase 1.5, at which point these link
 * into the `ratings` table through the anonymous→permanent conversion.
 */

export type RatingKey = `${VariantId}:${"bullet" | "blitz" | "rapid" | "classical"}`;

interface RatingsFile {
  version: 1;
  entries: Partial<Record<RatingKey, RatingPeriodState>>;
}

const STORAGE_KEY = "gambit.ratings.v1";

function load(): RatingsFile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as RatingsFile;
  } catch {
    // fall through
  }
  return { version: 1, entries: {} };
}

function save(file: RatingsFile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // storage unavailable — ratings stay session-local
  }
}

export function getRatingState(key: RatingKey): RatingPeriodState {
  const file = load();
  const state = file.entries[key] ?? createPeriodState(newPlayerRating());
  const settled = settleIfDue(state, Date.now());
  if (settled !== state) {
    file.entries[key] = settled;
    save(file);
  }
  return settled;
}

export function recordRatedGame(
  key: RatingKey,
  result: { opponentRating: number; opponentRd: number; score: number }
): RatingPeriodState {
  const file = load();
  const state = file.entries[key] ?? createPeriodState(newPlayerRating());
  const next = addResult(state, result, Date.now());
  file.entries[key] = next;
  save(file);
  return next;
}

/** Every locally cached rating state — the bootstrap seed payload (Phase 1.5). */
export function getAllRatingStates(): { variant: string; bucket: string; state: RatingPeriodState }[] {
  const file = load();
  return Object.entries(file.entries).flatMap(([key, state]) => {
    if (!state) return [];
    const [variant, bucket] = key.split(":");
    if (!variant || !bucket) return [];
    return [{ variant, bucket, state }];
  });
}

/**
 * Overwrites the local cache with a server-authoritative state (Phase 1.5:
 * once signed in — anonymous included — the server's Glicko-2 state wins;
 * localStorage is the offline cache).
 */
export function applyServerRatingState(
  variant: string,
  bucket: string,
  state: RatingPeriodState
): void {
  const file = load();
  file.entries[`${variant}:${bucket}` as RatingKey] = state;
  save(file);
}
