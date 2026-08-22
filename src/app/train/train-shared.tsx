"use client";

import Link from "next/link";
import { GameBoard } from "@/components/game-board";
import { useFlag } from "@/components/use-flag";
import type { FeatureFlag } from "@/lib/flags";

/** Flag gate wrapper: trainers render dark unless enabled (env or Labs). */
export function TrainerGate({
  flag,
  title,
  children,
}: {
  flag: FeatureFlag;
  title: string;
  children: React.ReactNode;
}) {
  const on = useFlag(flag);
  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold text-paper">{title}</h1>
        <Link href="/train" className="text-sm text-text-dim hover:text-text">
          ← trainers
        </Link>
      </div>
      {on ? (
        children
      ) : (
        <div className="max-w-lg rounded-xl border border-edge p-5">
          <p className="text-sm text-text-dim">
            This trainer ships dark (spec §9). Turn it on in Settings → Labs on the
            Play page, or set its environment flag.
          </p>
        </div>
      )}
    </div>
  );
}

/** Static board for judgement trainers — look, don't touch. */
export function StaticBoard({ fen, orientation }: { fen: string; orientation?: "white" | "black" }) {
  return (
    <GameBoard
      boardId={`train-${fen.split(" ")[0]}`}
      fen={fen}
      orientation={orientation ?? (fen.split(" ")[1] === "b" ? "black" : "white")}
      lastMove={null}
      interactive={false}
      onMove={() => false}
      destsFrom={() => []}
      canSelect={() => false}
    />
  );
}
