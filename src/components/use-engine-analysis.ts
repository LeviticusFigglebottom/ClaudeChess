"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEngine,
  defaultThreads,
  type StockfishClient,
} from "@/lib/engine";
import { ANALYSIS_SETTINGS, normalizeInfo, winProbFromEval, type WhitePovEval } from "@/lib/eval";
import { sideToMove, type VariantId } from "@/lib/chess";
import { pvToSan } from "@/lib/chess/san";

export interface AnalysisLine {
  multipv: number;
  depth: number;
  evaluation: WhitePovEval;
  /** White's win probability 0..100 for this line. */
  wpWhite: number;
  pvSan: string[];
  firstUci: string;
}

export interface EngineMeta {
  name: string | null;
  variant: "multi-threaded" | "single-threaded";
  threads: number;
}

export type EngineStatus = "booting" | "ready" | "error";

/**
 * Owns one interactive StockfishClient for the lifetime of the component and
 * streams review-depth analysis (spec §4.6) of whatever FEN was last handed
 * to `analyze`. All evals leave this hook already normalized to White-POV.
 * The variant is fixed per engine instance (spec A0.3: it is an init-time
 * engine option).
 */
export function useEngineAnalysis(gameVariant: VariantId = "standard") {
  const clientRef = useRef<StockfishClient | null>(null);
  const generationRef = useRef(0);
  const [status, setStatus] = useState<EngineStatus>("booting");
  const [meta, setMeta] = useState<EngineMeta | null>(null);
  const [lines, setLines] = useState<AnalysisLine[]>([]);
  const [depth, setDepth] = useState(0);
  const [nps, setNps] = useState(0);

  useEffect(() => {
    let disposed = false;
    const client = createEngine();
    clientRef.current = client;
    const threads = defaultThreads();

    client
      .init({ threads, hashMb: 64, variant: gameVariant })
      .then(() => {
        if (disposed) return;
        setMeta({ name: client.engineName, variant: client.build.variant, threads });
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
      // quit() ends any in-flight analyze stream, which exits the consuming loop.
      client.quit();
      clientRef.current = null;
    };
  }, [gameVariant]);

  const analyze = useCallback(
    (fen: string) => {
      const client = clientRef.current;
      if (!client || status !== "ready") return;

      const generation = ++generationRef.current;
      const mover = sideToMove(fen);
      setLines([]);
      setDepth(0);

      client.setPosition(fen);
      const stream = client.analyze(ANALYSIS_SETTINGS.review);

      void (async () => {
        const byMultipv = new Map<number, AnalysisLine>();
        for await (const info of stream) {
          if (generation !== generationRef.current) return;
          const evaluation = normalizeInfo(info, mover);
          byMultipv.set(info.multipv, {
            multipv: info.multipv,
            depth: info.depth,
            evaluation,
            wpWhite: winProbFromEval(evaluation),
            pvSan: pvToSan(fen, info.pv, gameVariant),
            firstUci: info.pv[0] ?? "",
          });
          setLines([...byMultipv.values()].sort((a, b) => a.multipv - b.multipv));
          setDepth(info.depth);
          if (info.nps > 0) setNps(info.nps);
        }
      })();
    },
    [status, gameVariant]
  );

  const stop = useCallback(() => {
    generationRef.current++;
    clientRef.current?.stop();
  }, []);

  return { status, meta, lines, depth, nps, analyze, stop };
}
