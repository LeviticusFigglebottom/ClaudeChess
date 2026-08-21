"use client";

import { useCallback, useMemo, useState } from "react";
import { FigurineSan } from "./pieces";
import { GameBoard } from "./game-board";
import { GameClock } from "./game-clock";
import { usePrefs } from "./prefs-context";
import type { useBotGame } from "./use-bot-game";

type BotGameApi = ReturnType<typeof useBotGame>;

/** In-game view for a bot game: clocks, board, moves, actions. */
export function BotGameView({ game, onExit }: { game: BotGameApi; onExit(): void }) {
  const { prefs } = usePrefs();
  const [sanInput, setSanInput] = useState("");
  const setup = game.setup;
  const bot = game.bot;

  const playerColor = setup?.playerColor ?? "w";
  const botColor = playerColor === "w" ? "b" : "w";
  const orientation = playerColor === "w" ? "white" : "black";
  const flaggedSide = game.gameOver?.reason === "time forfeit"
    ? game.gameOver.playerScore === 0
      ? playerColor
      : botColor
    : null;

  const canSelect = useCallback(
    (square: string) => {
      const position = game.position;
      if (!position || game.status !== "playing" || game.botThinking) return false;
      const piece = position.pieceAt(square);
      return Boolean(piece && piece.color === playerColor && position.turn === playerColor);
    },
    [game.position, game.status, game.botThinking, playerColor]
  );

  const movePairs = useMemo(() => {
    const pairs: { number: number; white: string; black: string | null }[] = [];
    for (let i = 0; i < game.historySan.length; i += 2) {
      pairs.push({
        number: i / 2 + 1,
        white: game.historySan[i] ?? "",
        black: game.historySan[i + 1] ?? null,
      });
    }
    return pairs;
  }, [game.historySan]);

  const downloadPgn = useCallback(() => {
    const blob = new Blob([game.pgn()], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gambit-${Date.now()}.pgn`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [game]);

  const san = (text: string, color: "w" | "b") =>
    prefs.moveList === "figurine" ? (
      <FigurineSan san={text} color={color} setId={prefs.pieceSet} />
    ) : (
      text
    );

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="w-full max-w-[640px]">
        <div className="mb-2">
          <GameClock
            ms={game.clockFor(botColor)}
            active={game.status === "playing" && game.position?.turn === botColor}
            flagged={flaggedSide === botColor}
            label={`${bot?.name ?? "Bot"}${game.botThinking ? " · thinking…" : ""}`}
          />
        </div>
        <GameBoard
          boardId="bot-game"
          fen={game.fen}
          orientation={orientation}
          lastMove={game.lastMove}
          interactive={game.status === "playing"}
          onMove={game.playerMove}
          destsFrom={game.destsFrom}
          canSelect={canSelect}
        />
        <div className="mt-2">
          <GameClock
            ms={game.clockFor(playerColor)}
            active={game.status === "playing" && game.position?.turn === playerColor}
            flagged={flaggedSide === playerColor}
            label="You"
          />
        </div>
        {setup?.variant === "chess960" && game.status === "playing" && (
          <p className="mt-2 text-xs text-text-faint">
            Chess960 castling: tap your king, then tap your rook.
          </p>
        )}
      </div>

      <div className="flex w-full flex-col gap-4 lg:w-80">
        {game.status === "playing" && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={game.resign}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
            >
              Resign
            </button>
            <button
              onClick={game.offerDraw}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
            >
              Offer draw
            </button>
            {!setup?.rated && (
              <button
                onClick={game.takeback}
                className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
              >
                Takeback
              </button>
            )}
          </div>
        )}

        {game.drawOffer === "declined" && game.status === "playing" && (
          <p className="rounded-lg border border-edge px-3 py-2 text-sm text-text-dim">
            {bot?.name} declines the draw.
          </p>
        )}

        {!game.engineReady && game.status === "playing" && (
          <p className="text-sm text-text-faint">Engine booting…</p>
        )}

        {game.gameOver && (
          <div className="rounded-lg border border-edge-strong bg-raise p-4">
            <p className="notation text-lg text-paper">{game.gameOver.result}</p>
            <p className="mt-0.5 text-sm text-text-dim">
              {game.gameOver.playerScore === 1
                ? "You win"
                : game.gameOver.playerScore === 0.5
                  ? "Draw"
                  : `${bot?.name} wins`}{" "}
              — {game.gameOver.reason}
            </p>
            {game.gameOver.ratingState && (
              <p className="notation mt-2 text-xs text-text-dim">
                {game.gameOver.ratingKey}: {Math.round(game.gameOver.ratingState.rating.rating)} ±
                {Math.round(game.gameOver.ratingState.rating.rd)}
                {game.gameOver.ratingState.pending.length > 0 &&
                  ` · ${game.gameOver.ratingState.pending.length}/12 in this rating period`}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => void navigator.clipboard.writeText(game.pgn())}
                className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
              >
                Copy PGN
              </button>
              <button
                onClick={downloadPgn}
                className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
              >
                Download PGN
              </button>
              <button
                onClick={onExit}
                className="rounded-lg bg-paper px-3 py-1.5 text-sm font-medium text-field hover:bg-white-adv"
              >
                New game
              </button>
            </div>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto rounded-lg border border-edge p-3">
          {movePairs.length === 0 ? (
            <p className="text-sm text-text-faint">
              {game.position?.turn === playerColor
                ? "Your move — drag a piece or tap origin then destination."
                : "Waiting for the bot…"}
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {movePairs.map((pair) => (
                  <tr key={pair.number} className="text-text">
                    <td className="notation w-8 py-0.5 pr-2 text-right text-text-faint">
                      {pair.number}.
                    </td>
                    <td className="w-1/2 py-0.5">{san(pair.white, "w")}</td>
                    <td className="py-0.5">{pair.black ? san(pair.black, "b") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {game.status === "playing" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (game.playerMoveSan(sanInput)) setSanInput("");
            }}
            className="flex gap-2"
          >
            <input
              value={sanInput}
              onChange={(event) => setSanInput(event.target.value)}
              placeholder="Type a move (SAN — e4, Nf3, O-O)"
              aria-label="Keyboard move entry"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-transparent px-3 py-1.5 text-sm placeholder:text-text-faint"
            />
            <button
              type="submit"
              className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong"
            >
              Play
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
