"use client";

import { useEffect, useRef, useState } from "react";
import { StockfishClient, detectEngineBuild, defaultThreads } from "@/lib/engine";
import type { EngineInfo } from "@/lib/engine";
import { normalizeInfo, winProbFromEval } from "@/lib/eval";
import {
  chess960BackRank,
  chess960StartFen,
  GamePosition,
  sideToMove,
  START_FEN,
} from "@/lib/chess";

interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

/** Black to move, down a full queen: the canonical sign-normalization probe. */
const LOSING_FOR_BLACK_FEN = "k7/8/8/8/8/8/8/KQ6 b - - 0 1";
const WINNING_FOR_WHITE_FEN = "k7/8/8/8/8/8/8/KQ6 w - - 0 1";
const DEPTH20_BUDGET_MS = 3000;
/** Chess960 SP used for the gate-G4 checks (one of the pinned G2 set). */
const SP_960 = 266;

async function finalInfo(stream: AsyncIterable<EngineInfo>): Promise<EngineInfo | null> {
  let last: EngineInfo | null = null;
  for await (const info of stream) {
    if (info.multipv === 1) last = info;
  }
  return last;
}

function describe(info: EngineInfo): string {
  return info.mateIn !== null ? `mate ${info.mateIn}` : `cp ${info.scoreCp}`;
}

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const hasSab = typeof SharedArrayBuffer !== "undefined";

  results.push({
    id: "isolation",
    label: "crossOriginIsolated === true",
    pass: isolated,
    detail: String(isolated),
  });
  results.push({
    id: "sab",
    label: "SharedArrayBuffer available",
    pass: hasSab,
    detail: String(hasSab),
  });

  const build = detectEngineBuild();
  const threads = defaultThreads();
  const client = new StockfishClient(build);
  try {
    await client.init({ threads, hashMb: 64, variant: "standard" });
    results.push({
      id: "boot",
      label: "Engine boots",
      pass: true,
      detail: `${client.engineName ?? "unknown"} · ${build.variant} · ${threads} thread(s) of ${navigator.hardwareConcurrency} cores`,
    });
    results.push({
      id: "multithreaded",
      label: "Multi-threaded build in use",
      pass: build.variant === "multi-threaded",
      detail: build.variant,
    });

    // Depth 20 from the start position, timed end to end (spec §8 gate: < 3s).
    client.setPosition(START_FEN);
    const t0 = performance.now();
    const startposInfo = await finalInfo(client.analyze({ depth: 20 }));
    const elapsedMs = Math.round(performance.now() - t0);
    const reachedDepth = startposInfo?.depth ?? 0;
    results.push({
      id: "depth20",
      label: `Depth 20 on startpos < ${DEPTH20_BUDGET_MS}ms`,
      pass: reachedDepth >= 20 && elapsedMs < DEPTH20_BUDGET_MS,
      detail: startposInfo
        ? `depth ${reachedDepth} in ${elapsedMs}ms (${((startposInfo.nps ?? 0) / 1_000_000).toFixed(1)} Mnps, ${describe(startposInfo)})`
        : "no engine output",
    });

    // Live sign normalization (spec §3.2 "Critical"): Black to move and losing
    // a queen — engine speaks side-to-move POV (negative), White-POV must be
    // strongly positive. Same position with White to move must also be positive.
    client.setPosition(LOSING_FOR_BLACK_FEN);
    const blackInfo = await finalInfo(client.analyze({ depth: 14 }));
    if (blackInfo) {
      const rawLosing = (blackInfo.mateIn ?? 0) < 0 || (blackInfo.scoreCp ?? 0) < -500;
      const whitePov = normalizeInfo(blackInfo, sideToMove(LOSING_FOR_BLACK_FEN));
      const wpWhite = winProbFromEval(whitePov);
      results.push({
        id: "sign-black",
        label: "Black to move, losing: raw negative → White-POV positive",
        pass: rawLosing && wpWhite > 90,
        detail: `raw ${describe(blackInfo)} → White-POV wp ${wpWhite.toFixed(1)}%`,
      });
    } else {
      results.push({ id: "sign-black", label: "Sign check (black)", pass: false, detail: "no output" });
    }

    client.setPosition(WINNING_FOR_WHITE_FEN);
    const whiteInfo = await finalInfo(client.analyze({ depth: 14 }));
    if (whiteInfo) {
      const rawWinning = (whiteInfo.mateIn ?? 0) > 0 || (whiteInfo.scoreCp ?? 0) > 500;
      const whitePov = normalizeInfo(whiteInfo, sideToMove(WINNING_FOR_WHITE_FEN));
      const wpWhite = winProbFromEval(whitePov);
      results.push({
        id: "sign-white",
        label: "White to move, winning: raw positive → White-POV positive",
        pass: rawWinning && wpWhite > 90,
        detail: `raw ${describe(whiteInfo)} → White-POV wp ${wpWhite.toFixed(1)}%`,
      });
    } else {
      results.push({ id: "sign-white", label: "Sign check (white)", pass: false, detail: "no output" });
    }
  } catch (error) {
    results.push({
      id: "boot",
      label: "Engine boots",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.quit();
  }

  // --- Chess960 (Phase 0.5 gate G4): separate client with UCI_Chess960 ---
  const client960 = new StockfishClient(detectEngineBuild());
  try {
    await client960.init({ threads, hashMb: 64, variant: "chess960" });

    // Sane eval on a 960 start position fed as X-FEN (castling "HAha"-style).
    const startFen = chess960StartFen(SP_960);
    GamePosition.fromFen(startFen, "chess960"); // facade accepts it too
    client960.setPosition(startFen);
    const startInfo = await finalInfo(client960.analyze({ depth: 14 }));
    if (startInfo) {
      const whitePov = normalizeInfo(startInfo, sideToMove(startFen));
      const sane = whitePov.mateIn === null && Math.abs(whitePov.cp ?? 9999) < 150;
      results.push({
        id: "960-eval",
        label: `Chess960 SP${SP_960}: X-FEN accepted, eval sane (|cp| < 150)`,
        pass: sane,
        detail: `castling "${startFen.split(" ")[2]}" → White-POV ${describe(startInfo)} at depth ${startInfo.depth}`,
      });
    } else {
      results.push({ id: "960-eval", label: "Chess960 eval", pass: false, detail: "no output" });
    }

    // Sign normalization on that 960 position, black queen removed, black to
    // move: raw side-to-move score must be strongly negative, White-POV
    // strongly positive — same invariant as the standard check.
    const backRank = chess960BackRank(SP_960);
    const castling = startFen.split(" ")[2] as string;
    const losingFen = `${backRank.replace("q", "1")}/pppppppp/8/8/8/8/PPPPPPPP/${backRank.toUpperCase()} b ${castling} - 0 1`;
    GamePosition.fromFen(losingFen, "chess960");
    client960.setPosition(losingFen);
    const losingInfo = await finalInfo(client960.analyze({ depth: 14 }));
    if (losingInfo) {
      const rawLosing = (losingInfo.mateIn ?? 0) < 0 || (losingInfo.scoreCp ?? 0) < -500;
      const whitePov = normalizeInfo(losingInfo, sideToMove(losingFen));
      const wpWhite = winProbFromEval(whitePov);
      results.push({
        id: "960-sign",
        label: `Chess960 SP${SP_960} minus black queen: raw negative → White-POV positive`,
        pass: rawLosing && wpWhite > 90,
        detail: `raw ${describe(losingInfo)} → White-POV wp ${wpWhite.toFixed(1)}%`,
      });
    } else {
      results.push({ id: "960-sign", label: "Chess960 sign check", pass: false, detail: "no output" });
    }
  } catch (error) {
    results.push({
      id: "960-boot",
      label: "Chess960 engine init",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client960.quit();
  }

  return results;
}

export function EngineCheck() {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [done, setDone] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    // Guard against strict-mode double-mount spawning two engines.
    if (startedRef.current) return;
    startedRef.current = true;
    void runChecks().then((checkResults) => {
      setResults(checkResults);
      setDone(true);
    });
  }, []);

  const allPass = done && results.every((r) => r.pass);

  return (
    <div
      data-gate-done={done ? "true" : "false"}
      data-gate-pass={done ? String(allPass) : undefined}
    >
      {!done && (
        <p className="mb-4 animate-pulse text-sm text-zinc-400">
          Running checks (the depth-20 search takes a moment)…
        </p>
      )}
      <ul className="space-y-2">
        {results.map((result) => (
          <li
            key={result.id}
            className="flex items-start gap-3 rounded-lg border border-zinc-800 px-4 py-3"
          >
            <span className={`mt-0.5 font-mono ${result.pass ? "text-emerald-400" : "text-red-400"}`}>
              {result.pass ? "✓" : "✗"}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-200">{result.label}</p>
              <p className="truncate text-xs text-zinc-500" title={result.detail}>
                {result.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {done && (
        <>
          <p
            className={`mt-4 rounded-lg px-4 py-2 text-sm font-medium ${
              allPass ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"
            }`}
          >
            {allPass ? "Phase 0 gate: PASS" : "Phase 0 gate: FAIL — do not advance (spec §8)"}
          </p>
          <pre className="mt-4 hidden" data-gate-results>
            {JSON.stringify(results)}
          </pre>
        </>
      )}
    </div>
  );
}
