"use client";

/**
 * One side's clock. Martian Mono, tabular digits; the sub-10s state and
 * flagfall wear --flag — one of its two sanctioned uses.
 */
export function GameClock({
  ms,
  active,
  flagged,
  label,
}: {
  ms: number | null;
  active: boolean;
  flagged: boolean;
  label: string;
}) {
  if (ms === null) {
    return (
      <div className="flex items-baseline justify-between gap-3 rounded-lg border border-edge px-3 py-1.5">
        <span className="text-sm text-text-dim">{label}</span>
        <span className="notation text-lg text-text-faint">—</span>
      </div>
    );
  }
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const low = ms < 10_000;
  const text = flagged
    ? "0:00"
    : low
      ? `0:0${seconds}.${Math.floor((ms % 1000) / 100)}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return (
    <div
      className={`flex items-baseline justify-between gap-3 rounded-lg border px-3 py-1.5 transition-colors ${
        flagged
          ? "border-flag"
          : active
            ? "border-edge-strong bg-raise"
            : "border-edge opacity-70"
      }`}
    >
      <span className="truncate text-sm text-text-dim">{label}</span>
      <span
        className={`notation text-lg font-medium tabular-nums ${
          flagged || (low && active) ? "text-flag" : "text-text"
        }`}
      >
        {text}
      </span>
    </div>
  );
}
