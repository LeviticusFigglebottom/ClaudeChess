"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { analysisRunner, type RunnerSnapshot } from "@/lib/analysis/runner";

/** Subscribe a component to the global runner (see src/lib/analysis/runner). */
export function useAnalysisRunner(): RunnerSnapshot {
  return useSyncExternalStore(
    analysisRunner.subscribe,
    analysisRunner.getSnapshot,
    analysisRunner.getServerSnapshot
  );
}

/**
 * Header chip: visible on every page while the runner works, so background
 * import/analysis stays discoverable after navigating away. Links to the
 * game being analyzed; the × aborts (per-move progress is already saved).
 */
export function RunnerChip() {
  const snap = useAnalysisRunner();
  if (!snap.importing && !snap.current) return null;
  const label = snap.importing
    ? snap.importing
    : snap.current
      ? `analyzing ${snap.current.label}${
          snap.current.phase
            ? ` · ${snap.current.phase.phase} ${snap.current.phase.done}/${snap.current.phase.total}`
            : snap.current.serverProgress
              ? ` · ${snap.current.serverProgress.analyzed}/${snap.current.serverProgress.total} (server)`
              : "…"
        }${snap.queue.length > 0 ? ` +${snap.queue.length} queued` : ""}`
      : "";
  const inner = (
    <>
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
      <span className="notation max-w-48 truncate sm:max-w-72">{label}</span>
    </>
  );
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-text-dim">
      {snap.current ? (
        <Link
          href={`/analysis/${snap.current.gameId}`}
          className="flex min-w-0 items-center gap-1.5 hover:text-text"
          title="Open the game being analyzed"
        >
          {inner}
        </Link>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">{inner}</span>
      )}
      {snap.current && (
        <button
          onClick={() => analysisRunner.stop()}
          className="ml-0.5 text-text-faint hover:text-warn-2"
          title="Stop analysis (progress is saved per move)"
          aria-label="Stop background analysis"
        >
          ✕
        </button>
      )}
    </span>
  );
}
