import type { Metadata } from "next";
import { AnalysisBoard } from "@/components/analysis-board";

export const metadata: Metadata = { title: "Analysis — GAMBIT" };

/**
 * The standalone analysis board (A3.1). `?game=<id>` loads a saved/imported
 * game into the tree (Lichess literate annotations arrive as variations).
 */
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string }>;
}) {
  const { game } = await searchParams;
  return (
    <div>
      <h1 className="mb-5 text-xl font-semibold text-paper">Analysis board</h1>
      <AnalysisBoard initialGameId={game} />
    </div>
  );
}
