"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GameBoard } from "@/components/game-board";
import { GamePosition } from "@/lib/chess";
import { TrainerGate } from "../train-shared";

/**
 * §9.4: the ranked to-learn list (EV per 100 games over memorization cost,
 * own leaks pinned to the top), tree building from the explorer at your
 * rating band, and SM-2 drilling — the drill shows the position and you
 * play the repertoire move on the board.
 */

interface Node {
  id: string;
  fen: string;
  moveUci: string;
  san: string | null;
  reachProb: number;
  evPerNode: number;
  priority: number;
  status: string;
  isLeak: boolean;
  dueAt: string | null;
}

export function RepertoireClient() {
  const [color, setColor] = useState<"white" | "black">("white");
  const [toLearn, setToLearn] = useState<Node[]>([]);
  const [due, setDue] = useState<Node[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch(`/api/train/repertoire?color=${color}`);
    if (!response.ok) {
      setMessage("Sign in to build a repertoire.");
      return;
    }
    const body = (await response.json()) as { toLearn: Node[]; due: Node[] };
    setToLearn(body.toLearn);
    setDue(body.due);
  }, [color]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (action: "build" | "leaks") => {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch("/api/train/repertoire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, color }),
      });
      const body = (await response.json()) as {
        build?: { fetched: number; nodesUpserted: number };
        leaks?: { scanned: number; leaks: number };
        error?: { message: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "failed");
      if (body.build) {
        setMessage(`Expanded the tree: ${body.build.nodesUpserted} nodes (${body.build.fetched} explorer positions).`);
      }
      if (body.leaks) {
        setMessage(`Cross-referenced your games: ${body.leaks.leaks} leaks found of ${body.leaks.scanned} repeated moves.`);
      }
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <TrainerGate flag="FF_REPERTOIRE" title="Repertoire EV">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {(["white", "black"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setColor(option)}
              className={`rounded border px-3 py-1 text-sm ${
                color === option
                  ? "border-edge-strong bg-raise text-text"
                  : "border-edge text-text-dim hover:border-edge-strong"
              }`}
            >
              as {option}
            </button>
          ))}
        </div>
        <button
          onClick={() => void act("build")}
          disabled={busy !== null}
          className="rounded bg-lcd px-4 py-1.5 text-sm font-medium text-field hover:opacity-90 disabled:opacity-50"
        >
          {busy === "build" ? "Expanding…" : "Expand tree"}
        </button>
        <button
          onClick={() => void act("leaks")}
          disabled={busy !== null}
          className="rounded border border-edge px-4 py-1.5 text-sm text-text hover:border-edge-strong disabled:opacity-50"
        >
          {busy === "leaks" ? "Scanning…" : "Find my leaks"}
        </button>
        {message && <span className="text-xs text-text-faint">{message}</span>}
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full lg:w-[30rem]">
          <DrillPanel due={due} onGraded={() => void reload()} />
        </div>
        <div className="w-full lg:flex-1">
          <div className="rounded-xl border border-edge p-4">
            <h2 className="mb-2 text-sm font-semibold text-paper">To learn — ranked by EV / cost</h2>
            {toLearn.length === 0 ? (
              <p className="text-sm text-text-faint">Expand the tree to get a list.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {toLearn.slice(0, 20).map((node) => (
                  <li key={node.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-text">
                      {node.isLeak && <span className="mr-1 text-warn-1">leak</span>}
                      <span className="notation">{node.san ?? node.moveUci}</span>
                      <span className="ml-2 text-xs text-text-faint">
                        reach {(node.reachProb * 100).toFixed(1)}%
                      </span>
                    </span>
                    <span className="notation text-xs text-text-dim">
                      {node.evPerNode >= 0 ? "+" : ""}
                      {node.evPerNode.toFixed(1)} / 100 games
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </TrainerGate>
  );
}

function DrillPanel({ due, onGraded }: { due: Node[]; onGraded: () => void }) {
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<"right" | "wrong" | null>(null);
  const node = due[index] ?? null;

  const position = useMemo(() => {
    if (!node) return null;
    try {
      return GamePosition.fromFen(node.fen, "standard");
    } catch {
      return null;
    }
  }, [node]);

  const grade = async (quality: number) => {
    if (!node) return;
    await fetch("/api/train/repertoire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "drill", nodeId: node.id, quality }),
    });
    setResult(null);
    setIndex((current) => current + 1);
    onGraded();
  };

  if (!node || !position) {
    return (
      <div className="rounded-xl border border-edge p-4">
        <h2 className="mb-1 text-sm font-semibold text-paper">Drill (SM-2)</h2>
        <p className="text-sm text-text-faint">
          Nothing due. Learn a move by drilling it from the to-learn list — expand the tree
          first, then come back daily.
        </p>
      </div>
    );
  }
  const orientation = node.fen.split(" ")[1] === "b" ? "black" : "white";
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-paper">
        Drill — play your repertoire move ({index + 1}/{due.length})
      </h2>
      <GameBoard
        boardId={`drill-${node.id}`}
        fen={node.fen}
        orientation={orientation}
        lastMove={null}
        interactive={result === null}
        onMove={(from, to) => {
          const played = `${from}${to}`;
          setResult(node.moveUci.startsWith(played) ? "right" : "wrong");
          return false;
        }}
        destsFrom={(square) => position.destsFrom(square)}
        canSelect={() => true}
      />
      {result !== null && (
        <div className="mt-3 rounded-lg border border-edge p-3">
          <p className="text-sm text-text">
            {result === "right" ? "That's the move." : "Not this one — the line is"}{" "}
            <span className="notation text-paper">{node.san ?? node.moveUci}</span>
          </p>
          <div className="mt-2 flex gap-2">
            {result === "right" ? (
              <>
                <button onClick={() => void grade(5)} className="rounded bg-lcd px-3 py-1 text-sm text-field">
                  Easy
                </button>
                <button onClick={() => void grade(4)} className="rounded border border-edge px-3 py-1 text-sm text-text">
                  Got it
                </button>
                <button onClick={() => void grade(3)} className="rounded border border-edge px-3 py-1 text-sm text-text">
                  Barely
                </button>
              </>
            ) : (
              <button onClick={() => void grade(1)} className="rounded bg-lcd px-3 py-1 text-sm text-field">
                Show me again soon
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
