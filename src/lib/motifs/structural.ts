import { attacks } from "chessops/attacks";
import { opposite } from "chessops/util";
import type { Color, Square } from "chessops";
import { GamePosition } from "@/lib/chess/position";
import {
  attackersOf,
  posFromFen,
  safeSquares,
  SEE_VALUES,
  see,
  squareName,
  uciSquares,
  type Pos,
} from "./primitives";
import { EVIDENCE_CLASS, pawnDefects, type Ctx, type MotifDetection } from "./detect";

/**
 * STRUCTURAL detector class (C2.3 extension): positional mechanisms. Same
 * contract as every other detector — pure predicates over the stored
 * record, decidable geometry, evidence carries the squares that fired. No
 * eval-only pattern matching. Ranked BELOW geometric (EVIDENCE_CLASS
 * .structural): where a tactical mechanism exists it is always the better
 * explanation. Confidence 0.75 across the class.
 */

const CONF = 0.75;

const fileOf = (s: Square) => s % 8;
const rankOf = (s: Square) => Math.floor(s / 8);

/** Can a pawn of `color` at `pawn` EVER attack `target` (pure geometry)? */
function canEverAttack(pawn: Square, color: Color, target: Square): boolean {
  if (Math.abs(fileOf(pawn) - fileOf(target)) !== 1) return false;
  return color === "white" ? rankOf(pawn) < rankOf(target) : rankOf(pawn) > rankOf(target);
}

/** Number of `color` pawns in `pos` that could ever attack `target`. */
function coverCount(pos: Pos, color: Color, target: Square): number {
  let count = 0;
  for (const pawn of pos.board.pawn.intersect(pos.board[color])) {
    if (canEverAttack(pawn, color, target)) count++;
  }
  return count;
}

/** Squares in `color`'s own half where enemy pieces plant (ranks 2–4 / 5–7). */
function halfSquares(color: Color): Square[] {
  const ranks = color === "white" ? [1, 2, 3] : [4, 5, 6];
  const squares: Square[] = [];
  for (const rank of ranks) for (let file = 0; file < 8; file++) squares.push(rank * 8 + file);
  return squares;
}

/** Attack-square count of the piece at `square`, own-occupied excluded. */
function pieceScope(pos: Pos, square: Square): number {
  const piece = pos.board.get(square);
  if (!piece) return 0;
  return attacks(piece, square, pos.board.occupied).diff(pos.board[piece.color]).size();
}

function isPawnMove(ctx: Ctx): boolean {
  try {
    const { from } = uciSquares(ctx.input.movedUci);
    return ctx.before.board.pawn.has(from);
  } catch {
    return false;
  }
}

function movedFromTo(ctx: Ctx): { from: Square; to: Square } | null {
  try {
    const { from, to } = uciSquares(ctx.input.movedUci);
    return { from, to };
  } catch {
    return null;
  }
}

/**
 * HOLE_CREATED — a pawn move permanently removes the LAST own pawn able to
 * cover a square in your half, and the refutation occupies it or lands a
 * piece bearing on it.
 */
export function holeCreated(ctx: Ctx): MotifDetection | null {
  if (!isPawnMove(ctx)) return null;
  const move = movedFromTo(ctx);
  if (!move) return null;
  const opponent = opposite(ctx.mover);
  for (const s of halfSquares(ctx.mover)) {
    if (!canEverAttack(move.from, ctx.mover, s)) continue; // only squares this pawn guarded
    if (coverCount(ctx.before, ctx.mover, s) === 0) continue; // was already a hole
    if (coverCount(ctx.after, ctx.mover, s) !== 0) continue; // still coverable
    // Refutation interacts with the hole: an enemy non-pawn lands ON it, or
    // lands where it attacks it.
    for (const [index, step] of ctx.refutationSteps.entries()) {
      if (step.mover === ctx.mover) continue;
      let to: Square;
      try {
        to = uciSquares(step.uci).to;
      } catch {
        break;
      }
      const fen = ctx.refutationFens[index + 1];
      if (!fen) break;
      const posAtStep = posFromFen(fen);
      const lander = posAtStep.board.get(to);
      if (!lander || lander.color !== opponent || lander.role === "pawn") continue;
      const occupies = to === s;
      const bears = attacks(lander, to, posAtStep.board.occupied).has(s);
      if (occupies || bears) {
        return {
          motif: "HOLE_CREATED",
          confidence: CONF,
          evidenceClass: EVIDENCE_CLASS.structural,
          stakeCp: 150,
          evidence: {
            hole: squareName(s),
            pawnMove: ctx.input.movedUci,
            refutationPiece: lander.role,
            at: occupies ? "occupies" : "bears",
            refutationPly: index + 1,
          },
        };
      }
    }
  }
  return null;
}

/**
 * OUTPOST_CONCEDED — after the move an enemy minor reaches (or stands ready
 * to reach) a square in your half that an enemy pawn defends and no pawn of
 * yours can ever contest; the concession happened on THIS move.
 */
export function outpostConceded(ctx: Ctx): MotifDetection | null {
  const opponent = opposite(ctx.mover);
  const enemyMinors = ctx.after.board.knight
    .union(ctx.after.board.bishop)
    .intersect(ctx.after.board[opponent]);
  for (const s of halfSquares(ctx.mover)) {
    if (coverCount(ctx.after, ctx.mover, s) !== 0) continue;
    // Enemy pawn defends S now.
    const pawnDefended = [...ctx.after.board.pawn.intersect(ctx.after.board[opponent])].some(
      (pawn) => attacks({ role: "pawn", color: opponent }, pawn, ctx.after.board.occupied).has(s)
    );
    if (!pawnDefended) continue;
    // Concession is NEW: before the move, either we could still contest S,
    // or no minor stood ready against a defended hole there.
    const wasHole = coverCount(ctx.before, ctx.mover, s) === 0;

    // A minor OCCUPIES S in the refutation…
    let occupied: { role: string; ply: number } | null = null;
    for (const [index, step] of ctx.refutationSteps.slice(0, 6).entries()) {
      if (step.mover === ctx.mover) continue;
      try {
        if (uciSquares(step.uci).to !== s) continue;
      } catch {
        break;
      }
      const fen = ctx.refutationFens[index + 1];
      const lander = fen ? posFromFen(fen).board.get(s) : undefined;
      if (lander && (lander.role === "knight" || lander.role === "bishop")) {
        occupied = { role: lander.role, ply: index + 1 };
        break;
      }
    }
    // …or stands ready (attacks S) right after the move.
    const ready =
      occupied === null &&
      [...enemyMinors].some((minor) => {
        const piece = ctx.after.board.get(minor);
        return piece && attacks(piece, minor, ctx.after.board.occupied).has(s);
      });
    if (!occupied && !ready) continue;
    if (wasHole && !occupied) continue; // pre-existing hole, nothing concrete happened
    return {
      motif: "OUTPOST_CONCEDED",
      confidence: CONF,
      evidenceClass: EVIDENCE_CLASS.structural,
      stakeCp: 200,
      evidence: {
        outpost: squareName(s),
        pawnDefended: true,
        how: occupied ? `occupied by ${occupied.role} at refutation ply ${occupied.ply}` : "minor stands ready",
      },
    };
  }
  return null;
}

/**
 * BISHOP_PAIR_SURRENDERED — bishop takes knight while holding the pair, the
 * refutation recaptures, and the position is open (≥2 open/semi-open files).
 */
export function bishopPairSurrendered(ctx: Ctx): MotifDetection | null {
  const move = movedFromTo(ctx);
  if (!move) return null;
  const moved = ctx.before.board.get(move.from);
  const captured = ctx.before.board.get(move.to);
  if (!moved || moved.role !== "bishop" || !captured || captured.role !== "knight") return null;
  if (ctx.before.board.bishop.intersect(ctx.before.board[ctx.mover]).size() < 2) return null;
  const recapture = ctx.refutationSteps[0];
  if (!recapture || recapture.mover === ctx.mover) return null;
  try {
    if (uciSquares(recapture.uci).to !== move.to) return null;
  } catch {
    return null;
  }
  let openish = 0;
  for (let file = 0; file < 8; file++) {
    let white = 0;
    let black = 0;
    for (const pawn of ctx.after.board.pawn) {
      if (fileOf(pawn) !== file) continue;
      if (ctx.after.board.white.has(pawn)) white++;
      else black++;
    }
    if (white === 0 || black === 0) openish++;
  }
  if (openish < 2) return null;
  return {
    motif: "BISHOP_PAIR_SURRENDERED",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 150,
    evidence: { trade: ctx.input.movedSan, openOrSemiOpenFiles: openish },
  };
}

/**
 * STRUCTURE_DAMAGED — the move adds a pawn defect (doubled/isolated/
 * backward) on your own structure with no open file, activity, or material
 * in return.
 */
export function structureDamaged(ctx: Ctx): MotifDetection | null {
  const before = pawnDefects(ctx.before, ctx.mover) + backwardPawns(ctx.before, ctx.mover);
  const after = pawnDefects(ctx.after, ctx.mover) + backwardPawns(ctx.after, ctx.mover);
  if (after - before < 1) return null;
  // Compensation checks — any of these excuses the defect.
  if (ctx.input.movedSan.includes("x")) {
    let captureSee = 0;
    try {
      captureSee = see(ctx.before, ctx.input.movedUci);
    } catch {
      captureSee = 0;
    }
    if (captureSee >= 0) return null; // won or traded material
  }
  if (halfOpenFiles(ctx.after, ctx.mover) > halfOpenFiles(ctx.before, ctx.mover)) return null;
  const net = ctx.refutationSteps
    .slice(0, 4)
    .reduce(
      (sum, step) => sum + (step.mover === ctx.mover ? step.capturedValue : -step.capturedValue),
      0
    );
  if (net > 0) return null; // refutation nets us material anyway
  return {
    motif: "STRUCTURE_DAMAGED",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 120,
    evidence: { defectsBefore: before, defectsAfter: after, move: ctx.input.movedSan },
  };
}

/** Files with no own pawn (rook files for `color`). */
function halfOpenFiles(pos: Pos, color: Color): number {
  const files = new Set<number>();
  for (const pawn of pos.board.pawn.intersect(pos.board[color])) files.add(fileOf(pawn));
  return 8 - files.size;
}

/** Backward pawns: unsupportable from behind and stop-square pawn-controlled. */
function backwardPawns(pos: Pos, color: Color): number {
  const opponent = opposite(color);
  let count = 0;
  for (const pawn of pos.board.pawn.intersect(pos.board[color])) {
    const stop = color === "white" ? pawn + 8 : pawn - 8;
    if (stop < 0 || stop > 63) continue;
    const supportable = [...pos.board.pawn.intersect(pos.board[color])].some(
      (other) =>
        other !== pawn &&
        Math.abs(fileOf(other) - fileOf(pawn)) === 1 &&
        (color === "white" ? rankOf(other) <= rankOf(pawn) : rankOf(other) >= rankOf(pawn))
    );
    if (supportable) continue;
    const stopControlled = [...pos.board.pawn.intersect(pos.board[opponent])].some((enemy) =>
      attacks({ role: "pawn", color: opponent }, enemy, pos.board.occupied).has(stop)
    );
    if (stopControlled) count++;
  }
  return count;
}

/**
 * BAD_PIECE_PLACEMENT — the moved piece's scope collapses and its safe
 * squares shrink at the destination, with no route back inside four
 * refutation plies.
 */
export function badPiecePlacement(ctx: Ctx): MotifDetection | null {
  const move = movedFromTo(ctx);
  if (!move) return null;
  // "No route back within four plies" is a claim about the refutation —
  // with fewer than four plies recorded it is unverifiable: abstain.
  if (ctx.refutationSteps.length < 4) return null;
  const piece = ctx.before.board.get(move.from);
  if (!piece || piece.role === "pawn" || piece.role === "king") return null;
  if (ctx.input.movedSan.includes("x")) return null; // material excuses placement
  const scopeBefore = pieceScope(ctx.before, move.from);
  const scopeAfter = pieceScope(ctx.after, move.to);
  if (!(scopeAfter <= Math.floor(scopeBefore / 2) && scopeAfter <= 4 && scopeBefore >= 6)) {
    return null;
  }
  if (safeSquares(ctx.after, move.to).size() >= safeSquares(ctx.before, move.from).size()) {
    return null;
  }
  // Route back: within 4 refutation plies the mover re-deploys it to a
  // square with most of its old scope; captured ⇒ a tactical story, not ours.
  let square = move.to;
  for (const [index, step] of ctx.refutationSteps.slice(0, 4).entries()) {
    let from: Square;
    let to: Square;
    try {
      ({ from, to } = uciSquares(step.uci));
    } catch {
      break;
    }
    if (step.mover !== ctx.mover && to === square) return null; // it gets captured
    if (step.mover === ctx.mover && from === square) {
      const fen = ctx.refutationFens[index + 1];
      if (fen && pieceScope(posFromFen(fen), to) >= Math.ceil(scopeBefore * 0.75)) {
        return null; // route back exists
      }
      square = to;
    }
  }
  return {
    motif: "BAD_PIECE_PLACEMENT",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: SEE_VALUES[piece.role] / 2,
    evidence: {
      piece: piece.role,
      to: squareName(move.to),
      scopeBefore,
      scopeAfter,
    },
  };
}

/**
 * FILE_OPENED_TOWARD_OWN_KING — the move vacates a line and an enemy slider
 * now bears on your king zone through the vacated square.
 */
export function fileOpenedTowardOwnKing(ctx: Ctx): MotifDetection | null {
  const move = movedFromTo(ctx);
  if (!move) return null;
  const opponent = opposite(ctx.mover);
  const king = ctx.after.board.kingOf(ctx.mover);
  if (king === undefined) return null;
  const zone = new Set<Square>([king]);
  for (const df of [-1, 0, 1]) {
    for (const dr of [-1, 0, 1]) {
      const s = king + dr * 8 + df;
      if (s >= 0 && s < 64 && Math.abs(fileOf(s) - fileOf(king)) <= 1) zone.add(s);
    }
  }
  const sliders = ctx.after.board.queen
    .union(ctx.after.board.rook)
    .union(ctx.after.board.bishop)
    .intersect(ctx.after.board[opponent]);
  for (const sliderSq of sliders) {
    const piece = ctx.after.board.get(sliderSq);
    if (!piece) continue;
    const nowHits = [...attacks(piece, sliderSq, ctx.after.board.occupied)].filter((s) =>
      zone.has(s)
    );
    if (nowHits.length === 0) continue;
    const beforePiece = ctx.before.board.get(sliderSq);
    const beforeHits =
      beforePiece !== undefined
        ? [...attacks(beforePiece, sliderSq, ctx.before.board.occupied)].filter((s) => zone.has(s))
        : [];
    const gained = nowHits.filter((s) => !beforeHits.includes(s));
    if (gained.length === 0) continue;
    // Attribution: our from-square sat on the newly opened line.
    const attributable = gained.some((target) => {
      const line = attacks(piece, sliderSq, ctx.after.board.occupied.without(move.from));
      return line.has(target) && onSegment(sliderSq, target, move.from);
    });
    if (!attributable) continue;
    return {
      motif: "FILE_OPENED_TOWARD_OWN_KING",
      confidence: CONF,
      evidenceClass: EVIDENCE_CLASS.structural,
      stakeCp: 250,
      evidence: {
        slider: `${piece.role}@${squareName(sliderSq)}`,
        bearsOn: gained.map(squareName),
        vacated: squareName(move.from),
      },
    };
  }
  return null;
}

/** Is `mid` strictly between `a` and `b` on their shared rank/file/diagonal? */
function onSegment(a: Square, b: Square, mid: Square): boolean {
  const df = Math.sign(fileOf(b) - fileOf(a));
  const dr = Math.sign(rankOf(b) - rankOf(a));
  let s = a;
  for (let i = 0; i < 8; i++) {
    const nextFile = fileOf(s) + df;
    const nextRank = rankOf(s) + dr;
    if (nextFile < 0 || nextFile > 7 || nextRank < 0 || nextRank > 7) return false;
    s = nextRank * 8 + nextFile;
    if (s === b) return false;
    if (s === mid) return true;
  }
  return false;
}

/**
 * SPACE_CONCEDED — pawn control of the 16 central squares drops by ≥2 and
 * every lost square is permanently uncontestable by your pawns.
 */
export function spaceConceded(ctx: Ctx): MotifDetection | null {
  const centre: Square[] = [];
  for (let rank = 2; rank <= 5; rank++) for (let file = 2; file <= 5; file++) centre.push(rank * 8 + file);
  const controlled = (pos: Pos): Set<Square> => {
    const set = new Set<Square>();
    for (const pawn of pos.board.pawn.intersect(pos.board[ctx.mover])) {
      for (const s of attacks({ role: "pawn", color: ctx.mover }, pawn, pos.board.occupied)) {
        if (centre.includes(s)) set.add(s);
      }
    }
    return set;
  };
  const before = controlled(ctx.before);
  const after = controlled(ctx.after);
  const lost = [...before].filter((s) => !after.has(s));
  if (lost.length < 2) return null;
  const permanent = lost.filter((s) => coverCount(ctx.after, ctx.mover, s) === 0);
  if (permanent.length < 2) return null;
  return {
    motif: "SPACE_CONCEDED",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 100 * permanent.length,
    evidence: { lostCentralSquares: permanent.map(squareName), move: ctx.input.movedSan },
  };
}

/**
 * GOOD_PIECE_TRADED — an equal-value trade initiated by you that swaps your
 * clearly more mobile piece for their cramped one, with nothing structural
 * or material gained.
 */
export function goodPieceTraded(ctx: Ctx): MotifDetection | null {
  const move = movedFromTo(ctx);
  if (!move) return null;
  const ours = ctx.before.board.get(move.from);
  const theirs = ctx.before.board.get(move.to);
  if (!ours || !theirs || ours.role === "pawn" || ours.role === "king") return null;
  if (Math.abs(SEE_VALUES[ours.role] - SEE_VALUES[theirs.role]) > 50) return null; // equal-class trade only
  const recapture = ctx.refutationSteps[0];
  if (!recapture || recapture.mover === ctx.mover) return null;
  try {
    if (uciSquares(recapture.uci).to !== move.to) return null;
  } catch {
    return null;
  }
  const ourScope = pieceScope(ctx.before, move.from);
  const theirScope = pieceScope(ctx.before, move.to);
  if (ourScope < theirScope + 4) return null;
  // Structural gain excuses it (their defects rise or ours fall).
  const afterRecapture = ctx.refutationFens[1] ? posFromFen(ctx.refutationFens[1]) : null;
  if (afterRecapture) {
    const opponent = opposite(ctx.mover);
    if (
      pawnDefects(afterRecapture, opponent) > pawnDefects(ctx.before, opponent) ||
      pawnDefects(afterRecapture, ctx.mover) < pawnDefects(ctx.before, ctx.mover)
    ) {
      return null;
    }
  }
  return {
    motif: "GOOD_PIECE_TRADED",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 120,
    evidence: {
      trade: ctx.input.movedSan,
      ourScope,
      theirScope,
      piece: ours.role,
    },
  };
}

/**
 * PAWN_BREAK_MISSED — the engine's move was a pawn break, you played a
 * quiet piece move, and the break is off the table within four plies.
 */
export function pawnBreakMissed(ctx: Ctx): MotifDetection | null {
  const best = ctx.input.bestPv[0];
  if (!best || best === ctx.input.movedUci) return null;
  let bestFrom: Square;
  let bestTo: Square;
  try {
    ({ from: bestFrom, to: bestTo } = uciSquares(best));
  } catch {
    return null;
  }
  const bestPiece = ctx.before.board.get(bestFrom);
  if (!bestPiece || bestPiece.role !== "pawn") return null;
  const opponent = opposite(ctx.mover);
  const enemyPawns = ctx.before.board.pawn.intersect(ctx.before.board[opponent]);
  const isBreak =
    enemyPawns.has(bestTo) || // captures a pawn
    [...attacks({ role: "pawn", color: ctx.mover }, bestTo, ctx.before.board.occupied)].some((s) =>
      enemyPawns.has(s)
    ); // or lands attacking one
  if (!isBreak) return null;
  // Played: quiet non-pawn, non-capture, non-check.
  if (isPawnMove(ctx)) return null;
  if (ctx.input.movedSan.includes("x") || ctx.input.movedSan.includes("+")) return null;
  // Break still available within four plies? Then the miss is not
  // permanent. Available = the same move is legal AND still a break
  // (captures a pawn or lands attacking one) in that position.
  for (const [index, step] of ctx.refutationSteps.slice(0, 4).entries()) {
    if (step.mover !== ctx.mover) continue;
    const fen = ctx.refutationFens[index]; // position when it's our turn
    if (!fen) break;
    try {
      const at = posFromFen(fen);
      const enemyPawnsAt = at.board.pawn.intersect(at.board[opponent]);
      const stillBreak =
        enemyPawnsAt.has(bestTo) ||
        [...attacks({ role: "pawn", color: ctx.mover }, bestTo, at.board.occupied)].some((s) =>
          enemyPawnsAt.has(s)
        );
      if (!stillBreak) continue;
      const probe = GamePosition.fromFen(fen, ctx.variant);
      if (probe.moveUci(best)) return null;
    } catch {
      break;
    }
  }
  return {
    motif: "PAWN_BREAK_MISSED",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 130,
    evidence: { break: best, played: ctx.input.movedSan },
  };
}

/**
 * KING_WALK — the king steps toward enemy fire: strictly more enemy
 * attacks INTO its zone (a legal king move can never land on a directly
 * attacked square, so pressure is measured on the 3×3 zone) and fewer
 * escape squares, outside an endgame.
 */
export function kingWalk(ctx: Ctx): MotifDetection | null {
  const move = movedFromTo(ctx);
  if (!move) return null;
  const piece = ctx.before.board.get(move.from);
  if (!piece || piece.role !== "king") return null;
  if (ctx.input.movedSan.startsWith("O-O")) return null;
  // Outside an endgame: ≥6 non-pawn, non-king pieces on the board.
  const heavy =
    ctx.before.board.occupied.diff(ctx.before.board.pawn).diff(ctx.before.board.king).size();
  if (heavy < 6) return null;
  const opponent = opposite(ctx.mover);
  const zonePressure = (pos: Pos, kingSq: Square): number => {
    let pressure = 0;
    for (const df of [-1, 0, 1]) {
      for (const dr of [-1, 0, 1]) {
        const s = kingSq + dr * 8 + df;
        if (s < 0 || s > 63 || Math.abs(fileOf(s) - fileOf(kingSq)) > 1) continue;
        pressure += attackersOf(pos.board, s, opponent).size();
      }
    }
    return pressure;
  };
  const pressureBefore = zonePressure(ctx.before, move.from);
  const pressureAfter = zonePressure(ctx.after, move.to);
  if (pressureAfter <= pressureBefore) return null;
  const escapes = (pos: Pos, kingSq: Square): number => {
    let count = 0;
    for (const s of attacks({ role: "king", color: ctx.mover }, kingSq, pos.board.occupied)) {
      if (pos.board[ctx.mover].has(s)) continue;
      if (attackersOf(pos.board, s, opponent).nonEmpty()) continue;
      count++;
    }
    return count;
  };
  if (escapes(ctx.after, move.to) >= escapes(ctx.before, move.from)) return null;
  return {
    motif: "KING_WALK",
    confidence: CONF,
    evidenceClass: EVIDENCE_CLASS.structural,
    stakeCp: 300,
    evidence: {
      from: squareName(move.from),
      to: squareName(move.to),
      zonePressureBefore: pressureBefore,
      zonePressureAfter: pressureAfter,
    },
  };
}

/** The full structural pass, in a stable order (dedupe happens in detect). */
export function structuralDetectors(ctx: Ctx): MotifDetection[] {
  const fired: MotifDetection[] = [];
  for (const detector of [
    fileOpenedTowardOwnKing,
    kingWalk,
    outpostConceded,
    holeCreated,
    bishopPairSurrendered,
    goodPieceTraded,
    badPiecePlacement,
    pawnBreakMissed,
    structureDamaged,
    spaceConceded,
  ]) {
    const detection = detector(ctx);
    if (detection) fired.push(detection);
  }
  return fired;
}
