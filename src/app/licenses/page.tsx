import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Licenses — GAMBIT",
};

/**
 * A0.2: GPL compliance surface. Stockfish binaries are distributed with this
 * site and chessops is compiled into its JavaScript — both GPL-3. This page
 * is the user-facing pointer to sources and license texts (the repository
 * NOTICE file is the canonical copy of this information).
 */
const COMPONENTS = [
  {
    name: "Stockfish 18 (Lite WASM builds)",
    license: "GNU General Public License v3.0",
    licenseUrl: "https://www.gnu.org/licenses/gpl-3.0.html",
    role: "Chess engine — evaluation and analysis. Served from /engine as unmodified binaries from the stockfish.js 18.0.8 release; NNUE nets by Linmiao Xu (linrock) and the Stockfish contributors.",
    sources: [
      { label: "Stockfish source", url: "https://github.com/official-stockfish/Stockfish" },
      { label: "WASM port (stockfish.js, Chess.com LLC / nmrugg)", url: "https://github.com/nmrugg/stockfish.js" },
    ],
  },
  {
    name: "chessops 0.15.1",
    license: "GNU General Public License v3.0 or later",
    licenseUrl: "https://www.gnu.org/licenses/gpl-3.0.html",
    role: "Rules engine — move generation, legality, FEN/SAN, Chess960 castling, variant rules. Compiled into this application's JavaScript bundle.",
    sources: [{ label: "chessops source", url: "https://github.com/lichess-org/chessops" }],
  },
  {
    name: "Lichess chess-openings dataset",
    license: "CC0 1.0 (public domain)",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    role: "ECO codes and opening names used for opening detection.",
    sources: [{ label: "chess-openings source", url: "https://github.com/lichess-org/chess-openings" }],
  },
] as const;

export default function LicensesPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-xl font-semibold">Licenses</h1>
      <p className="mb-6 text-sm text-zinc-400">
        GAMBIT ships GPL-licensed components: the Stockfish engine is distributed with the site
        and the chessops rules library is compiled into its code, so the combined work is
        distributed under GPL-3.0-or-later. Sources for the GPL components are linked below;
        this application&apos;s own source repository carries the canonical{" "}
        <span className="font-mono text-zinc-300">NOTICE</span> file.
      </p>
      <ul className="space-y-4">
        {COMPONENTS.map((component) => (
          <li key={component.name} className="rounded-lg border border-zinc-800 p-4">
            <h2 className="font-medium text-zinc-100">{component.name}</h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              <a
                href={component.licenseUrl}
                className="text-amber-400 hover:underline"
                rel="noreferrer"
                target="_blank"
              >
                {component.license}
              </a>
            </p>
            <p className="mt-2 text-sm text-zinc-400">{component.role}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {component.sources.map((source) => (
                <li key={source.url}>
                  <a
                    href={source.url}
                    className="text-zinc-300 underline decoration-zinc-700 hover:decoration-zinc-400"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {source.label}
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-xs text-zinc-600">
        Everything else (Next.js, React, react-chessboard, Drizzle, Supabase clients, Tailwind)
        is MIT/Apache-licensed; see package metadata in the repository.
      </p>
    </div>
  );
}
