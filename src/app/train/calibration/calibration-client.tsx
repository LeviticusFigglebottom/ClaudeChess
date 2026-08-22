"use client";

import { useCallback, useEffect, useState } from "react";
import { TrainerGate, StaticBoard } from "../train-shared";

/**
 * §9.1 flow: position from your own games (isCritical-biased) → slider
 * prediction of WHITE's win probability → reveal engine WP + Brier score →
 * running report: decile curve, directional bias by tag,
 * reliability/resolution decomposition, and the secondary EMPIRICAL score
 * where the position was in-book. The engine-truth caveat is in the UI, as
 * the spec demands.
 */

interface Position {
  plyId: number;
  fen: string;
  isCritical: boolean;
  tags: Record<string, string | number | boolean>;
}
interface Reveal {
  engineWp: number;
  empiricalWp: number | null;
  squaredError: number;
}
interface Report {
  n: number;
  meanBrier: number | null;
  empirical: { n: number; meanBrier: number | null };
  curve: { decile: number; n: number; meanPrediction: number; meanActual: number }[];
  biasByTag: { tag: string; value: string; n: number; signedError: number }[];
  decomposition: { reliability: number; resolution: number; uncertainty: number } | null;
}

export function CalibrationClient() {
  const [position, setPosition] = useState<Position | null>(null);
  const [prediction, setPrediction] = useState(50);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const next = useCallback(async () => {
    setReveal(null);
    setPrediction(50);
    setMessage(null);
    const response = await fetch("/api/train/calibration");
    const body = (await response.json()) as { position?: Position | null };
    if (!response.ok || body.position === undefined) {
      setMessage("Sign in and analyze some games first — positions come from your own play.");
      return;
    }
    if (body.position === null) {
      setMessage("No analyzed positions yet. Import and analyze games, then come back.");
      return;
    }
    setPosition(body.position);
  }, []);

  const loadReport = useCallback(async () => {
    const response = await fetch("/api/train/calibration?report=1");
    if (!response.ok) return;
    const body = (await response.json()) as { report: Report };
    setReport(body.report);
  }, []);

  useEffect(() => {
    void next();
    void loadReport();
  }, [next, loadReport]);

  const submit = async () => {
    if (!position) return;
    const response = await fetch("/api/train/calibration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plyId: position.plyId, predictedWp: prediction }),
    });
    const body = (await response.json()) as { reveal?: Reveal };
    if (response.ok && body.reveal) {
      setReveal(body.reveal);
      void loadReport();
    }
  };

  return (
    <TrainerGate flag="FF_CALIBRATION" title="Eval calibration">
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full max-w-[520px]">
          {message && <p className="mb-3 text-sm text-warn-1">{message}</p>}
          {position && (
            <>
              <StaticBoard fen={position.fen} orientation="white" />
              <div className="mt-4">
                <label className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-text-dim">White&apos;s winning chances</span>
                  <span className="notation text-lg text-paper">{prediction}%</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={prediction}
                  disabled={reveal !== null}
                  onChange={(event) => setPrediction(Number(event.target.value))}
                  className="w-full"
                  aria-label="Predicted win probability for White"
                />
                {reveal === null ? (
                  <button
                    onClick={() => void submit()}
                    className="mt-3 rounded bg-lcd px-5 py-2 text-sm font-medium text-field hover:opacity-90"
                  >
                    Lock it in
                  </button>
                ) : (
                  <div className="mt-3 rounded-lg border border-edge p-4">
                    <p className="text-sm text-text">
                      Engine: <span className="notation text-paper">{reveal.engineWp.toFixed(1)}%</span>
                      {" · "}you were off by{" "}
                      <span className="notation">{Math.abs(prediction - reveal.engineWp).toFixed(1)}</span>
                      {" wp · Brier "}
                      <span className="notation">{reveal.squaredError.toFixed(3)}</span>
                    </p>
                    {reveal.empiricalWp !== null && (
                      <p className="mt-1 text-sm text-text-dim">
                        Empirical (players at your level from here):{" "}
                        <span className="notation">{reveal.empiricalWp.toFixed(1)}%</span>
                      </p>
                    )}
                    <button
                      onClick={() => void next()}
                      className="mt-3 rounded bg-lcd px-5 py-2 text-sm font-medium text-field hover:opacity-90"
                    >
                      Next position
                    </button>
                  </div>
                )}
              </div>
              <p className="mt-3 text-xs text-text-faint">
                Honest caveat (spec §9.1): the engine&apos;s number is truth under PERFECT play,
                not in a human game — that&apos;s why in-book positions also score against real
                outcomes at your rating band.
              </p>
            </>
          )}
        </div>
        <div className="w-full lg:w-96">{report && <ReportPanel report={report} />}</div>
      </div>
    </TrainerGate>
  );
}

function ReportPanel({ report }: { report: Report }) {
  if (report.n === 0) {
    return <p className="text-sm text-text-faint">Your curve appears after a few attempts.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-edge p-4">
        <h2 className="mb-2 text-sm font-semibold text-paper">
          Calibration — {report.n} predictions
        </h2>
        <p className="mb-2 text-sm text-text-dim">
          Mean Brier vs engine{" "}
          <span className="notation text-text">{report.meanBrier?.toFixed(3)}</span>
          {report.empirical.meanBrier !== null && (
            <>
              {" · vs empirical "}
              <span className="notation text-text">{report.empirical.meanBrier.toFixed(3)}</span>
              <span className="text-text-faint"> ({report.empirical.n} in-book)</span>
            </>
          )}
        </p>
        {report.decomposition && (
          <p className="text-xs text-text-faint">
            reliability {report.decomposition.reliability.toFixed(3)} (miscalibration — lower is
            better) · resolution {report.decomposition.resolution.toFixed(3)} (discrimination —
            higher is better) · uncertainty {report.decomposition.uncertainty.toFixed(3)}
          </p>
        )}
      </div>
      <div className="rounded-xl border border-edge p-4">
        <h3 className="mb-2 text-sm font-semibold text-paper">Curve (diagonal = calibrated)</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-faint">
              <th className="text-left font-normal">you said</th>
              <th className="text-right font-normal">engine said</th>
              <th className="text-right font-normal">n</th>
            </tr>
          </thead>
          <tbody className="notation">
            {report.curve.map((row) => (
              <tr key={row.decile}>
                <td className="py-0.5 text-text">{row.meanPrediction.toFixed(0)}%</td>
                <td className="text-right text-text">{row.meanActual.toFixed(0)}%</td>
                <td className="text-right text-text-faint">{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.biasByTag.length > 0 && (
        <div className="rounded-xl border border-edge p-4">
          <h3 className="mb-2 text-sm font-semibold text-paper">Directional bias</h3>
          <ul className="flex flex-col gap-1 text-xs text-text-dim">
            {report.biasByTag.slice(0, 6).map((row) => (
              <li key={`${row.tag}:${row.value}`}>
                {row.tag} = {row.value}:{" "}
                <span className={`notation ${Math.abs(row.signedError) >= 8 ? "text-warn-1" : "text-text"}`}>
                  {row.signedError > 0 ? "+" : ""}
                  {row.signedError.toFixed(1)} wp
                </span>{" "}
                <span className="text-text-faint">
                  ({row.signedError > 0 ? "overestimate" : "underestimate"}, n={row.n})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
