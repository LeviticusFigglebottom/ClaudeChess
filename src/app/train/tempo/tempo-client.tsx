"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TrainerGate, StaticBoard } from "../train-shared";

/**
 * §9.3: the personal response curve (wpLoss vs log time, critical vs
 * routine), the flat point, the misallocation number in seconds/game, and
 * the 3-second critical/routine recognition round.
 */

interface CurvePoint {
  fromSeconds: number;
  n: number;
  meanWpLoss: number;
}
interface Report {
  n: number;
  gamesCovered: number;
  curveCritical: CurvePoint[];
  curveRoutine: CurvePoint[];
  flatPointSeconds: number | null;
  misallocationSecondsPerGame: number | null;
  recognition: { n: number; accuracy: number | null; meanAnswerMs: number | null };
}

export function TempoClient() {
  const [report, setReport] = useState<Report | null>(null);

  const loadReport = useCallback(async () => {
    const response = await fetch("/api/train/tempo");
    if (!response.ok) return;
    setReport(((await response.json()) as { report: Report }).report);
  }, []);
  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  return (
    <TrainerGate flag="FF_TEMPO" title="Time allocation">
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full lg:w-[26rem]">
          {report === null ? (
            <p className="text-sm text-text-faint">Loading…</p>
          ) : report.n === 0 ? (
            <p className="text-sm text-text-dim">
              Needs games with clocks (%clk) analyzed — import with clocks or play here, then
              analyze.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="card p-4">
                <h2 className="mb-1 text-sm font-semibold text-paper">
                  The number (over {report.gamesCovered} games)
                </h2>
                {report.misallocationSecondsPerGame !== null ? (
                  <p className="text-sm text-text">
                    You spend{" "}
                    <span className="notation text-lg text-warn-1">
                      {report.misallocationSecondsPerGame.toFixed(0)}s
                    </span>{" "}
                    per game on routine moves past your flat point (
                    <span className="notation">{report.flatPointSeconds}s</span> — beyond it, more
                    time stopped buying you accuracy).
                  </p>
                ) : (
                  <p className="text-sm text-text-dim">
                    Not enough routine-move data to place your flat point yet.
                  </p>
                )}
              </div>
              <CurveTable name="Critical positions" curve={report.curveCritical} />
              <CurveTable name="Routine positions" curve={report.curveRoutine} flat={report.flatPointSeconds} />
            </div>
          )}
        </div>
        <RecognitionRound
          recognition={report?.recognition ?? null}
          onScored={() => void loadReport()}
        />
      </div>
    </TrainerGate>
  );
}

function CurveTable({ name, curve, flat }: { name: string; curve: CurvePoint[]; flat?: number | null }) {
  if (curve.length === 0) return null;
  const max = Math.max(...curve.map((point) => point.meanWpLoss), 1);
  return (
    <div className="card p-4">
      <h3 className="mb-2 text-sm font-semibold text-paper">{name}</h3>
      <div className="flex flex-col gap-1">
        {curve.map((point) => (
          <div key={point.fromSeconds} className="flex items-center gap-2 text-xs">
            <span className="notation w-10 text-right text-text-dim">
              {point.fromSeconds}s{flat === point.fromSeconds ? "▸" : ""}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-raise">
              <div
                className="h-full rounded"
                style={{
                  width: `${(point.meanWpLoss / max) * 100}%`,
                  background: "var(--lcd)",
                }}
              />
            </div>
            <span className="notation w-16 text-text">{point.meanWpLoss.toFixed(1)} wp</span>
            <span className="notation w-10 text-right text-text-faint">{point.n}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-faint">mean win-probability lost per move, by time spent</p>
    </div>
  );
}

function RecognitionRound({
  recognition,
  onScored,
}: {
  recognition: { n: number; accuracy: number | null; meanAnswerMs: number | null } | null;
  onScored: () => void;
}) {
  const [position, setPosition] = useState<{ plyId: number; fen: string } | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(3);
  const shownAtRef = useRef(0);

  const next = useCallback(async () => {
    setVerdict(null);
    const response = await fetch("/api/train/tempo?recognition=1");
    if (!response.ok) return;
    const body = (await response.json()) as { position: { plyId: number; fen: string } | null };
    setPosition(body.position);
    shownAtRef.current = Date.now();
    setSecondsLeft(3);
  }, []);
  useEffect(() => {
    void next();
  }, [next]);
  useEffect(() => {
    if (!position || verdict) return;
    const interval = setInterval(
      () => setSecondsLeft((value) => Math.max(0, value - 1)),
      1000
    );
    return () => clearInterval(interval);
  }, [position, verdict]);

  const call = async (guessedCritical: boolean) => {
    if (!position) return;
    const response = await fetch("/api/train/tempo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plyId: position.plyId,
        guessedCritical,
        answeredInMs: Date.now() - shownAtRef.current,
      }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { actualCritical: boolean; correct: boolean };
    setVerdict(
      body.correct
        ? `Right — this one was ${body.actualCritical ? "critical" : "routine"}.`
        : `No — this one was ${body.actualCritical ? "CRITICAL" : "routine"}.`
    );
    onScored();
  };

  return (
    <div className="w-full max-w-[480px]">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-paper">Recognition round — 3 seconds</h2>
        {recognition && recognition.n > 0 && (
          <span className="notation text-xs text-text-dim">
            {((recognition.accuracy ?? 0) * 100).toFixed(0)}% over {recognition.n}
          </span>
        )}
      </div>
      {position === null ? (
        <p className="text-sm text-text-faint">Needs analyzed games of yours.</p>
      ) : (
        <>
          <StaticBoard fen={position.fen} />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => void call(true)}
              disabled={verdict !== null}
              className="rounded bg-lcd px-4 py-2 text-sm font-medium text-field hover:opacity-90 disabled:opacity-50"
            >
              Critical
            </button>
            <button
              onClick={() => void call(false)}
              disabled={verdict !== null}
              className="rounded border border-edge px-4 py-2 text-sm text-text hover:border-edge-strong disabled:opacity-50"
            >
              Routine
            </button>
            <span
              className={`notation text-sm ${secondsLeft === 0 ? "text-warn-1" : "text-text-faint"}`}
              aria-live="polite"
            >
              {verdict === null ? `${secondsLeft}s` : ""}
            </span>
          </div>
          {verdict && (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-sm text-text">{verdict}</p>
              <button onClick={() => void next()} className="text-sm text-text-dim hover:text-text">
                next →
              </button>
            </div>
          )}
          <p className="mt-2 text-xs text-text-faint">
            Recognizing WHICH positions deserve time is the actionable half of time management.
          </p>
        </>
      )}
    </div>
  );
}
