"use client";

import { fetchExplorerDirect } from "@/lib/explorer/shape";
import { useEffect, useState } from "react";
import { useAuth } from "./auth-context";

/**
 * Opening explorer panel (Phase 3): Lichess database via our 24h-cached
 * proxy, standard chess only. Per-move W/D/L bars use the signed-axis
 * language (white/black poles around the LCD center).
 */

interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
}

interface ExplorerPayload {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  opening: { eco: string; name: string } | null;
}

export function ExplorerPanel({
  fen,
  variant,
  onPlayMove,
}: {
  fen: string;
  variant: string;
  onPlayMove: (san: string) => void;
}) {
  const auth = useAuth();
  const [data, setData] = useState<ExplorerPayload | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "off">("idle");

  useEffect(() => {
    if (variant !== "standard" || auth.status !== "ready") {
      setState("off");
      setData(null);
      return;
    }
    setState("loading");
    const timer = setTimeout(() => {
      // Client-direct first: the user's browser (residential IP) can reach
      // explorer.lichess.ovh even though datacenter egress cannot; the
      // server proxy stays as the fallback and cache path.
      void (async () => {
        const direct = await fetchExplorerDirect(fen);
        if (direct) {
          setData(direct as ExplorerPayload);
          setState("idle");
          return;
        }
        try {
          const response = await fetch(`/api/explorer?fen=${encodeURIComponent(fen)}`);
          if (!response.ok) throw new Error(String(response.status));
          setData((await response.json()) as ExplorerPayload);
          setState("idle");
        } catch {
          setState("error");
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [fen, variant, auth.status]);

  if (state === "off") return null;

  const total = data ? data.white + data.draws + data.black : 0;
  return (
    <div className="rounded-xl border border-edge bg-surface-2 p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-text-faint">Explorer</span>
        {data?.opening && (
          <span className="truncate text-xs text-text-faint">
            {data.opening.eco} {data.opening.name}
          </span>
        )}
      </div>
      {state === "loading" && !data && <p className="text-xs text-text-faint">…</p>}
      {state === "error" && <p className="text-xs text-text-faint">explorer unreachable</p>}
      {data && data.moves.length === 0 && (
        <p className="text-xs text-text-faint">out of book — no games here</p>
      )}
      {data && data.moves.length > 0 && (
        <ul className="space-y-1">
          {data.moves.slice(0, 8).map((move) => {
            const moveTotal = move.white + move.draws + move.black;
            const pct = total > 0 ? ((moveTotal / total) * 100).toFixed(0) : "0";
            return (
              <li key={move.uci} className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => onPlayMove(move.san)}
                  className="notation w-14 shrink-0 text-left text-text-dim hover:text-text"
                >
                  {move.san}
                </button>
                <span className="notation w-10 shrink-0 text-right text-xs text-text-faint">
                  {pct}%
                </span>
                <span
                  className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-sm"
                  role="img"
                  aria-label={`${move.san}: ${Math.round((move.white / Math.max(1, moveTotal)) * 100)}% white wins, ${Math.round((move.draws / Math.max(1, moveTotal)) * 100)}% draws`}
                >
                  <span
                    style={{
                      width: `${(move.white / Math.max(1, moveTotal)) * 100}%`,
                      background: "var(--white-adv)",
                    }}
                  />
                  <span
                    style={{
                      width: `${(move.draws / Math.max(1, moveTotal)) * 100}%`,
                      background: "var(--lcd)",
                    }}
                  />
                  <span
                    style={{
                      width: `${(move.black / Math.max(1, moveTotal)) * 100}%`,
                      background: "var(--black-adv)",
                    }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
