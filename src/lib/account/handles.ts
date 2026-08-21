import { AccountError } from "./types";

/**
 * Handle rules (A2.2): citext-unique in the DB, 3–20 chars here, and a
 * reserved-word list enforced at this layer where it can evolve without a
 * migration. The `guest-` prefix is reserved for system-generated anonymous
 * handles so a real user can never impersonate a guest.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,18}[a-zA-Z0-9]$/;

/** Compared lowercased. Route names, staff words, and ambiguity traps. */
export const RESERVED_HANDLES: readonly string[] = [
  "admin",
  "administrator",
  "mod",
  "moderator",
  "staff",
  "support",
  "system",
  "root",
  "gambit",
  "stockfish",
  "api",
  "play",
  "puzzles",
  "train",
  "analysis",
  "account",
  "accounts",
  "settings",
  "licenses",
  "challenge",
  "challenges",
  "friends",
  "engine-check",
  "anonymous",
  "guest",
  "everyone",
  "here",
  "me",
  "you",
  "null",
  "undefined",
];

const GENERATED_PREFIX = "guest-";

/** Throws AccountError with a user-presentable message when invalid. */
export function validateHandle(handle: string): void {
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    throw new AccountError(
      "handle_length",
      `Handles are ${HANDLE_MIN}–${HANDLE_MAX} characters.`
    );
  }
  if (!HANDLE_RE.test(handle)) {
    throw new AccountError(
      "handle_charset",
      "Handles use letters, digits, - and _, starting and ending with a letter or digit."
    );
  }
  const lower = handle.toLowerCase();
  if (RESERVED_HANDLES.includes(lower)) {
    throw new AccountError("handle_reserved", "That handle is reserved.");
  }
  if (lower.startsWith(GENERATED_PREFIX)) {
    throw new AccountError(
      "handle_reserved",
      `Handles starting with "${GENERATED_PREFIX}" are reserved for guests.`
    );
  }
}

/** Unambiguous lowercase alphabet (no 0/o/1/l/i). */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomSuffix(length: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return out;
}

/** e.g. "guest-k4mtw9" — for anonymous first visits (A2.1). */
export function generateGuestHandle(random: () => number = Math.random): string {
  return `${GENERATED_PREFIX}${randomSuffix(6, random)}`;
}

/** Fallback handle for a permanent signup that did not pick one. */
export function generatePlayerHandle(random: () => number = Math.random): string {
  return `player-${randomSuffix(6, random)}`;
}
