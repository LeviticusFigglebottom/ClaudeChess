import type { Metadata } from "next";
import { PlayBoard } from "@/components/play-board";

export const metadata: Metadata = {
  title: "Play — GAMBIT",
};

export default function PlayPage() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">
        Free board <span className="ml-2 text-sm font-normal text-zinc-500">bots land in Phase 1</span>
      </h1>
      <PlayBoard />
    </div>
  );
}
