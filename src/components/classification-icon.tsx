"use client";

import type { Classification } from "@/lib/eval";
import { CLASSIFICATION_GLYPHS } from "@/lib/eval/classification-glyphs";
import { usePrefs } from "./prefs-context";

/** Renders a B2.4 Informant glyph; honors the shape-only accessibility mode. */
export function ClassificationIcon({
  classification,
  className = "",
}: {
  classification: Classification;
  className?: string;
}) {
  const { prefs } = usePrefs();
  const entry = CLASSIFICATION_GLYPHS[classification];
  if (!entry.glyph) return null;
  const color = prefs.accessibility.shapeOnlyClassifications ? "text-text" : entry.colorClass;
  return (
    <span
      className={`notation select-none ${color} ${className}`}
      role="img"
      aria-label={entry.label}
      title={entry.label}
    >
      {entry.glyph}
    </span>
  );
}
