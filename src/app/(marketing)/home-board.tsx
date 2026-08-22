"use client";

import { GameBoard } from "@/components/game-board";

/** Hero board — a themed, non-interactive middlegame in the user's own
 * board/piece preferences, so the landing page IS the customization. */
const HERO_FEN = "r1bq1rk1/pp1nbppp/4pn2/2p5/2BP4/2N1PN2/PP3PPP/R1BQ1RK1 w - - 0 9";

export function HomeBoard() {
  return (
    <GameBoard
      boardId="home-hero"
      fen={HERO_FEN}
      orientation="white"
      lastMove={{ from: "e8", to: "g8" }}
      interactive={false}
      onMove={() => false}
      destsFrom={() => []}
      canSelect={() => false}
    />
  );
}
