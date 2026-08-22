"use client";

/**
 * THE signature primitive (B2.3): one horizontal/vertical signed-axis
 * component used at every scale — the eval bar beside the board, the
 * per-ply eval graph under the review, and the Phase 5 trainer strips
 * (calibration deviation band, time-misallocation strip, motif
 * over/under-representation). Every measurement in GAMBIT is a signed
 * deviation from a center; this is that center, drawn once.
 *
 * Values are −1..1 around the neutral --lcd center: positive = the
 * white-advantage pole (--white-adv), negative = --black-adv.
 */

export function Ribbon({
  value,
  orientation = "vertical",
  className = "",
  label,
}: {
  /** Signed −1..1 (e.g. (wpWhite−50)/50). */
  value: number;
  orientation?: "vertical" | "horizontal";
  className?: string;
  label?: string;
}) {
  const clamped = Math.max(-1, Math.min(1, value));
  const positivePct = ((clamped + 1) / 2) * 100;
  const vertical = orientation === "vertical";
  return (
    <div
      className={`relative overflow-hidden rounded ${className}`}
      style={{ background: "var(--black-adv)" }}
      role="img"
      aria-label={label ?? `evaluation ${(clamped * 100).toFixed(0)} of 100`}
    >
      <div
        className="absolute"
        style={{
          background: "var(--white-adv)",
          transition: "all var(--motion-eval) ease-out",
          ...(vertical
            ? { bottom: 0, left: 0, right: 0, height: `${positivePct}%` }
            : { left: 0, top: 0, bottom: 0, width: `${positivePct}%` }),
        }}
      />
      {/* the neutral center line */}
      <div
        className="absolute"
        style={{
          background: "var(--lcd)",
          opacity: 0.9,
          ...(vertical
            ? { left: 0, right: 0, top: "50%", height: 1.5, transform: "translateY(-50%)" }
            : { top: 0, bottom: 0, left: "50%", width: 1.5, transform: "translateX(-50%)" }),
        }}
      />
    </div>
  );
}

export interface RibbonStripEntry {
  /** Signed −1..1 around the center. */
  value: number;
  /** Marks the bar with --flag — sanctioned ONLY for BLUNDER plies. */
  isBlunder?: boolean;
  /** Distinct treatment for tablebase-proven region (B0.1). */
  isTablebase?: boolean;
  isCritical?: boolean;
}

/**
 * The strip form: one thin signed bar per entry (per ply in the review
 * graph), click-to-jump, current-position cursor.
 */
export function RibbonStrip({
  entries,
  currentIndex,
  onSelect,
  className = "",
  ariaLabel,
}: {
  entries: RibbonStripEntry[];
  currentIndex: number | null;
  onSelect?: (index: number) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={`flex h-16 items-stretch gap-px overflow-hidden rounded border border-edge bg-black-adv ${className}`}
      role="group"
      aria-label={ariaLabel ?? "evaluation by move"}
    >
      {entries.map((entry, index) => {
        const clamped = Math.max(-1, Math.min(1, entry.value));
        const positivePct = ((clamped + 1) / 2) * 100;
        const current = index === currentIndex;
        return (
          <button
            key={index}
            onClick={() => onSelect?.(index)}
            className="relative min-w-0 flex-1 cursor-pointer border-0 p-0"
            style={{
              background: entry.isTablebase
                ? "color-mix(in oklab, var(--brilliant) 18%, var(--black-adv))"
                : "var(--black-adv)",
              outline: current ? "1.5px solid var(--lcd)" : "none",
              outlineOffset: -1,
            }}
            aria-label={`move ${index + 1}`}
            tabIndex={-1}
          >
            <span
              className="absolute bottom-0 left-0 right-0 block"
              style={{
                height: `${positivePct}%`,
                background: entry.isTablebase
                  ? "color-mix(in oklab, var(--brilliant) 25%, var(--white-adv))"
                  : "var(--white-adv)",
              }}
            />
            {entry.isBlunder && (
              <span
                className="absolute left-0 right-0 top-0 block"
                style={{ height: 3, background: "var(--flag)" }}
                aria-hidden
              />
            )}
            {entry.isCritical && !entry.isBlunder && (
              <span
                className="absolute left-0 right-0 top-0 block"
                style={{ height: 3, background: "var(--lcd)" }}
                aria-hidden
              />
            )}
            <span
              className="absolute left-0 right-0 block"
              style={{
                top: "50%",
                height: 1,
                background: "var(--lcd)",
                opacity: 0.35,
              }}
              aria-hidden
            />
          </button>
        );
      })}
    </div>
  );
}
