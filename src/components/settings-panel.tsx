"use client";

import { BOARD_THEMES, type BoardThemeId, type PieceSetId } from "@/lib/prefs/prefs";
import { isEnabled, type FeatureFlag } from "@/lib/flags";
import { usePrefs } from "./prefs-context";

/**
 * B2.5 customization surface. localStorage is the always-there cache; when a
 * session exists (anonymous included) the auth provider mirrors changes to
 * the DB so preferences follow the account and survive conversion.
 */
export function SettingsPanel() {
  const { prefs, update } = usePrefs();

  const select = "rounded border border-edge bg-field px-2 py-1 text-sm text-text";
  const row = "flex items-center justify-between gap-4 py-1.5";
  const label = "text-sm text-text-dim";

  return (
    <details className="rounded-lg border border-edge px-4 py-3">
      <summary className="cursor-pointer select-none text-sm text-text-dim hover:text-text">
        Board, sound &amp; accessibility settings
      </summary>
      <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
        <div>
          <div className={row}>
            <span className={label}>Board theme</span>
            <select
              className={select}
              value={prefs.boardTheme}
              onChange={(event) => update({ boardTheme: event.target.value as BoardThemeId })}
            >
              {Object.entries(BOARD_THEMES).map(([id, theme]) => (
                <option key={id} value={id}>
                  {theme.name}
                </option>
              ))}
            </select>
          </div>
          <div className={row}>
            <span className={label}>Pieces</span>
            <select
              className={select}
              value={prefs.pieceSet}
              onChange={(event) => update({ pieceSet: event.target.value as PieceSetId })}
            >
              <option value="cburnett">cburnett</option>
              <option value="classic">Classic</option>
            </select>
          </div>
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
        <div>
          <div className={row}>
            <span className={label}>Sound</span>
            <span className="flex items-center gap-2">
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
              />
              <label className="flex items-center gap-1 text-sm text-text-dim">
                <input
                  type="checkbox"
                  checked={prefs.sound.muted}
                  onChange={(event) =>
                    update({ sound: { ...prefs.sound, muted: event.target.checked } })
                  }
                  className="accent-[var(--lcd)]"
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
                className="accent-[var(--lcd)]"
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
          <p className="mt-2 mb-1 text-xs uppercase tracking-wide text-text-faint">Accessibility</p>
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
              className="accent-[var(--lcd)]"
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
              className="accent-[var(--lcd)]"
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
              className="accent-[var(--lcd)]"
            />
          </label>
          <p className="mt-2 mb-1 text-xs uppercase tracking-wide text-text-faint">
            Labs — original trainers (§9, ship dark by default)
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
                className="accent-[var(--lcd)]"
              />
            </label>
          ))}
        </div>
      </div>
    </details>
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
