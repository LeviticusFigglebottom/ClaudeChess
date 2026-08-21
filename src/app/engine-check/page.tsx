import type { Metadata } from "next";
import { EngineCheck } from "@/components/engine-check";

export const metadata: Metadata = {
  title: "Engine check — GAMBIT",
};

/**
 * Phase 0 gate diagnostics (spec §8): open this page on the deployed Vercel
 * preview and every row must be green. Also driven headlessly by
 * `npm run gate`.
 */
export default function EngineCheckPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold">Engine check</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Phase 0 gate: cross-origin isolation, multi-threaded Stockfish, depth 20 under 3s, and
        live sign normalization. Run this on every deployed preview.
      </p>
      <EngineCheck />
    </div>
  );
}
