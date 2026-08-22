"use client";

import Link from "next/link";
import { useState } from "react";
import { AnalysisBoard } from "@/components/analysis-board";
import { BotGameView } from "@/components/bot-game";
import { GameSetupCard } from "@/components/game-setup";
import { VsHumanCard } from "@/components/vs-human-card";
import { useAuth } from "@/components/auth-context";
import { usePrefs } from "@/components/prefs-context";
import { useBotGame, type GameSetup } from "@/components/use-bot-game";

type Mode = "setup" | "game" | "analysis";

export function PlayClient() {
  const { prefs } = usePrefs();
  const { saveFinishedGame } = useAuth();
  const game = useBotGame(prefs, saveFinishedGame);
  const [mode, setMode] = useState<Mode>("setup");

  const startGame = (setup: GameSetup) => {
    setMode("game");
    void game.start(setup);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold text-paper">
          {mode === "analysis" ? "Analysis board" : "Play"}
        </h1>
        {mode !== "setup" && (
          <button
            onClick={() => setMode("setup")}
            className="text-sm text-text-dim hover:text-text"
          >
            ← back to setup
          </button>
        )}
      </div>

      {mode === "setup" && (
        <>
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <GameSetupCard onStart={startGame} onFreeBoard={() => setMode("analysis")} />
            <VsHumanCard />
          </div>
          <p className="text-sm text-text-faint">
            Board looks off?{" "}
            <Link href="/settings" className="text-text-dim underline-offset-2 hover:text-text hover:underline">
              Themes, pieces and sounds live in Settings.
            </Link>
          </p>
        </>
      )}
      {mode === "game" && <BotGameView game={game} onExit={() => setMode("setup")} />}
      {mode === "analysis" && <AnalysisBoard />}
    </div>
  );
}
