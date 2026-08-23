"use client";

import Link from "next/link";
import { useState } from "react";
import { AnalysisBoard } from "@/components/analysis-board";
import { BotGameView } from "@/components/bot-game";
import { GameBoard } from "@/components/game-board";
import { GameSetupCard } from "@/components/game-setup";
import { VsHumanCard } from "@/components/vs-human-card";
import { START_FEN } from "@/lib/chess/fen";
import { useAuth } from "@/components/auth-context";
import { usePrefs } from "@/components/prefs-context";
import { useBotGame, type GameSetup } from "@/components/use-bot-game";

type Mode = "setup" | "game" | "analysis";

/** Theme-live start position beside the setup form (display only). */
function SetupBoardPreview() {
  return (
    <GameBoard
      boardId="setup-preview"
      fen={START_FEN}
      orientation="white"
      lastMove={null}
      interactive={false}
      onMove={() => false}
      destsFrom={() => []}
      canSelect={() => false}
    />
  );
}

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
          {/* Board preview fills the stage (the setup strip used to float in
              a two-thirds-empty page); the forms sit beside it. */}
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <div className="hidden w-full max-w-[min(calc(100vh-16rem),720px)] flex-1 lg:block">
              <SetupBoardPreview />
            </div>
            <div className="flex w-full flex-col gap-5 lg:w-[30rem] lg:shrink-0">
              <GameSetupCard onStart={startGame} onFreeBoard={() => setMode("analysis")} />
              <VsHumanCard />
            </div>
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
