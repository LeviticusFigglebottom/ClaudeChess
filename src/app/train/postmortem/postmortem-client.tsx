"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TrainerGate } from "../train-shared";

/**
 * §9.5 metric page: RIGHT_MOVE_WRONG_REASON frequency over time — the class
 * of error no move-only tool can see. The interrogation itself happens
 * inside game review (before the engine line is revealed), max 5 critical
 * positions per game.
 */

interface Metric {
  total: number;
  byVerdict: Record<string, number>;
  rightMoveWrongReason: { month: string; total: number; count: number; share: number }[];
}

export function PostmortemClient() {
  const [metric, setMetric] = useState<Metric | null>(null);

  useEffect(() => {
    fetch("/api/train/postmortem")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: { metric: Metric } | null) => body && setMetric(body.metric))
      .catch(() => undefined);
  }, []);

  return (
    <TrainerGate flag="FF_POSTMORTEM" title="Interrogative post-mortem">
      <p className="mb-4 max-w-xl text-sm text-text-dim">
        Open any analyzed game&apos;s review — on critical positions you&apos;ll be asked what
        you were worried about BEFORE the engine line is revealed (max 5 per game). The coach
        judges the thinking, not the move.
      </p>
      {metric === null ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : metric.total === 0 ? (
        <p className="text-sm text-text-dim">
          No interrogations yet. <Link href="/games" className="underline">Open a reviewed game</Link>{" "}
          and answer the prompts.
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:max-w-xl">
          <div className="rounded-xl border border-edge p-4">
            <h2 className="mb-2 text-sm font-semibold text-paper">
              Verdicts over {metric.total} answers
            </h2>
            <ul className="flex flex-col gap-1 text-sm">
              {Object.entries(metric.byVerdict)
                .sort((a, b) => b[1] - a[1])
                .map(([verdict, count]) => (
                  <li key={verdict} className="flex items-baseline justify-between gap-3">
                    <span
                      className={verdict === "RIGHT_MOVE_WRONG_REASON" ? "text-warn-1" : "text-text-dim"}
                    >
                      {verdict}
                    </span>
                    <span className="notation text-text">{count}</span>
                  </li>
                ))}
            </ul>
          </div>
          <div className="rounded-xl border border-edge p-4">
            <h3 className="mb-2 text-sm font-semibold text-paper">
              RIGHT_MOVE_WRONG_REASON over time
            </h3>
            <table className="w-full text-xs">
              <tbody className="notation">
                {metric.rightMoveWrongReason.map((row) => (
                  <tr key={row.month}>
                    <td className="py-0.5 text-text-dim">{row.month}</td>
                    <td className="text-right text-text">
                      {row.count}/{row.total}
                    </td>
                    <td className="text-right text-text">{(row.share * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </TrainerGate>
  );
}
