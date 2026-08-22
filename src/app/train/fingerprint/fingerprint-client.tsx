"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TrainerGate } from "../train-shared";

/**
 * §9.2 on the C5 pipeline: motifs were detected deterministically during
 * analysis (blunder_tags). This page renders the ranked distribution, the
 * per-month trend, and the drill deck (B1.2 theme map → the puzzle
 * trainer). Prose explanations are cached LLM calls over proven evidence
 * and entirely optional — everything here works with the LLM dark.
 */

interface Report {
  errorPlies: number;
  distribution: { motif: string; count: number; share: number }[];
  trend: { month: string; errorPlies: number; byMotif: Record<string, number> }[];
  drill: { motifs: string[]; themes: string[]; unavailable: string[] };
}
interface ErrorRow {
  plyId: number;
  gameId: string;
  ply: number;
  san: string;
  motif: string;
  wpLoss: number | null;
}

export function FingerprintClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [explanations, setExplanations] = useState<Record<number, string>>({});

  useEffect(() => {
    fetch("/api/train/fingerprint")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: { report: Report } | null) => body && setReport(body.report))
      .catch(() => undefined);
  }, []);

  const openMotif = useCallback(async (motif: string) => {
    setSelected(motif);
    const response = await fetch(`/api/train/fingerprint?list=1&motif=${encodeURIComponent(motif)}`);
    if (!response.ok) return;
    setErrors(((await response.json()) as { errors: ErrorRow[] }).errors);
  }, []);

  const explain = async (plyId: number) => {
    const response = await fetch("/api/classify-blunder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plyId }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { available: boolean; explanation: string | null };
    setExplanations((current) => ({
      ...current,
      [plyId]: body.explanation ?? "(no LLM on this deployment — the motif chain above is the proven mechanism)",
    }));
  };

  return (
    <TrainerGate flag="FF_FINGERPRINT" title="Blunder fingerprint">
      {report === null ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : report.errorPlies === 0 ? (
        <p className="text-sm text-text-dim">No analyzed mistakes yet — analyze some games first.</p>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="w-full lg:w-[26rem]">
            <div className="rounded-xl border border-edge p-4">
              <h2 className="mb-2 text-sm font-semibold text-paper">
                {report.errorPlies} errors, by mechanism
              </h2>
              <div className="flex flex-col gap-1">
                {report.distribution.map((row) => (
                  <button
                    key={row.motif}
                    onClick={() => void openMotif(row.motif)}
                    className={`flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-raise ${
                      selected === row.motif ? "bg-raise" : ""
                    }`}
                  >
                    <span className="w-44 truncate text-text-dim">{row.motif}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-raise">
                      <div
                        className="h-full rounded"
                        style={{ width: `${row.share * 100}%`, background: "var(--lcd)" }}
                      />
                    </div>
                    <span className="notation w-14 text-right text-text">
                      {(row.share * 100).toFixed(0)}% · {row.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {report.trend.length > 1 && (
              <div className="mt-4 rounded-xl border border-edge p-4">
                <h3 className="mb-2 text-sm font-semibold text-paper">Trend — is it shrinking?</h3>
                <table className="w-full text-xs">
                  <tbody className="notation">
                    {report.trend.slice(-6).map((row) => (
                      <tr key={row.month}>
                        <td className="py-0.5 text-text-dim">{row.month}</td>
                        <td className="text-right text-text">{row.errorPlies} errors</td>
                        <td className="text-right text-text-faint">
                          top: {Object.entries(row.byMotif).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 rounded-xl border border-edge p-4">
              <h3 className="mb-2 text-sm font-semibold text-paper">Drill deck</h3>
              <p className="mb-2 text-xs text-text-dim">
                Puzzles matching your top mechanisms ({report.drill.motifs.join(", ") || "—"}).
              </p>
              {report.drill.unavailable.length > 0 && (
                <p className="mb-2 text-xs text-text-faint">
                  No puzzle equivalent for {report.drill.unavailable.join(", ")} (B1.2) — those
                  train through game review instead.
                </p>
              )}
              <Link
                href={`/puzzles?themes=${encodeURIComponent(report.drill.themes.join(","))}`}
                className="inline-block rounded bg-lcd px-4 py-1.5 text-sm font-medium text-field hover:opacity-90"
              >
                Drill these ({report.drill.themes.length} themes)
              </Link>
            </div>
          </div>
          <div className="w-full lg:flex-1">
            {selected && (
              <div className="rounded-xl border border-edge p-4">
                <h3 className="mb-2 text-sm font-semibold text-paper">{selected} — instances</h3>
                <ul className="flex flex-col gap-2">
                  {errors.map((row) => (
                    <li key={row.plyId} className="rounded border border-edge p-2 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="notation text-text">
                          ply {row.ply}: {row.san}
                          {row.wpLoss !== null && (
                            <span className="text-warn-1"> −{row.wpLoss.toFixed(0)}wp</span>
                          )}
                        </span>
                        <span className="flex gap-3">
                          <button
                            onClick={() => void explain(row.plyId)}
                            className="text-xs text-text-dim hover:text-text"
                          >
                            explain
                          </button>
                          <Link
                            href={`/analysis/${row.gameId}?ply=${row.ply}`}
                            className="text-xs text-text-dim hover:text-text"
                          >
                            open review →
                          </Link>
                        </span>
                      </div>
                      {explanations[row.plyId] && (
                        <p className="mt-1 text-xs text-text-dim">{explanations[row.plyId]}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </TrainerGate>
  );
}
