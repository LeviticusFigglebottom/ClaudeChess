"use client";

import { useEffect, useState } from "react";

/**
 * Spec §3.1 gate support: logs cross-origin isolation on boot and shows a
 * badge in the footer. If this ever reads "NOT isolated" on a deployed
 * preview, stop and fix the headers before anything else — the engine is
 * silently 40x slower without it.
 */
export function BootDiagnostics() {
  const [isolated, setIsolated] = useState<boolean | null>(null);

  useEffect(() => {
    const value = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
    setIsolated(value);
    console.log(
      `[gambit] crossOriginIsolated=${value} sharedArrayBuffer=${typeof SharedArrayBuffer !== "undefined"} cores=${navigator.hardwareConcurrency}`
    );
    if (!value) {
      console.warn(
        "[gambit] NOT cross-origin isolated — multi-threaded engine unavailable, falling back to single thread (spec §3.1)"
      );
    }
  }, []);

  if (isolated === null) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
        isolated ? "border-edge text-lcd" : "border-warn-2 text-warn-2"
      }`}
      title="SharedArrayBuffer / multi-threaded engine availability"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isolated ? "bg-lcd" : "bg-warn-2"}`} />
      {isolated ? "cross-origin isolated" : "NOT isolated"}
    </span>
  );
}
