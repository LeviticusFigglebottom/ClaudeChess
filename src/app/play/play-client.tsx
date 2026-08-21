"use client";

import { useState } from "react";
import { AnalysisBoard } from "@/components/analysis-board";
import { BotGameView } from "@/components/bot-game";
import { GameSetupCard } from "@/components/game-setup";
import { SettingsPanel } from "@/components/settings-panel";
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
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold text-paper">
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
          <GameSetupCard onStart={startGame} onFreeBoard={() => setMode("analysis")} />
          <SettingsPanel />
        </>
      )}
      {mode === "game" && (
        <>
          <BotGameView game={game} onExit={() => setMode("setup")} />
          <SettingsPanel />
        </>
      )}
      {mode === "analysis" && (
        <>
          <AnalysisBoard />
          <SettingsPanel />
        </>
      )}
    </div>
  );
}
