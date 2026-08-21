/**
 * Asset manifest (B2.5): every piece set, board theme, sound set, and font
 * shipped in the product carries name/author/license/sourceUrl here, and
 * /licenses renders this list. A test walks /public and rejects any asset
 * directory without a manifest entry — no asset lands without one.
 */

export interface AssetManifestEntry {
  id: string;
  kind: "piece-set" | "board-theme" | "sound-set" | "font";
  name: string;
  author: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
  /** Directory under /public this entry covers, when it ships files. */
  publicDir?: string;
  note?: string;
}

export const ASSET_MANIFEST: AssetManifestEntry[] = [
  {
    id: "cburnett",
    kind: "piece-set",
    name: "cburnett",
    author: "Colin M.L. Burnett",
    license: "CC-BY-SA-3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    sourceUrl: "https://github.com/lichess-org/lila/tree/master/public/piece/cburnett",
    publicDir: "pieces/cburnett",
    note: "Vendored unmodified from the Lichess asset repository.",
  },
  {
    id: "classic",
    kind: "piece-set",
    name: "Classic (react-chessboard)",
    author: "react-chessboard contributors (Ryan Gregory)",
    license: "MIT",
    sourceUrl: "https://github.com/Clariity/react-chessboard",
    note: "The board library's built-in set; bundled in JavaScript, no files under /public.",
  },
  {
    id: "board-themes",
    kind: "board-theme",
    name: "Tournament / Slate / Walnut / High contrast",
    author: "GAMBIT",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/LeviticusFigglebottom/ClaudeChess",
    note: "Color pairs only — no texture assets.",
  },
  {
    id: "gambit-synth",
    kind: "sound-set",
    name: "GAMBIT synthesized set",
    author: "GAMBIT (procedurally generated — scripts/build-sounds.mjs)",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/LeviticusFigglebottom/ClaudeChess",
    publicDir: "sounds/gambit",
    note: "Original event sounds synthesized from the project's tonal palette; regenerable from the script.",
  },
  {
    id: "martian-mono",
    kind: "font",
    name: "Martian Mono",
    author: "Roman Shamin, Evil Martians",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org",
    sourceUrl: "https://github.com/evilmartians/mono",
    note: "Self-hosted via @fontsource (COEP forbids cross-origin fonts).",
  },
  {
    id: "inter-tight",
    kind: "font",
    name: "Inter Tight",
    author: "Rasmus Andersson, Ivan Ukhov et al.",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org",
    sourceUrl: "https://github.com/rsms/inter",
    note: "Self-hosted via @fontsource.",
  },
];

export function manifestFor(publicDir: string): AssetManifestEntry | undefined {
  return ASSET_MANIFEST.find((entry) => entry.publicDir === publicDir);
}
