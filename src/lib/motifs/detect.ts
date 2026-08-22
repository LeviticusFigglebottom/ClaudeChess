import { opposite } from "chessops/util";
import type { Color, Square } from "chessops";
import { GamePosition } from "@/lib/chess/position";
import { isVariantId, type VariantId } from "@/lib/chess/variant";
import {
  attackersOf,
  defendersOf,
  discoveredBy,
  isForcing,
  kingZoneAttackers,
  kingZone,
  mobility,
  pinInfo,
  posFromFen,
  safeSquares,
  see,
  squareName,
  uciSquares,
  SEE_VALUES,
  type Pos,
} from "./primitives";
import { attacks, ray, between } from "chessops/attacks";

/**
 * C2.3 deterministic motif detectors. A motif is a property of the
 * REFUTATION — the engine's punishing line after the mistake — combined with
 * board geometry. Every detector is a pure predicate over the stored
 * analysis record: no I/O, no engine, sub-millisecond. Evidence carries the
 * squares and PV indices that fired, which C3 renders and the C5
 * explanation call consumes as proven input.
 *
 * Confidence encodes evidence class (C2.4): tablebase 1.0 > mate 0.95 >
 * SEE 0.9 > geometric 0.85 > data-computed 1.0 (ranked below despite the
 * number — the class ranks, not the confidence) > heuristic 0.6.
 */

export type MotifName =
  | "HANGING_PIECE"
  | "OVERLOADED_DEFENDER"
  | "PINNED_PIECE_MOVED"
  | "BACK_RANK"
  | "FORK_ALLOWED"
  | "SKEWER_ALLOWED"
  | "DISCOVERED_ATTACK_MISSED"
  | "TRAPPED_PIECE"
  | "REMOVING_THE_DEFENDER"
  | "ZWISCHENZUG_MISSED"
  | "KING_SAFETY_COLLAPSE"
  | "PAWN_STRUCTURE_COLLAPSE"
  | "MATERIALISM"
  | "PREMATURE_ATTACK"
  | "PASSIVITY"
  | "ENDGAME_TECHNIQUE"
  | "PAWN_RACE_MISCOUNT"
  | "OPPOSITION_LOST"
  | "TIME_PRESSURE"
  | "TUNNEL_VISION_POST_FORCING"
  | "UNCLEAR";

export type Evidence = Record<string, unknown>;

export interface MotifDetection {
  motif: MotifName;
  confidence: number;
  /** C2.4 evidence class, for ranking: 6 tb, 5 mate, 4 see, 3 geo, 2 data, 1 heuristic. */
  evidenceClass: number;
  /** Material at stake in cp — the within-class tiebreaker. */
  stakeCp: number;
  evidence: Evidence;
}

export interface TbState {
  wdl: number;
  dtz: number | null;
}

export interface MotifDetectionInput {
  variant: string;
  fenBefore: string;
  fenAfter: string;
  movedUci: string;
  movedSan: string;
  /** pv1 of the pre-move position (what should have been played). */
  bestPv: string[];
  /** pv1 of the post-move position (the opponent's punishment). */
  refutationPv: string[];
  wpLoss: number;
  clockMsRemaining: number | null;
  tbBefore: TbState | null;
  tbBeforeHit: boolean;
  tbAfter: TbState | null;
  /** Previous ≥3 plies were all checks/captures/promotions. */
  priorForcingRun: boolean;
  /** The mover's recent SANs (oldest→newest, ending at this ply). */
  recentOwnSans: string[];
  /** This move recaptured on the square the opponent just captured on. */
  playedIsRecapture?: boolean;
  /**
   * Mobility across the quiet run (C2.3 PASSIVITY: "dropped over a run of
   * three or more non-forcing moves"): mover's mobility at the run's start
   * vs after this move. Computed by the adapter from stored positions.
   */
  runMobility?: { start: number; end: number };
}

interface Ctx {
  input: MotifDetectionInput;
  variant: VariantId;
  before: Pos;
  after: Pos;
  mover: Color;
  /** Refutation replay: FEN after each refutation ply (index 0 = posAfter). */
  refutationFens: string[];
  /** Per refutation move: capture info (victim square/role) before it was played. */
  refutationSteps: {
    uci: string;
    mover: Color;
    capturedSquare: Square | null;
    capturedValue: number;
    isPromotion: boolean;
  }[];
  /** Position after the whole refutation line. */
  finalPos: GamePosition;
  finalIsMate: boolean;
}

function buildCtx(input: MotifDetectionInput): Ctx | null {
  const variant = isVariantId(input.variant) ? input.variant : "standard";
  let before: Pos;
  let after: Pos;
  try {
    before = posFromFen(input.fenBefore);
    after = posFromFen(input.fenAfter);
  } catch {
    return null;
  }
  const mover = before.turn;

  const refutationFens: string[] = [input.fenAfter];
  const refutationSteps: Ctx["refutationSteps"] = [];
  const replay = GamePosition.fromFen(input.fenAfter, variant);
  for (const uci of input.refutationPv.slice(0, 12)) {
    let capturedSquare: Square | null = null;
    let capturedValue = 0;
    try {
      const { to } = uciSquares(uci);
      const target = replay.pieceAt(squareName(to));
      if (target) {
        capturedSquare = to;
        capturedValue =
          SEE_VALUES[
            target.role === "knight" ? "knight" : target.role
          ] ?? 0;
      }
    } catch {
      break;
    }
    const stepMover: Color = replay.turn === "w" ? "white" : "black";
    const applied = replay.moveUci(uci);
    if (!applied) break;
    // En-passant: SAN says capture but target square was empty.
    if (capturedSquare === null && applied.san.includes("x")) {
      capturedValue = SEE_VALUES.pawn;
      capturedSquare = uciSquares(uci).to;
    }
    refutationSteps.push({
      uci,
      mover: stepMover,
      capturedSquare,
      capturedValue,
      isPromotion: uci.length === 5,
    });
    refutationFens.push(replay.fen());
  }

  return {
    input,
    variant,
    before,
    after,
    mover,
    refutationFens,
    refutationSteps,
    finalPos: replay,
    finalIsMate: replay.isCheckmate(),
  };
}

const wdlClass = (wdl: number): number => (wdl >= 2 ? 2 : wdl <= -2 ? 0 : 1);

// --- Tablebase-proven (C2.3, confidence 1.0) ---

function tbDetectors(ctx: Ctx): MotifDetection[] {
  const { input } = ctx;
  if (!input.tbBeforeHit || !input.tbBefore || !input.tbAfter) return [];
  // tbBefore is side-to-move POV of posBefore = mover POV; tbAfter is the
  // opponent's POV → negate for the mover.
  const beforeClass = wdlClass(input.tbBefore.wdl);
  const afterClass = wdlClass(-input.tbAfter.wdl);
  if (afterClass >= beforeClass) return [];

  const detections: MotifDetection[] = [];
  const evidence: Evidence = {
    wdlBefore: input.tbBefore.wdl,
    wdlAfterMoverPov: -input.tbAfter.wdl,
    degraded: `${["loss", "draw", "win"][beforeClass]}→${["loss", "draw", "win"][afterClass]}`,
  };

  const pieces = (input.fenBefore.split(" ")[0] ?? "").match(/[a-zA-Z]/g) ?? [];
  const pieceCount = pieces.length;
  const kingsAndPawnsOnly = pieces.every((p) => "kpKP".includes(p));
  const movedIsKing = (() => {
    try {
      const { from } = uciSquares(input.movedUci);
      return ctx.before.board.king.has(from);
    } catch {
      return false;
    }
  })();

  if (pieceCount <= 5 && kingsAndPawnsOnly && movedIsKing) {
    detections.push({
      motif: "OPPOSITION_LOST",
      confidence: 1.0,
      evidenceClass: 6,
      stakeCp: 900,
      evidence: { ...evidence, pieceCount, kingMove: input.movedUci },
    });
  }

  const bothHavePassers = hasPassedPawns(ctx.before, "white") && hasPassedPawns(ctx.before, "black");
  const refutationPromotes = ctx.refutationSteps.some((step) => step.isPromotion);
  if (bothHavePassers && refutationPromotes) {
    detections.push({
      motif: "PAWN_RACE_MISCOUNT",
      confidence: 1.0,
      evidenceClass: 6,
      stakeCp: 800,
      evidence: { ...evidence, refutationPromotes: true },
    });
  }

  detections.push({
    motif: "ENDGAME_TECHNIQUE",
    confidence: 1.0,
    evidenceClass: 6,
    stakeCp: 500,
    evidence,
  });
  return detections;
}

function hasPassedPawns(pos: Pos, color: Color): boolean {
  const own = pos.board.pawn.intersect(pos.board[color]);
  const enemyPawns = pos.board.pawn.intersect(pos.board[opposite(color)]);
  for (const pawn of own) {
    const file = pawn % 8;
    const rank = Math.floor(pawn / 8);
    let blocked = false;
    for (const enemy of enemyPawns) {
      const enemyFile = enemy % 8;
      const enemyRank = Math.floor(enemy / 8);
      if (Math.abs(enemyFile - file) <= 1) {
        if (color === "white" ? enemyRank > rank : enemyRank < rank) {
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) return true;
  }
  return false;
}

// --- Mate-proven (0.95) ---

function backRank(ctx: Ctx): MotifDetection | null {
  if (!ctx.finalIsMate) return null;
  const lastStep = ctx.refutationSteps.at(-1);
  if (!lastStep || lastStep.mover === ctx.mover) return null; // opponent delivers mate
  const matedKing = ctx.finalPos.turn; // side to move in final position is mated
  if ((matedKing === "w" ? "white" : "black") !== ctx.mover) return null;

  const finalGeo = posFromFen(ctx.refutationFens.at(-1)!);
  const king = finalGeo.board.kingOf(ctx.mover);
  if (king === undefined) return null;
  const backRankIndex = ctx.mover === "white" ? 0 : 7;
  if (Math.floor(king / 8) !== backRankIndex) return null;
  const { to: matingSquare } = uciSquares(lastStep.uci);
  if (Math.floor(matingSquare / 8) !== backRankIndex) return null;

  // Forward escape squares all occupied by the king's own pawns.
  const forward = ctx.mover === "white" ? 8 : -8;
  const file = king % 8;
  const escapes: Square[] = [];
  for (const df of [-1, 0, 1]) {
    const s = king + forward + df;
    if (s >= 0 && s < 64 && Math.abs((s % 8) - file) <= 1) escapes.push(s);
  }
  const ownPawns = finalGeo.board.pawn.intersect(finalGeo.board[ctx.mover]);
  if (!escapes.every((s) => ownPawns.has(s))) return null;

  return {
    motif: "BACK_RANK",
    confidence: 0.95,
    evidenceClass: 5,
    stakeCp: 10_000,
    evidence: {
      matingSquare: squareName(matingSquare),
      king: squareName(king),
      pawnShield: escapes.map(squareName),
      mateInPlies: ctx.refutationSteps.length,
    },
  };
}

// --- SEE-proven (0.9) ---

function hangingPiece(ctx: Ctx): MotifDetection | null {
  const first = ctx.refutationSteps[0];
  if (!first || first.capturedSquare === null || first.capturedValue === 0) return null;
  const square = first.capturedSquare;
  const piece = ctx.after.board.get(square);
  if (!piece || piece.color !== ctx.mover) return null;
  const opponent = opposite(ctx.mover);
  if (attackersOf(ctx.after.board, square, opponent).isEmpty()) return null;
  const captureSee = see(ctx.after, first.uci);
  if (captureSee <= 0) return null;

  const undefended = defendersOf(ctx.after.board, square, ctx.mover).isEmpty();
  return {
    motif: "HANGING_PIECE",
    confidence: undefended ? 0.9 : 0.75,
    evidenceClass: 4,
    stakeCp: first.capturedValue,
    evidence: {
      square: squareName(square),
      piece: piece.role,
      see: captureSee,
      undefended,
      capture: first.uci,
    },
  };
}

function materialism(ctx: Ctx): MotifDetection | null {
  const { input } = ctx;
  if (!input.movedSan.includes("x")) return null;
  if (input.wpLoss < 20) return null;
  // A recapture is completing a trade, not grabbing material (C2.3's
  // "you took the pawn and the position collapsed").
  if (input.playedIsRecapture) return null;
  // Net material for the mover across the refutation.
  let moverGain = 0;
  let opponentGain = 0;
  for (const step of ctx.refutationSteps) {
    if (step.mover === ctx.mover) moverGain += step.capturedValue;
    else opponentGain += step.capturedValue;
  }
  if (moverGain > 100) return null; // material recovered — not materialism
  if (opponentGain < 200 && !ctx.finalIsMate) return null;
  const grabbed = (() => {
    try {
      const { to } = uciSquares(input.movedUci);
      const victim = ctx.before.board.get(to);
      return victim ? { square: squareName(to), role: victim.role } : null;
    } catch {
      return null;
    }
  })();
  return {
    motif: "MATERIALISM",
    confidence: 0.9,
    evidenceClass: 4,
    stakeCp: opponentGain,
    evidence: {
      grabbed,
      moverRecovers: moverGain,
      opponentWins: opponentGain,
      refutationMates: ctx.finalIsMate,
    },
  };
}

// --- Geometric (0.85) ---

function overloadedDefender(ctx: Ctx): MotifDetection | null {
  const [r0, r1, r2] = ctx.refutationSteps;
  if (!r0 || !r1 || !r2) return null;
  if (r0.capturedSquare === null || r2.capturedSquare === null) return null;
  if (r1.mover !== ctx.mover) return null;
  const defender = uciSquares(r1.uci).from;
  // In posAfter, the piece that made the forced reply defended BOTH capture squares.
  const defenderPiece = ctx.after.board.get(defender);
  if (!defenderPiece || defenderPiece.color !== ctx.mover) return null;
  const defendedFirst = defendersOf(ctx.after.board, r0.capturedSquare, ctx.mover).has(defender);
  const defendedSecond = defendersOf(ctx.after.board, r2.capturedSquare, ctx.mover).has(defender);
  if (!defendedFirst || !defendedSecond) return null;
  return {
    motif: "OVERLOADED_DEFENDER",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: r0.capturedValue + r2.capturedValue,
    evidence: {
      defender: squareName(defender),
      defenderPiece: defenderPiece.role,
      defended: [squareName(r0.capturedSquare), squareName(r2.capturedSquare)],
      refutation: [r0.uci, r1.uci, r2.uci],
    },
  };
}

function removingTheDefender(ctx: Ctx): MotifDetection | null {
  const first = ctx.refutationSteps[0];
  if (!first || first.capturedSquare === null) return null;
  const removed = first.capturedSquare;
  const removedPiece = ctx.after.board.get(removed);
  if (!removedPiece || removedPiece.color !== ctx.mover) return null;
  // Later capture in the refutation on a square the removed piece defended.
  for (const [index, step] of ctx.refutationSteps.entries()) {
    if (index === 0 || step.mover === ctx.mover || step.capturedSquare === null) continue;
    if (defendersOf(ctx.after.board, step.capturedSquare, ctx.mover).has(removed)) {
      return {
        motif: "REMOVING_THE_DEFENDER",
        confidence: 0.85,
        evidenceClass: 3,
        stakeCp: first.capturedValue + step.capturedValue,
        evidence: {
          removedDefender: squareName(removed),
          defendedSquare: squareName(step.capturedSquare),
          removingCapture: first.uci,
          winningCapture: step.uci,
          pvIndex: index,
        },
      };
    }
  }
  return null;
}

function pinnedPieceMoved(ctx: Ctx): MotifDetection | null {
  const { from } = (() => {
    try {
      return uciSquares(ctx.input.movedUci);
    } catch {
      return { from: -1 as Square };
    }
  })();
  if (from < 0) return null;
  const pin = pinInfo(ctx.before, from);
  if (!pin.pinned || pin.behind === null) return null;
  // The refutation's first move captures the piece that was behind the pin.
  const first = ctx.refutationSteps[0];
  if (!first || first.capturedSquare !== pin.behind) return null;
  const behindPiece = ctx.before.board.get(pin.behind);
  return {
    motif: "PINNED_PIECE_MOVED",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: behindPiece ? SEE_VALUES[behindPiece.role] : 500,
    evidence: {
      movedFrom: squareName(from),
      pinner: pin.pinner !== null ? squareName(pin.pinner) : null,
      behind: squareName(pin.behind),
      capture: first.uci,
    },
  };
}

function forkAllowed(ctx: Ctx): MotifDetection | null {
  const first = ctx.refutationSteps[0];
  if (!first) return null;
  const { to: forkSquare } = uciSquares(first.uci);
  const afterFirst = posFromFen(ctx.refutationFens[1] ?? "");
  const forker = afterFirst.board.get(forkSquare);
  if (!forker || forker.color === ctx.mover) return null;
  const reach = attacks(forker, forkSquare, afterFirst.board.occupied);
  const targets: { square: Square; value: number; role: string }[] = [];
  for (const target of reach.intersect(afterFirst.board[ctx.mover])) {
    const piece = afterFirst.board.get(target);
    if (!piece) continue;
    const isKing = piece.role === "king";
    if (!isKing && SEE_VALUES[piece.role] < SEE_VALUES.knight) continue;
    if (!isKing) {
      const captureUci = `${squareName(forkSquare)}${squareName(target)}`;
      if (see(afterFirst, captureUci) < 0) continue;
    }
    targets.push({ square: target, value: isKing ? 10_000 : SEE_VALUES[piece.role], role: piece.role });
  }
  const hasKing = targets.some((t) => t.role === "king");
  if (targets.length < 2) return null;
  if (!hasKing && targets.length < 2) return null;
  const stake = targets
    .filter((t) => t.role !== "king")
    .reduce((max, t) => Math.max(max, t.value), 0);
  return {
    motif: "FORK_ALLOWED",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: stake,
    evidence: {
      forkSquare: squareName(forkSquare),
      forker: forker.role,
      targets: targets.map((t) => ({ square: squareName(t.square), role: t.role })),
      move: first.uci,
    },
  };
}

function skewerAllowed(ctx: Ctx): MotifDetection | null {
  const first = ctx.refutationSteps[0];
  if (!first) return null;
  const { to: from } = uciSquares(first.uci);
  const afterFirst = posFromFen(ctx.refutationFens[1] ?? "");
  const piece = afterFirst.board.get(from);
  if (!piece || piece.color === ctx.mover) return null;
  if (piece.role !== "bishop" && piece.role !== "rook" && piece.role !== "queen") return null;
  const sight = attacks(piece, from, afterFirst.board.occupied);
  for (const p1 of sight.intersect(afterFirst.board[ctx.mover])) {
    const front = afterFirst.board.get(p1);
    if (!front) continue;
    // Piece directly behind P1 on the same ray.
    const lineRay = ray(from, p1);
    if (lineRay.isEmpty()) continue;
    const behindSight = attacks(piece, from, afterFirst.board.occupied.without(p1));
    for (const p2 of behindSight.intersect(lineRay).intersect(afterFirst.board[ctx.mover])) {
      if (p2 === p1 || !between(from, p2).has(p1)) continue;
      const back = afterFirst.board.get(p2);
      if (!back) continue;
      const frontValue = front.role === "king" ? 10_000 : SEE_VALUES[front.role];
      const backValue = SEE_VALUES[back.role];
      if (frontValue <= backValue) continue;
      // P1 forced: it is the king, or the attack wins material if it stays.
      const forced =
        front.role === "king" || see(afterFirst, `${squareName(from)}${squareName(p1)}`) > 0;
      if (!forced) continue;
      return {
        motif: "SKEWER_ALLOWED",
        confidence: 0.85,
        evidenceClass: 3,
        stakeCp: backValue,
        evidence: {
          attacker: squareName(from),
          front: { square: squareName(p1), role: front.role },
          back: { square: squareName(p2), role: back.role },
          move: first.uci,
        },
      };
    }
  }
  return null;
}

function discoveredAttackMissed(ctx: Ctx): MotifDetection | null {
  const first = ctx.refutationSteps[0];
  if (!first) return null;
  const discovered = discoveredBy(ctx.after, first.uci);
  if (!discovered) return null;
  const targetPiece = ctx.after.board.get(discovered.target);
  if (!targetPiece || targetPiece.color !== ctx.mover) return null;
  const targetValue =
    targetPiece.role === "king" ? 10_000 : SEE_VALUES[targetPiece.role];
  // Worth more than anything the moving piece threatens directly.
  const { to } = uciSquares(first.uci);
  const movingPiece = ctx.after.board.get(uciSquares(first.uci).from);
  let directBest = first.capturedValue;
  if (movingPiece) {
    const directReach = attacks(movingPiece, to, ctx.after.board.occupied.without(uciSquares(first.uci).from).with(to));
    for (const threatened of directReach.intersect(ctx.after.board[ctx.mover])) {
      const piece = ctx.after.board.get(threatened);
      if (piece && piece.role !== "king") {
        directBest = Math.max(directBest, SEE_VALUES[piece.role]);
      }
    }
  }
  if (targetValue <= directBest) return null;
  return {
    motif: "DISCOVERED_ATTACK_MISSED",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: targetValue,
    evidence: {
      revealer: first.uci,
      attacker: squareName(discovered.attacker),
      target: { square: squareName(discovered.target), role: targetPiece.role },
    },
  };
}

function trappedPiece(ctx: Ctx): MotifDetection | null {
  // A mover piece with no safe squares in posAfter that the refutation wins
  // within four plies.
  const capturesWithin = ctx.refutationSteps
    .slice(0, 4)
    .filter((step) => step.mover !== ctx.mover && step.capturedSquare !== null && step.capturedValue >= SEE_VALUES.knight);
  for (const step of capturesWithin) {
    const square = step.capturedSquare as Square;
    const piece = ctx.after.board.get(square);
    if (!piece || piece.color !== ctx.mover || piece.role === "pawn" || piece.role === "king") continue;
    if (safeSquares(ctx.after, square).nonEmpty()) continue;
    return {
      motif: "TRAPPED_PIECE",
      confidence: 0.85,
      evidenceClass: 3,
      stakeCp: SEE_VALUES[piece.role],
      evidence: {
        square: squareName(square),
        piece: piece.role,
        wonBy: step.uci,
        withinPlies: ctx.refutationSteps.indexOf(step) + 1,
      },
    };
  }
  return null;
}

function kingSafetyCollapse(ctx: Ctx): MotifDetection | null {
  const beforeAttackers = kingZoneAttackers(ctx.before, ctx.mover);
  const afterAttackers = kingZoneAttackers(ctx.after, ctx.mover);
  if (afterAttackers - beforeAttackers < 2) return null;
  // Refutation targets the king zone within the first four plies.
  const zone = kingZone(ctx.after, ctx.mover);
  const targets = ctx.refutationSteps.slice(0, 4).some((step) => {
    if (step.mover === ctx.mover) return false;
    try {
      return zone.has(uciSquares(step.uci).to);
    } catch {
      return false;
    }
  });
  if (!targets && !ctx.finalIsMate) return null;
  return {
    motif: "KING_SAFETY_COLLAPSE",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: ctx.finalIsMate ? 10_000 : 400,
    evidence: {
      kingZoneAttackersBefore: beforeAttackers,
      kingZoneAttackersAfter: afterAttackers,
      refutationTargetsZone: targets,
      mates: ctx.finalIsMate,
    },
  };
}

function pawnStructureCollapse(ctx: Ctx): MotifDetection | null {
  // Structural: the move (or forced sequence) leaves the mover with ≥2 new
  // pawn-structure defects (doubled/isolated pawns) with no material change.
  const defectsBefore = pawnDefects(ctx.before, ctx.mover);
  const endFen = ctx.refutationFens[Math.min(2, ctx.refutationFens.length - 1)]!;
  const end = posFromFen(endFen);
  const defectsAfter = pawnDefects(end, ctx.mover);
  const materialSwing = ctx.refutationSteps
    .slice(0, 2)
    .reduce((sum, step) => sum + (step.mover === ctx.mover ? step.capturedValue : -step.capturedValue), 0);
  if (defectsAfter - defectsBefore < 2 || Math.abs(materialSwing) > 100) return null;
  return {
    motif: "PAWN_STRUCTURE_COLLAPSE",
    confidence: 0.85,
    evidenceClass: 3,
    stakeCp: 150,
    evidence: { defectsBefore, defectsAfter },
  };
}

function pawnDefects(pos: Pos, color: Color): number {
  const pawns = pos.board.pawn.intersect(pos.board[color]);
  const files = new Array(8).fill(0) as number[];
  for (const pawn of pawns) files[pawn % 8]!++;
  let defects = 0;
  for (let file = 0; file < 8; file++) {
    const count = files[file]!;
    if (count >= 2) defects += count - 1; // doubled
    if (count > 0) {
      const left = file > 0 ? files[file - 1]! : 0;
      const right = file < 7 ? files[file + 1]! : 0;
      if (left === 0 && right === 0) defects += 1; // isolated
    }
  }
  return defects;
}

// --- Heuristic (0.6) ---

function zwischenzugMissed(ctx: Ctx): MotifDetection | null {
  const { input } = ctx;
  if (!input.playedIsRecapture) return null;
  const best = input.bestPv[0];
  if (!best || best === input.movedUci) return null;
  let bestForcing = false;
  try {
    bestForcing = isForcing(ctx.before, best);
  } catch {
    return null;
  }
  if (!bestForcing) return null;
  // The best line delays the recapture ≥2 plies (or skips it entirely).
  const recaptureSquare = input.movedUci.slice(2, 4);
  const recaptureIndex = input.bestPv.findIndex(
    (uci, index) => index % 2 === 0 && uci.slice(2, 4) === recaptureSquare
  );
  if (recaptureIndex !== -1 && recaptureIndex < 2) return null;
  return {
    motif: "ZWISCHENZUG_MISSED",
    confidence: 0.6,
    evidenceClass: 1,
    stakeCp: 200,
    evidence: {
      played: input.movedUci,
      zwischenzug: best,
      recaptureDelayedToPly: recaptureIndex === -1 ? null : recaptureIndex + 1,
    },
  };
}

function prematureAttack(ctx: Ctx): MotifDetection | null {
  const opponent = opposite(ctx.mover);
  const pressureBefore = kingZoneAttackers(ctx.before, opponent);
  const pressureAfter = kingZoneAttackers(ctx.after, opponent);
  if (pressureAfter <= pressureBefore) return null;
  // Undeveloped: ≥2 own minors on the back rank, or own king uncastled with rights.
  const backRankIndex = ctx.mover === "white" ? 0 : 7;
  const minors = ctx.before.board.knight.union(ctx.before.board.bishop).intersect(ctx.before.board[ctx.mover]);
  let undeveloped = 0;
  for (const minor of minors) if (Math.floor(minor / 8) === backRankIndex) undeveloped++;
  const castlingField = ctx.input.fenBefore.split(" ")[2] ?? "-";
  const hasRights =
    ctx.mover === "white" ? /[A-Z]/.test(castlingField) : /[a-z]/.test(castlingField);
  const king = ctx.before.board.kingOf(ctx.mover);
  const kingHome = king !== undefined && Math.floor(king / 8) === backRankIndex;
  if (undeveloped < 2 && !(hasRights && kingHome)) return null;
  return {
    motif: "PREMATURE_ATTACK",
    confidence: 0.6,
    evidenceClass: 1,
    stakeCp: 150,
    evidence: {
      pressureBefore,
      pressureAfter,
      undevelopedMinors: undeveloped,
      uncastledWithRights: hasRights && kingHome,
    },
  };
}

function passivity(ctx: Ctx): MotifDetection | null {
  const { input } = ctx;
  const recent = input.recentOwnSans.slice(-3);
  if (recent.length < 3) return null;
  const nonForcing = recent.every(
    (san) => !san.includes("x") && !san.includes("+") && !san.includes("=")
  );
  if (!nonForcing) return null;
  // No compensation: no capture made by the move.
  if (input.movedSan.includes("x")) return null;
  // Prefer the run-level trend (the spec's actual condition); fall back to
  // the single-move delta when the adapter could not supply it.
  const start = input.runMobility?.start ?? mobility(ctx.before, ctx.mover);
  const end = input.runMobility?.end ?? mobility(ctx.after, ctx.mover);
  if (end >= start) return null;
  return {
    motif: "PASSIVITY",
    confidence: 0.6,
    evidenceClass: 1,
    stakeCp: 100,
    evidence: { mobilityStart: start, mobilityEnd: end, quietRun: recent },
  };
}

// --- Data-computed (1.0, ranked as class 2) ---

function tunnelVision(ctx: Ctx): MotifDetection | null {
  if (!ctx.input.priorForcingRun) return null;
  return {
    motif: "TUNNEL_VISION_POST_FORCING",
    confidence: 1.0,
    evidenceClass: 2,
    stakeCp: 0,
    evidence: { priorForcingPlies: 3 },
  };
}

/** C2.3/C2.4: runs every detector, ranks, returns all fired ≥ 0.6. */
export function detectMotifs(input: MotifDetectionInput): MotifDetection[] {
  const ctx = buildCtx(input);
  if (!ctx) {
    return [
      {
        motif: "UNCLEAR",
        confidence: 0.5,
        evidenceClass: 0,
        stakeCp: 0,
        evidence: { reason: "position unparseable" },
      },
    ];
  }

  const fired: MotifDetection[] = [];
  const push = (detection: MotifDetection | null) => {
    if (detection && detection.confidence >= 0.6) fired.push(detection);
  };

  for (const detection of tbDetectors(ctx)) push(detection);
  push(backRank(ctx));
  push(hangingPiece(ctx));
  push(materialism(ctx));
  push(overloadedDefender(ctx));
  push(removingTheDefender(ctx));
  push(pinnedPieceMoved(ctx));
  push(forkAllowed(ctx));
  push(skewerAllowed(ctx));
  push(discoveredAttackMissed(ctx));
  push(trappedPiece(ctx));
  push(kingSafetyCollapse(ctx));
  push(pawnStructureCollapse(ctx));
  push(zwischenzugMissed(ctx));
  push(prematureAttack(ctx));
  push(passivity(ctx));
  push(tunnelVision(ctx));

  // TIME_PRESSURE (C2.3 data-computed): clock under 15s and nothing
  // substantive fired at ≥ 0.7.
  const substantive = fired.some((d) => d.confidence >= 0.7 && d.motif !== "TUNNEL_VISION_POST_FORCING");
  if (
    input.clockMsRemaining !== null &&
    input.clockMsRemaining < 15_000 &&
    !substantive
  ) {
    fired.push({
      motif: "TIME_PRESSURE",
      confidence: 1.0,
      evidenceClass: 2,
      stakeCp: 0,
      evidence: { clockMsRemaining: input.clockMsRemaining },
    });
  }

  if (fired.length === 0) {
    return [
      {
        motif: "UNCLEAR",
        confidence: 0.5,
        evidenceClass: 0,
        stakeCp: 0,
        evidence: { fenBefore: input.fenBefore, moved: input.movedUci },
      },
    ];
  }

  // C2.4: rank by evidence class, then confidence, then material at stake.
  fired.sort(
    (a, b) =>
      b.evidenceClass - a.evidenceClass ||
      b.confidence - a.confidence ||
      b.stakeCp - a.stakeCp
  );
  return fired;
}
