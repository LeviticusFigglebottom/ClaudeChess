"use client";

import { useState } from "react";
import { BOARD_THEMES, type BoardThemeId, type PieceSetId } from "@/lib/prefs/prefs";
import { isEnabled, type FeatureFlag } from "@/lib/flags";
import { GameBoard } from "./game-board";
import { PieceGlyph } from "./pieces";
import { usePrefs } from "./prefs-context";

/**
 * B2.5 customization surface — the full /settings page. localStorage is the
 * always-there cache; when a session exists (anonymous included) the auth
 * provider mirrors changes to the DB so preferences follow the account and
 * survive conversion. Board and piece choices are picked visually (swatches
 * and rendered pieces) with a live preview, not from a form dropdown.
 */

const PREVIEW_FEN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 1";

export function SettingsSections() {
  const { prefs, update } = usePrefs();
  const [previewOrientation] = useState<"white" | "black">("white");

  const select = "rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-text";
  const row = "flex items-center justify-between gap-4 py-2";
  const label = "text-sm text-text-dim";
  const heading = "mb-3 text-base font-semibold text-paper";

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-5">
        {/* Board & pieces */}
        <section className="card p-5">
          <h2 className={heading}>Board &amp; pieces</h2>
          <p className="mb-2 text-xs uppercase tracking-wide text-text-faint">Board theme</p>
          <div className="flex flex-wrap gap-2.5">
            {(Object.entries(BOARD_THEMES) as [BoardThemeId, (typeof BOARD_THEMES)[BoardThemeId]][])
              .filter(([id]) => id !== "high-contrast")
              .map(([id, theme]) => (
                <button
                  key={id}
                  onClick={() => update({ boardTheme: id })}
                  aria-pressed={prefs.boardTheme === id}
                  className={`group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors ${
                    prefs.boardTheme === id
                      ? "border-accent bg-surface-2"
                      : "border-edge hover:border-edge-strong hover:bg-surface-2"
                  }`}
                >
                  <span className="grid h-12 w-12 grid-cols-2 overflow-hidden rounded-md">
                    <span style={{ background: theme.light }} />
                    <span style={{ background: theme.dark }} />
                    <span style={{ background: theme.dark }} />
                    <span style={{ background: theme.light }} />
                  </span>
                  <span
                    className={`text-[11px] ${
                      prefs.boardTheme === id ? "text-text" : "text-text-faint group-hover:text-text-dim"
                    }`}
                  >
                    {theme.name.replace(" (LCD)", "")}
                  </span>
                </button>
              ))}
          </div>

          <p className="mb-2 mt-5 text-xs uppercase tracking-wide text-text-faint">Pieces</p>
          <div className="flex gap-2.5">
            {(["cburnett", "classic"] as PieceSetId[]).map((set) => (
              <button
                key={set}
                onClick={() => update({ pieceSet: set })}
                aria-pressed={prefs.pieceSet === set}
                className={`flex items-center gap-1 rounded-xl border px-3 py-2 transition-colors ${
                  prefs.pieceSet === set
                    ? "border-accent bg-surface-2"
                    : "border-edge hover:border-edge-strong hover:bg-surface-2"
                }`}
              >
                <span className="flex h-8 items-center">
                  <PieceGlyph piece="wN" setId={set} size={30} />
                  <PieceGlyph piece="bQ" setId={set} size={30} />
                </span>
                <span className="text-xs text-text-dim">{set === "cburnett" ? "cburnett" : "Classic"}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <div className={row}>
              <span className={label}>Coordinates</span>
              <select
                className={select}
                value={prefs.coordinates}
                onChange={(event) => update({ coordinates: event.target.value as "on" | "off" })}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className={row}>
              <span className={label}>Animation</span>
              <select
                className={select}
                value={prefs.animation}
                onChange={(event) =>
                  update({ animation: event.target.value as typeof prefs.animation })
                }
              >
                <option value="instant">Instant</option>
                <option value="fast">Fast</option>
                <option value="normal">Normal</option>
                <option value="slow">Slow</option>
              </select>
            </div>
            <div className={row}>
              <span className={label}>Move list</span>
              <select
                className={select}
                value={prefs.moveList}
                onChange={(event) => update({ moveList: event.target.value as "san" | "figurine" })}
              >
                <option value="figurine">Figurine</option>
                <option value="san">SAN</option>
              </select>
            </div>
          </div>
        </section>

        {/* Sound & analysis */}
        <section className="card p-5">
          <h2 className={heading}>Sound &amp; analysis</h2>
          <div className={row}>
            <span className={label}>Sound</span>
            <span className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={prefs.sound.master}
                aria-label="Master volume"
                onChange={(event) =>
                  update({ sound: { ...prefs.sound, master: Number(event.target.value) } })
                }
                className="accent-[var(--accent)]"
              />
              <label className="flex items-center gap-1.5 text-sm text-text-dim">
                <input
                  type="checkbox"
                  checked={prefs.sound.muted}
                  onChange={(event) =>
                    update({ sound: { ...prefs.sound, muted: event.target.checked } })
                  }
                  className="accent-[var(--accent)]"
                />
                mute
              </label>
            </span>
          </div>
          <div className={row}>
            <span className={label}>Eval bar (analysis)</span>
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.evalBar.show}
                aria-label="Show eval bar"
                onChange={(event) =>
                  update({ evalBar: { ...prefs.evalBar, show: event.target.checked } })
                }
                className="accent-[var(--accent)]"
              />
              <select
                className={select}
                value={prefs.evalBar.format}
                onChange={(event) =>
                  update({
                    evalBar: { ...prefs.evalBar, format: event.target.value as "cp" | "wp" | "both" },
                  })
                }
              >
                <option value="cp">cp</option>
                <option value="wp">win %</option>
                <option value="both">both</option>
              </select>
            </span>
          </div>
        </section>

        {/* Accessibility */}
        <section className="card p-5">
          <h2 className={heading}>Accessibility</h2>
          <label className={`${row} cursor-pointer`}>
            <span className={label}>Shape-only classification icons</span>
            <input
              type="checkbox"
              checked={prefs.accessibility.shapeOnlyClassifications}
              onChange={(event) =>
                update({
                  accessibility: {
                    ...prefs.accessibility,
                    shapeOnlyClassifications: event.target.checked,
                  },
                })
              }
              className="accent-[var(--accent)]"
            />
          </label>
          <label className={`${row} cursor-pointer`}>
            <span className={label}>High-contrast board</span>
            <input
              type="checkbox"
              checked={prefs.accessibility.highContrastBoard}
              onChange={(event) =>
                update({
                  accessibility: { ...prefs.accessibility, highContrastBoard: event.target.checked },
                })
              }
              className="accent-[var(--accent)]"
            />
          </label>
          <label className={`${row} cursor-pointer`}>
            <span className={label}>Reduce motion</span>
            <input
              type="checkbox"
              checked={prefs.accessibility.reduceMotion}
              onChange={(event) =>
                update({
                  accessibility: { ...prefs.accessibility, reduceMotion: event.target.checked },
                })
              }
              className="accent-[var(--accent)]"
            />
          </label>
        </section>

        {/* Labs */}
        <section className="card p-5">
          <h2 className={heading}>Labs</h2>
          <p className="mb-2 text-xs text-text-faint">
            Analysis-derived trainers — on for everyone by default (they read your analyzed
            games and never touch live play). A deployment can still force one off.
          </p>
          {LABS_FLAGS.map(({ flag, name }) => (
            <label key={flag} className={`${row} cursor-pointer`}>
              <span className={label}>{name}</span>
              <input
                type="checkbox"
                checked={isEnabled(flag) || prefs.labs[flag] === true}
                disabled={isEnabled(flag)}
                title={isEnabled(flag) ? "Enabled for everyone on this deployment" : undefined}
                onChange={(event) =>
                  update({ labs: { ...prefs.labs, [flag]: event.target.checked } })
                }
                className="accent-[var(--accent)]"
              />
            </label>
          ))}
        </section>
      </div>

      {/* Live preview */}
      <div className="order-first lg:order-none">
        <div className="card sticky top-16 p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-text-faint">Preview</p>
          <GameBoard
            boardId="settings-preview"
            fen={PREVIEW_FEN}
            orientation={previewOrientation}
            lastMove={{ from: "g1", to: "f3" }}
            interactive={false}
            onMove={() => false}
            destsFrom={() => []}
            canSelect={() => false}
          />
          <p className="mt-2 text-xs text-text-faint">
            Board, pieces, coordinates and animation apply everywhere immediately.
          </p>
        </div>
      </div>
    </div>
  );
}

const LABS_FLAGS: { flag: FeatureFlag; name: string }[] = [
  { flag: "FF_VARIANTS", name: "Variants: three-check + King of the Hill" },
  { flag: "FF_CALIBRATION", name: "Eval calibration trainer" },
  { flag: "FF_FINGERPRINT", name: "Blunder fingerprint" },
  { flag: "FF_TEMPO", name: "Time allocation trainer" },
  { flag: "FF_REPERTOIRE", name: "Repertoire EV optimizer" },
  { flag: "FF_POSTMORTEM", name: "Interrogative post-mortem" },
];
