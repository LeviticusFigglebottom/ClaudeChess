/**
 * User preferences (B2.5). Anonymous → localStorage; signed-in DB sync is
 * Phase 1.5 (preferences must survive the anonymous→permanent conversion).
 * Every read/write is defensive — storage can be absent or throw.
 */

export type BoardThemeId =
  | "tournament"
  | "emerald"
  | "walnut"
  | "slate"
  | "ice"
  | "amethyst"
  | "high-contrast";
export type PieceSetId = "classic" | "cburnett" | "merida" | "chessnut" | "fantasy";
export type AnimationPref = "instant" | "fast" | "normal" | "slow";

export const SOUND_EVENTS = [
  "move",
  "capture",
  "castle",
  "check",
  "promote",
  "premove-set",
  "illegal",
  "low-time",
  "game-start",
  "game-end-win",
  "game-end-draw",
  "game-end-loss",
] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export interface Prefs {
  boardTheme: BoardThemeId;
  pieceSet: PieceSetId;
  /** react-chessboard v4 supports show/hide only; inside/outside when the board component can. */
  coordinates: "on" | "off";
  sound: {
    master: number; // 0..1
    muted: boolean;
    perEventMuted: Partial<Record<SoundEvent, boolean>>;
  };
  animation: AnimationPref;
  moveList: "san" | "figurine";
  evalBar: { show: boolean; format: "cp" | "wp" | "both" };
  accessibility: {
    shapeOnlyClassifications: boolean;
    highContrastBoard: boolean;
    /** Explicit app-level reduce-motion (system prefers-reduced-motion always wins too). */
    reduceMotion: boolean;
  };
  /** §9 flag module: per-user overrides on top of the env defaults (Labs panel). */
  labs: Partial<Record<string, boolean>>;
}

export const DEFAULT_PREFS: Prefs = {
  boardTheme: "tournament",
  pieceSet: "cburnett",
  coordinates: "on",
  sound: { master: 0.7, muted: false, perEventMuted: {} },
  animation: "normal",
  moveList: "figurine",
  evalBar: { show: true, format: "cp" },
  accessibility: {
    shapeOnlyClassifications: false,
    highContrastBoard: false,
    reduceMotion: false,
  },
  labs: {},
};

/**
 * Board themes are token pairs, not textures — no asset, no license burden.
 * `highlight` is the last-move tint, chosen PER THEME for contrast against
 * both square colors (a single global tint disappears on same-hue boards).
 */
export const BOARD_THEMES: Record<
  BoardThemeId,
  { name: string; light: string; dark: string; highlight: string }
> = {
  tournament: { name: "Tournament (LCD)", light: "#e6e7e1", dark: "#9eaf96", highlight: "#e6c34a" },
  emerald: { name: "Emerald", light: "#ebecd0", dark: "#779556", highlight: "#f5f26b" },
  walnut: { name: "Walnut", light: "#ead8b7", dark: "#9a6b44", highlight: "#ffd24d" },
  slate: { name: "Slate", light: "#cbd5e0", dark: "#4a5568", highlight: "#f0b84f" },
  ice: { name: "Ice", light: "#dee3e6", dark: "#8ca2ad", highlight: "#f2c94c" },
  amethyst: { name: "Amethyst", light: "#e6dbf1", dark: "#8e6bab", highlight: "#ffd166" },
  "high-contrast": { name: "High contrast", light: "#ffffff", dark: "#1c1c1c", highlight: "#ffee00" },
};

const STORAGE_KEY = "gambit.prefs.v1";

/** Deep-merges a possibly partial/stale prefs object over the defaults. */
export function normalizePrefs(raw: unknown): Prefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_PREFS;
  const parsed = raw as Partial<Prefs>;
  return {
    ...DEFAULT_PREFS,
    ...parsed,
    sound: { ...DEFAULT_PREFS.sound, ...parsed.sound },
    evalBar: { ...DEFAULT_PREFS.evalBar, ...parsed.evalBar },
    accessibility: { ...DEFAULT_PREFS.accessibility, ...parsed.accessibility },
    labs: { ...DEFAULT_PREFS.labs, ...parsed.labs },
  };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** True when the user has an explicitly stored preference object. */
export function hasStoredPrefs(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode etc.) — prefs stay session-local.
  }
}

/** Effective board colors (accessibility high-contrast wins over theme). */
export function boardColors(prefs: Prefs): { light: string; dark: string; highlight: string } {
  const theme = prefs.accessibility.highContrastBoard
    ? BOARD_THEMES["high-contrast"]
    : // Stored prefs can name a theme id from another app version — fall
      // back rather than crash the board.
      (BOARD_THEMES[prefs.boardTheme] ?? BOARD_THEMES.tournament);
  return { light: theme.light, dark: theme.dark, highlight: theme.highlight };
}

/** Board move-animation duration in ms, mirroring the CSS motion tokens. */
export function animationMs(prefs: Prefs): number {
  if (prefs.accessibility.reduceMotion) return 0;
  switch (prefs.animation) {
    case "instant":
      return 0;
    case "fast":
      return 70;
    case "slow":
      return 280;
    default:
      return 140;
  }
}
