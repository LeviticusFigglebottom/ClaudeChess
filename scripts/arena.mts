/**
 * Calibration arena, POLICY v2 (organic): self-play matches between a
 * Tier-A bot (the exact shipping policy — one shallow low-MultiPV search,
 * mild-temperature softmax, or engine-native UCI_LimitStrength for the
 * high bands) and either a reference Stockfish at a
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
import { REFERENCE_MOVETIME_MS, selectOrganicMove, type BotRating } from "../src/lib/engine/bot";
import { botPlanFor } from "../src/lib/engine/bots";
import { NodeEngine, NodeEngineWedgedError } from "../src/lib/engine/node-engine";
import { budgetForMs } from "../src/lib/analysis/budgets";
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

/**
 * Policy v2 plan for a band, with --params-file overriding the ORGANIC
 * knobs (depth/multipv/temperature) during fit iterations. LimitStrength
 * bands are anchored by construction and are not arena-tuned.
 */
function planFor(rating: number, paramsFile?: string) {
  const plan = botPlanFor(rating as BotRating);
  if (paramsFile) {
    const table = JSON.parse(readFileSync(paramsFile, "utf8"));
    const band = table.bands?.[String(rating)];
    // Organic knobs FIRST: an explicit depth/temperature override forces the
    // sampling tier even when the shipped band is limit-strength (probe
    // iterations must never silently reuse the shipped method).
    if (band && (band.depth !== undefined || band.temperature !== undefined)) {
      return {
        kind: "organic" as const,
        depth: band.depth ?? 2,
        multipv: band.multipv ?? 6,
        temperature: band.temperature ?? 4,
      };
    }
    if (band && (band.nodes !== undefined || band.uciElo !== undefined)) {
      return {
        kind: "limitStrength" as const,
        uciElo: band.uciElo ?? 1320,
        nodes: band.nodes,
        movetimeMs: band.nodes === undefined ? REFERENCE_MOVETIME_MS : undefined,
      };
    }
  }
  return plan;
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
  botParams: ReturnType<typeof planFor>;
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
  | { kind: "bot"; rating: number; plan: ReturnType<typeof planFor>; engine: NodeEngine }
  | { kind: "ref"; engine: NodeEngine };

async function playGame(args: Args, gameIndex: number): Promise<GameRecord> {
  const t0 = performance.now();
  const seed = (args.seed * 1_000_003 + gameIndex * 7919) >>> 0;
  const rng = mulberry32(seed);
  const botColor: "w" | "b" = gameIndex % 2 === 0 ? "w" : "b";
  const botPlan = planFor(args.bot, args.paramsFile);

  const botEngine = new NodeEngine();
  await botEngine.init({
    chess960: false,
    hashMb: 96,
    limitStrengthElo: botPlan.kind === "limitStrength" ? botPlan.uciElo : undefined,
  });
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
    const oppPlanForInit = planFor(args.opponentBot as number, args.paramsFile);
    await opponentEngine.init({
      chess960: false,
      hashMb: 96,
      limitStrengthElo:
        oppPlanForInit.kind === "limitStrength" ? oppPlanForInit.uciElo : undefined,
    });
    const oppPlan = planFor(args.opponentBot as number, args.paramsFile);
    opponent = {
      kind: "bot",
      rating: args.opponentBot as number,
      plan: oppPlan,
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

  try {
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
      ? { kind: "bot", rating: args.bot, plan: botPlan, engine: botEngine }
      : opponent;

    let uci: string | null = null;
    if (mover.kind === "ref") {
      // Movetime searches are self-limiting; the budget only guards a
      // wedge (3× the asked time + grace is far past any honest overrun).
      uci = await mover.engine.bestMove(
        START_FEN,
        moves,
        args.refMovetimeMs,
        Math.max(10_000, args.refMovetimeMs * 3 + 2_000)
      );
    } else if (mover.plan.kind === "limitStrength") {
      // Engine-native weakening: the limiter's own bestmove, bounded by the
      // ruler movetime (anchor bands) or a node cap (sub-floor bands).
      uci = await mover.engine.bestMove(
        START_FEN,
        moves,
        mover.plan.nodes !== undefined
          ? { nodes: mover.plan.nodes }
          : { movetimeMs: mover.plan.movetimeMs ?? REFERENCE_MOVETIME_MS },
        Math.max(10_000, REFERENCE_MOVETIME_MS * 3 + 2_000)
      );
    } else {
      const plan = mover.plan;
      const deep = await mover.engine.analyze(
        START_FEN,
        moves,
        { depth: plan.depth, multipv: plan.multipv },
        budgetForMs(plan.depth, plan.multipv)
      );
      if (deep.truncated) {
        console.warn(
          `[watchdog] g${gameIndex} ply ${moves.length}: search truncated at budget (stop honored) — continuing`
        );
      }
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
      const choice = selectOrganicMove(plan, deep.infos, rng);
      if (moverIsBot && choice) {
        botMoves++;
        byKind[choice.kind]++;
        branchMoves++;
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
  } finally {
    // Quit even when a wedge throws mid-game — never leak engine children.
    botEngine.quit();
    for (const engine of extraEngines) engine.quit();
  }

  return {
    game: gameIndex,
    seed,
    botColor,
    opening,
    score,
    plies: moves.length,
    endReason,
    botParams: botPlan,
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
    let record;
    try {
      record = await playGame(args, gameIndex);
    } catch (error) {
      if (error instanceof NodeEngineWedgedError) {
        // §3.3 for self-play: the wedged child was killed; VOID the game
        // (nothing appended), so the line-count checkpoint replays this
        // index on the next invocation. A wedge never hangs the run again.
        console.warn(`[watchdog] g${gameIndex} VOIDED: ${error.message}`);
        continue;
      }
      throw error;
    }
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
