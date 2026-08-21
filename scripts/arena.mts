/**
 * Calibration arena (spec §6 / Phase 1 gate): self-play matches between a
 * Tier-A bot (the exact shipping policy — shallow d6 MPV5 + deep d18 MPV5
 * over the vendored Stockfish 18 Lite) and either a reference Stockfish at a
 * known UCI_Elo (1320–3190) or another Tier-A bot (ladder anchoring for the
 * sub-1320 bands).
 *
 *   npx tsx scripts/arena.mts --bot 1400 --opponent-elo 1400 --games 200 \
 *       --concurrency 4 --seed 1 --out data/calibration/b1400.jsonl
 *   npx tsx scripts/arena.mts --bot 800 --opponent-bot 1000 --games 200 ...
 *
 * Bot params come from --params-file (bot-calibration JSON shape) when given,
 * else the spec formula priors. Games are seeded and resumable (appends until
 * the JSONL holds --games lines). Openings: 4–8 book plies sampled from the
 * vendored dataset so games decorrelate; colors alternate.
 *
 * Adjudication (methodology, reported with the gate): natural ends via the
 * rules facade; forced mate |m|<=6 in the deep pass adjudicates immediately;
 * dead draws (70+ plies, last 4 deep evals |cp|<=12) adjudicate as draws;
 * 140-ply cap adjudicates by last deep eval (|cp|>=300 wins, else draw).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { GamePosition, START_FEN } from "../src/lib/chess";
import {
  bandSearchSettings,
  formulaParams,
  pRandom,
  selectBotMove,
  type BotPolicyParams,
} from "../src/lib/engine/bot";
import { NodeEngine } from "../src/lib/engine/node-engine";
import { mulberry32 } from "../src/lib/rng";
import openings from "../src/db/seed/openings.json";

interface Args {
  bot: number;
  opponentElo?: number;
  opponentBot?: number;
  games: number;
  concurrency: number;
  seed: number;
  out: string;
  paramsFile?: string;
  refMovetimeMs: number;
}

function parseArgs(): Args {
  const get = (flag: string): string | undefined => {
    const index = process.argv.indexOf(`--${flag}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const bot = Number(get("bot"));
  if (!bot) throw new Error("--bot <rating> is required");
  const opponentElo = get("opponent-elo") ? Number(get("opponent-elo")) : undefined;
  const opponentBot = get("opponent-bot") ? Number(get("opponent-bot")) : undefined;
  if (!opponentElo && !opponentBot) throw new Error("--opponent-elo or --opponent-bot required");
  return {
    bot,
    opponentElo,
    opponentBot,
    games: Number(get("games") ?? 200),
    concurrency: Number(get("concurrency") ?? 4),
    seed: Number(get("seed") ?? 1),
    out: get("out") ?? `data/calibration/bot${bot}.jsonl`,
    paramsFile: get("params-file"),
    refMovetimeMs: Number(get("ref-movetime") ?? 100),
  };
}

function paramsFor(rating: number, paramsFile?: string): BotPolicyParams {
  if (paramsFile) {
    const table = JSON.parse(readFileSync(paramsFile, "utf8"));
    const band = table.bands?.[String(rating)];
    if (band) return { pBlunder: band.pBlunder, temperature: band.temperature };
  }
  return formulaParams(rating);
}

const BOOK_LINES = (openings as { pgn: string; ply: number }[]).filter(
  (entry) => entry.ply >= 4 && entry.ply <= 8
);

interface GameRecord {
  game: number;
  seed: number;
  botColor: "w" | "b";
  opening: string;
  /** 1 = bot won, 0.5 draw, 0 = bot lost. */
  score: number;
  plies: number;
  endReason: string;
  botParams: BotPolicyParams;
  opponent: string;
  ms: number;
  /** Revision (d) instrumentation, for the CALIBRATED bot's moves only. */
  moves: number;
  blunderAvailable: number;
  byKind: { random: number; blunder: number; sampled: number };
  /** Moves that actually reached the blunder branch (pRandom didn't consume them). */
  branchMoves: number;
  /** Availability among branch-reaching moves — the conditional rate to report. */
  branchAvailable: number;
}

type Mover =
  | { kind: "bot"; rating: number; params: BotPolicyParams; engine: NodeEngine }
  | { kind: "ref"; engine: NodeEngine };

async function playGame(args: Args, gameIndex: number): Promise<GameRecord> {
  const t0 = performance.now();
  const seed = (args.seed * 1_000_003 + gameIndex * 7919) >>> 0;
  const rng = mulberry32(seed);
  const botColor: "w" | "b" = gameIndex % 2 === 0 ? "w" : "b";
  const botParams = paramsFor(args.bot, args.paramsFile);

  const botEngine = new NodeEngine();
  await botEngine.init({ chess960: false, hashMb: 96 });
  let opponentLabel: string;
  let opponent: Mover;
  const extraEngines: NodeEngine[] = [];
  if (args.opponentElo) {
    const refEngine = new NodeEngine();
    await refEngine.init({ chess960: false, hashMb: 32, limitStrengthElo: args.opponentElo });
    opponent = { kind: "ref", engine: refEngine };
    opponentLabel = `sf-elo-${args.opponentElo}`;
    extraEngines.push(refEngine);
  } else {
    const opponentEngine = new NodeEngine();
    await opponentEngine.init({ chess960: false, hashMb: 96 });
    opponent = {
      kind: "bot",
      rating: args.opponentBot as number,
      params: paramsFor(args.opponentBot as number, args.paramsFile),
      engine: opponentEngine,
    };
    opponentLabel = `bot-${args.opponentBot}`;
    extraEngines.push(opponentEngine);
  }

  // Opening book: 4–8 plies for variety, seeded.
  const position = GamePosition.initial();
  const line = BOOK_LINES[Math.floor(rng() * BOOK_LINES.length)];
  const opening = line?.pgn ?? "";
  const moves: string[] = [];
  if (line) {
    for (const token of line.pgn.split(/\s+/)) {
      if (/^\d+\.$/.test(token)) continue;
      const move = position.moveSan(token);
      if (!move) break;
      moves.push(move.uci);
    }
  }

  const recentBotCp: number[] = [];
  let endReason = "";
  let score = -1;
  let botMoves = 0;
  let blunderAvailableCount = 0;
  let branchMoves = 0;
  let branchAvailable = 0;
  const byKind = { random: 0, blunder: 0, sampled: 0 };

  const finish = (s: number, reason: string): void => {
    score = s;
    endReason = reason;
  };

  while (score === -1) {
    if (position.isCheckmate()) {
      const winner = position.turn === "w" ? "b" : "w";
      finish(winner === botColor ? 1 : 0, "checkmate");
      break;
    }
    if (position.isStalemate() || position.isInsufficientMaterial()) {
      finish(0.5, "draw-rules");
      break;
    }
    if (position.isThreefold() || position.isFiftyMoves()) {
      finish(0.5, position.isThreefold() ? "threefold" : "fifty-move");
      break;
    }
    if (moves.length >= 140) {
      const lastCp = recentBotCp.at(-1) ?? 0;
      if (Math.abs(lastCp) >= 300) finish(lastCp > 0 ? 1 : 0, "adjudicated-cap");
      else finish(0.5, "adjudicated-cap-draw");
      break;
    }

    const moverIsBot = position.turn === botColor;
    const mover: Mover = moverIsBot
      ? { kind: "bot", rating: args.bot, params: botParams, engine: botEngine }
      : opponent;

    let uci: string | null = null;
    if (mover.kind === "ref") {
      uci = await mover.engine.bestMove(START_FEN, moves, args.refMovetimeMs);
    } else {
      const search = bandSearchSettings(mover.rating);
      const shallow = await mover.engine.analyze(START_FEN, moves, search.shallow);
      const deep = await mover.engine.analyze(START_FEN, moves, search.deep);
      const top = deep.infos[0];
      if (top) {
        // Track from the CALIBRATED bot's perspective for adjudication.
        const moverCp = top.mateIn !== null ? (top.mateIn > 0 ? 3000 : -3000) : (top.scoreCp ?? 0);
        const botPovCp = moverIsBot ? moverCp : -moverCp;
        recentBotCp.push(botPovCp);
        if (top.mateIn !== null && Math.abs(top.mateIn) <= 6) {
          const winnerIsMover = top.mateIn > 0;
          const botWins = winnerIsMover === moverIsBot;
          finish(botWins ? 1 : 0, "adjudicated-mate");
          break;
        }
        if (
          moves.length >= 70 &&
          recentBotCp.length >= 4 &&
          recentBotCp.slice(-4).every((cp) => Math.abs(cp) <= 12)
        ) {
          finish(0.5, "adjudicated-dead-draw");
          break;
        }
      }
      const randomSafeMoves =
        pRandom(mover.rating) > 0 ? position.legalMovesAvoidingMateInOne() : [];
      const choice = selectBotMove(
        mover.rating,
        mover.params,
        {
          shallow: shallow.infos,
          deep: deep.infos,
          legalMoveCount: position.legalMoveCount(),
          inCheck: position.isCheck(),
          randomSafeMoves,
        },
        rng
      );
      if (moverIsBot && choice) {
        botMoves++;
        if (choice.blunderAvailable) blunderAvailableCount++;
        byKind[choice.kind]++;
        if (choice.kind !== "random") {
          branchMoves++;
          if (choice.blunderAvailable) branchAvailable++;
        }
      }
      uci = choice?.uci ?? deep.bestmove;
    }

    if (!uci) {
      finish(0.5, "no-move");
      break;
    }
    const played = position.moveUci(uci);
    if (!played) {
      // An illegal engine move would be a harness bug — fail loudly.
      throw new Error(`illegal move ${uci} at game ${gameIndex} after ${moves.join(" ")}`);
    }
    moves.push(played.uci);
  }

  botEngine.quit();
  for (const engine of extraEngines) engine.quit();

  return {
    game: gameIndex,
    seed,
    botColor,
    opening,
    score,
    plies: moves.length,
    endReason,
    botParams,
    opponent: opponentLabel,
    ms: Math.round(performance.now() - t0),
    moves: botMoves,
    blunderAvailable: blunderAvailableCount,
    byKind,
    branchMoves,
    branchAvailable,
  };
}

const args = parseArgs();
mkdirSync(path.dirname(args.out), { recursive: true });
const existing = existsSync(args.out)
  ? readFileSync(args.out, "utf8").split("\n").filter(Boolean).length
  : 0;
if (existing >= args.games) {
  console.log(`${args.out}: already has ${existing} games`);
  process.exit(0);
}
console.log(
  `arena: bot ${args.bot} vs ${args.opponentElo ? `SF@${args.opponentElo}` : `bot ${args.opponentBot}`}, games ${existing}→${args.games}, concurrency ${args.concurrency}`
);

let nextGame = existing;
let completed = existing;
let points = 0;
const startedAt = performance.now();

async function worker(): Promise<void> {
  while (nextGame < args.games) {
    const gameIndex = nextGame++;
    const record = await playGame(args, gameIndex);
    appendFileSync(args.out, JSON.stringify(record) + "\n");
    completed++;
    points += record.score;
    const elapsedMin = (performance.now() - startedAt) / 60000;
    const rate = (completed - existing) / elapsedMin;
    const freeGb = (freemem() / 1024 ** 3).toFixed(1);
    console.log(
      `[${completed}/${args.games}] g${gameIndex} ${record.score === 1 ? "W" : record.score === 0 ? "L" : "D"} ${record.plies}p ${record.endReason} ${(record.ms / 1000).toFixed(0)}s | run score ${points}/${completed - existing} | ${rate.toFixed(2)} games/min | free ${freeGb}G`
    );
  }
}

await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
console.log(`done: ${args.out}`);
process.exit(0);
