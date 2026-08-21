"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GamePosition, type FacadeMove, type VariantId } from "@/lib/chess";
import { openingForGame } from "@/lib/chess/openings";
import { writePgn } from "@/lib/chess/pgn";
import {
  applyMove as clockApplyMove,
  createClock,
  isFlagged,
  remainingMs,
  startClock,
  timeControlBucket,
  type ClockConfig,
  type ClockState,
} from "@/lib/clock/clock";
import { bandSearchSettings, pRandom, selectBotMove, type BotRating } from "@/lib/engine/bot";
import { botForRating, type BotDefinition } from "@/lib/engine/bots";
import { createEngine, defaultThreads, type EngineInfo, type StockfishClient } from "@/lib/engine";
import type { SaveGamePayload } from "@/lib/account/games";
import type { Prefs } from "@/lib/prefs/prefs";
import { soundPlayer, type PlayableSound } from "@/lib/sound/player";
import type { RatingPeriodState } from "@/lib/rating/period";
import { getRatingState, recordRatedGame, type RatingKey } from "./ratings-store";

export interface GameSetup {
  variant: Extract<VariantId, "standard" | "chess960">;
  /** Scharnagl index for chess960 games. */
  startPositionId?: number;
  botRating: BotRating;
  playerColor: "w" | "b";
  clock: ClockConfig;
  rated: boolean;
}

export interface GameOverInfo {
  result: "1-0" | "0-1" | "1/2-1/2";
  playerScore: 0 | 0.5 | 1;
  reason: string;
  ratingState?: RatingPeriodState;
  ratingKey?: RatingKey;
}

export type GameStatus = "idle" | "playing" | "over";

async function finalInfos(stream: AsyncIterable<EngineInfo>): Promise<EngineInfo[]> {
  const byMultipv = new Map<number, EngineInfo>();
  for await (const info of stream) byMultipv.set(info.multipv, info);
  return [...byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
}

function soundForMove(move: FacadeMove, inCheckAfter: boolean): PlayableSound {
  if (inCheckAfter) return "check";
  if (move.san.startsWith("O-O")) return "castle";
  if (move.san.includes("=")) return "promote";
  if (move.san.includes("x")) return "capture";
  return "move";
}

/**
 * Orchestrates one game vs a Tier-A bot (spec §6/§8 Phase 1): real clocks
 * charged in wall time for both sides, the bot running the exact calibrated
 * shallow/deep policy through the in-browser engine, resign/draw/takeback
 * (casual only), PGN with %clk, Glicko-2 batching for rated games.
 *
 * `onFinished` (Phase 1.5) receives the finished game as a save payload —
 * the auth layer persists it to /api/games when an account session exists
 * (anonymous included) and drops it silently in local-only mode.
 */
export function useBotGame(prefs: Prefs, onFinished?: (payload: SaveGamePayload) => void) {
  const positionRef = useRef<GamePosition | null>(null);
  const engineRef = useRef<StockfishClient | null>(null);
  const engineInitRef = useRef<Promise<void> | null>(null);
  const clockRef = useRef<ClockState | null>(null);
  const setupRef = useRef<GameSetup | null>(null);
  const botRef = useRef<BotDefinition | null>(null);
  const moveClocksRef = useRef<number[]>([]);
  const lastBotEvalCpRef = useRef<number | null>(null);
  const lastLowTickRef = useRef<number>(-1);
  const generationRef = useRef(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const [status, setStatus] = useState<GameStatus>("idle");
  const [fen, setFen] = useState<string>("");
  const [historySan, setHistorySan] = useState<string[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [botThinking, setBotThinking] = useState(false);
  const [drawOffer, setDrawOffer] = useState<"none" | "declined">("none");
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [engineReady, setEngineReady] = useState(false);

  const play = useCallback((sound: PlayableSound) => {
    soundPlayer().play(sound, prefsRef.current);
  }, []);

  const refresh = useCallback(() => {
    const position = positionRef.current;
    if (!position) return;
    setFen(position.fen());
    setHistorySan(position.historySan());
    const last = position.lastMove();
    setLastMove(last ? { from: last.from, to: last.to } : null);
  }, []);

  /** Movetext + headers for the game as it stands, with an explicit result. */
  const composePgn = useCallback(
    (
      result: "1-0" | "0-1" | "1/2-1/2" | "*",
      termination?: string
    ): { text: string; eco: { eco: string; name: string } | null } => {
      const position = positionRef.current;
      const setup = setupRef.current;
      const bot = botRef.current;
      if (!position || !setup || !bot) return { text: "", eco: null };
      const moves = position.history().map((move, index) => ({
        san: move.san,
        clockMsAfter:
          setup.clock.mode === "none" ? undefined : moveClocksRef.current[index],
      }));
      const playerName = "You";
      const epds: string[] = [];
      if (setup.variant === "standard") {
        const replay = GamePosition.fromFen(position.startFen, setup.variant);
        for (const move of position.history()) {
          replay.moveUci(move.uci);
          epds.push(replay.epd());
        }
      }
      const eco = setup.variant === "standard" ? openingForGame(epds) : null;
      const text = writePgn(
        {
          white: setup.playerColor === "w" ? playerName : bot.name,
          black: setup.playerColor === "b" ? playerName : bot.name,
          result,
          variant: setup.variant,
          startFen: setup.variant === "chess960" ? position.startFen : undefined,
          startPositionId: setup.variant === "chess960" ? setup.startPositionId : undefined,
          clock: setup.clock,
          rated: setup.rated,
          playedAt: new Date(),
          termination,
          eco,
        },
        moves
      );
      return { text, eco };
    },
    []
  );

  const endGame = useCallback(
    (playerScore: 0 | 0.5 | 1, reason: string) => {
      const setup = setupRef.current;
      const bot = botRef.current;
      if (!setup || !bot) return;
      generationRef.current++;
      setBotThinking(false);
      const result: GameOverInfo["result"] =
        playerScore === 0.5
          ? "1/2-1/2"
          : (playerScore === 1) === (setup.playerColor === "w")
            ? "1-0"
            : "0-1";
      const info: GameOverInfo = { result, playerScore, reason };
      if (setup.rated && setup.clock.mode !== "none") {
        const key: RatingKey = `${setup.variant}:${timeControlBucket(setup.clock)}`;
        info.ratingKey = key;
        info.ratingState = recordRatedGame(key, {
          opponentRating: bot.rating,
          opponentRd: bot.rd,
          score: playerScore,
        });
      }
      setGameOver(info);
      setStatus("over");
      play(playerScore === 1 ? "game-end-win" : playerScore === 0.5 ? "game-end-draw" : "game-end-loss");

      // Phase 1.5: hand the finished game to the persistence layer. The
      // server's rated-state response overwrites the local cache written
      // above (same module, same inputs — it only differs across devices).
      const { text, eco } = composePgn(result, reason);
      if (text) {
        onFinishedRef.current?.({
          variant: setup.variant,
          startFen:
            setup.variant === "chess960" ? (positionRef.current?.startFen ?? null) : null,
          startPositionId:
            setup.variant === "chess960" ? (setup.startPositionId ?? null) : null,
          pgn: text,
          whiteName: setup.playerColor === "w" ? "You" : bot.name,
          blackName: setup.playerColor === "b" ? "You" : bot.name,
          userColor: setup.playerColor === "w" ? "white" : "black",
          result,
          termination: reason,
          timeControl:
            setup.clock.mode === "none"
              ? null
              : `${Math.round(setup.clock.initialMs / 1000)}+${Math.round(setup.clock.incrementMs / 1000)}`,
          eco: eco?.eco ?? null,
          opening: eco?.name ?? null,
          playedAt: new Date().toISOString(),
          rated:
            setup.rated && setup.clock.mode !== "none"
              ? {
                  bucket: timeControlBucket(setup.clock),
                  opponentRating: bot.rating,
                  opponentRd: bot.rd,
                  score: playerScore,
                }
              : null,
        });
      }
    },
    [composePgn, play]
  );

  /** Natural (rules-based) game end; returns true when the game ended. */
  const checkNaturalEnd = useCallback((): boolean => {
    const position = positionRef.current;
    const setup = setupRef.current;
    if (!position || !setup) return false;
    if (position.isCheckmate()) {
      const winner = position.turn === "w" ? "b" : "w";
      endGame(winner === setup.playerColor ? 1 : 0, "checkmate");
      return true;
    }
    if (position.isStalemate()) {
      endGame(0.5, "stalemate");
      return true;
    }
    if (position.isInsufficientMaterial()) {
      endGame(0.5, "insufficient material");
      return true;
    }
    if (position.isThreefold()) {
      endGame(0.5, "threefold repetition");
      return true;
    }
    if (position.isFiftyMoves()) {
      endGame(0.5, "fifty-move rule");
      return true;
    }
    return false;
  }, [endGame]);

  const applyClockForMover = useCallback((): boolean => {
    const clock = clockRef.current;
    if (!clock) return true;
    const next = clockApplyMove(clock, Date.now());
    clockRef.current = next;
    if (next.flagged) {
      const setup = setupRef.current;
      if (setup) endGame(next.flagged === setup.playerColor ? 0 : 1, "time forfeit");
      return false;
    }
    return true;
  }, [endGame]);

  const recordMoveClock = useCallback((moverColor: "w" | "b") => {
    const clock = clockRef.current;
    moveClocksRef.current.push(
      clock ? remainingMs(clock, moverColor, Date.now()) : 0
    );
  }, []);

  const botTurn = useCallback(async () => {
    const position = positionRef.current;
    const engine = engineRef.current;
    const setup = setupRef.current;
    const bot = botRef.current;
    if (!position || !engine || !setup || !bot) return;
    const generation = generationRef.current;
    setBotThinking(true);
    const startedAt = Date.now();
    try {
      // The player may move before the engine finishes booting.
      await engineInitRef.current;
      if (generation !== generationRef.current) return;
      const startFen = position.startFen;
      const moves = position.history().map((move) => move.uci);
      const search = bandSearchSettings(bot.rating);
      engine.setPosition(startFen, moves);
      const shallow = await finalInfos(engine.analyze(search.shallow));
      if (generation !== generationRef.current) return;
      engine.setPosition(startFen, moves);
      const deep = await finalInfos(engine.analyze(search.deep));
      if (generation !== generationRef.current) return;

      const top = deep[0];
      lastBotEvalCpRef.current = top
        ? top.mateIn !== null
          ? top.mateIn > 0
            ? 3000
            : -3000
          : (top.scoreCp ?? 0)
        : null;

      const choice = selectBotMove(
        bot.rating,
        bot.params,
        {
          shallow,
          deep,
          legalMoveCount: position.legalMoveCount(),
          inCheck: position.isCheck(),
          randomSafeMoves: pRandom(bot.rating) > 0 ? position.legalMovesAvoidingMateInOne() : [],
        },
        Math.random
      );
      const uci = choice?.uci ?? deep[0]?.pv[0];
      if (!uci) {
        checkNaturalEnd();
        return;
      }

      // Keep even instant book replies from feeling robotic.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 450) await new Promise((resolve) => setTimeout(resolve, 450 - elapsed));
      if (generation !== generationRef.current) return;

      if (!applyClockForMover()) return;
      const played = position.moveUci(uci);
      if (!played) throw new Error(`bot chose illegal move ${uci}`);
      recordMoveClock(setup.playerColor === "w" ? "b" : "w");
      play(soundForMove(played, position.isCheck()));
      refresh();
      checkNaturalEnd();
    } finally {
      if (generation === generationRef.current) setBotThinking(false);
    }
  }, [applyClockForMover, checkNaturalEnd, play, recordMoveClock, refresh]);

  const start = useCallback(
    async (setup: GameSetup) => {
      generationRef.current++;
      engineRef.current?.quit();
      setGameOver(null);
      setDrawOffer("none");
      setEngineReady(false);
      moveClocksRef.current = [];
      lastBotEvalCpRef.current = null;
      lastLowTickRef.current = -1;

      const position =
        setup.variant === "chess960"
          ? GamePosition.fromChess960(setup.startPositionId ?? 518)
          : GamePosition.initial();
      positionRef.current = position;
      setupRef.current = setup;
      botRef.current = botForRating(setup.botRating);
      clockRef.current =
        setup.clock.mode === "none"
          ? createClock(setup.clock)
          : startClock(createClock(setup.clock), Date.now());

      setStatus("playing");
      refresh();
      play("game-start");

      const engine = createEngine();
      engineRef.current = engine;
      engineInitRef.current = engine.init({
        threads: defaultThreads(),
        hashMb: 64,
        variant: setup.variant,
      });
      await engineInitRef.current;
      setEngineReady(true);
      if (position.turn !== setup.playerColor) void botTurn();
    },
    [botTurn, play, refresh]
  );

  const playerMove = useCallback(
    (from: string, to: string): boolean => {
      const position = positionRef.current;
      const setup = setupRef.current;
      if (!position || !setup || status !== "playing" || botThinking) return false;
      if (position.turn !== setup.playerColor) return false;
      const probe = position.move({ from, to });
      if (!probe) {
        play("illegal");
        return false;
      }
      // Move is legal — charge the clock (undo if the mover had flagged).
      position.undo();
      if (!applyClockForMover()) return false;
      const move = position.move({ from, to });
      if (!move) return false;
      recordMoveClock(setup.playerColor);
      play(soundForMove(move, position.isCheck()));
      setDrawOffer("none");
      refresh();
      if (!checkNaturalEnd()) void botTurn();
      return true;
    },
    [applyClockForMover, botThinking, botTurn, checkNaturalEnd, play, recordMoveClock, refresh, status]
  );

  const playerMoveSan = useCallback(
    (san: string): boolean => {
      const position = positionRef.current;
      const setup = setupRef.current;
      if (!position || !setup || status !== "playing" || botThinking) return false;
      if (position.turn !== setup.playerColor) return false;
      const probe = position.moveSan(san.trim());
      if (!probe) {
        play("illegal");
        return false;
      }
      position.undo();
      const move = position.moveSan(san.trim());
      if (!move) return false;
      if (!applyClockForMover()) {
        position.undo();
        return false;
      }
      recordMoveClock(setup.playerColor);
      play(soundForMove(move, position.isCheck()));
      setDrawOffer("none");
      refresh();
      if (!checkNaturalEnd()) void botTurn();
      return true;
    },
    [applyClockForMover, botThinking, botTurn, checkNaturalEnd, play, recordMoveClock, refresh, status]
  );

  const resign = useCallback(() => {
    if (status !== "playing") return;
    endGame(0, "resignation");
  }, [endGame, status]);

  const offerDraw = useCallback(() => {
    if (status !== "playing") return;
    const evalCp = lastBotEvalCpRef.current;
    const plies = positionRef.current?.history().length ?? 0;
    if (evalCp !== null && Math.abs(evalCp) <= 30 && plies >= 40) {
      endGame(0.5, "draw agreed");
    } else {
      setDrawOffer("declined");
    }
  }, [endGame, status]);

  const takeback = useCallback(() => {
    const position = positionRef.current;
    const setup = setupRef.current;
    if (!position || !setup || status !== "playing" || botThinking) return;
    if (setup.rated) return; // casual only (spec Phase 1)
    const undone = position.undo() ? 1 : 0;
    if (undone && position.turn !== setup.playerColor) position.undo();
    moveClocksRef.current = moveClocksRef.current.slice(0, position.history().length);
    setDrawOffer("none");
    refresh();
  }, [botThinking, refresh, status]);

  const pgn = useCallback(
    (): string => composePgn(gameOver?.result ?? "*", gameOver?.reason).text,
    [composePgn, gameOver]
  );

  // Clock ticker: display updates, flag detection, low-time ticks.
  useEffect(() => {
    if (status !== "playing") return;
    const interval = setInterval(() => {
      const clock = clockRef.current;
      const setup = setupRef.current;
      if (!clock || !setup || clock.config.mode === "none") return;
      const now = Date.now();
      if (isFlagged(clock, now)) {
        const loser = clock.turn;
        endGame(loser === setup.playerColor ? 0 : 1, "time forfeit");
        return;
      }
      const playerRemaining = remainingMs(clock, setup.playerColor, now);
      if (clock.turn === setup.playerColor && playerRemaining < 10_000) {
        const second = Math.floor(playerRemaining / 1000);
        if (second !== lastLowTickRef.current) {
          lastLowTickRef.current = second;
          play("low-time");
        }
      }
      setClockTick((tick) => tick + 1);
    }, 200);
    return () => clearInterval(interval);
  }, [endGame, play, status]);

  const teardown = useCallback(() => {
    generationRef.current++;
    engineRef.current?.quit();
  }, []);

  useEffect(() => teardown, [teardown]);

  const destsFrom = useCallback((square: string): string[] => {
    return positionRef.current?.destsFrom(square) ?? [];
  }, []);

  const clockFor = useCallback(
    (color: "w" | "b"): number | null => {
      void clockTick;
      const clock = clockRef.current;
      if (!clock || clock.config.mode === "none") return null;
      return remainingMs(clock, color, Date.now());
    },
    [clockTick]
  );

  return {
    status,
    fen,
    historySan,
    lastMove,
    botThinking,
    engineReady,
    drawOffer,
    gameOver,
    setup: setupRef.current,
    bot: botRef.current,
    position: positionRef.current,
    start,
    playerMove,
    playerMoveSan,
    resign,
    offerDraw,
    takeback,
    pgn,
    destsFrom,
    clockFor,
    getRatingState,
  };
}
