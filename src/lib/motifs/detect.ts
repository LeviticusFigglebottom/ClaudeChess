import { opposite } from "chessops/util";
import type { Color, Square } from "chessops";
import { GamePosition } from "@/lib/chess/position";
import { isVariantId, type VariantId } from "@/lib/chess/variant";
import { blunderMotifEnum } from "@/db/schema";
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
  sq,
  squareName,
  uciSquares,
  SEE_VALUES,
  type Pos,
} from "./primitives";
import { attacks, ray, between } from "chessops/attacks";
import { structuralDetectors } from "./structural";

/**
 * C2.3 deterministic motif detectors. A motif is a property of the
 * REFUTATION — the engine's punishing line after the mistake — combined with
 * board geometry. Every detector is a pure predicate over the stored
 * analysis record: no I/O, no engine, sub-millisecond. Evidence carries the
 * squares and PV indices that fired, which C3 renders and the C5
 * explanation call consumes as proven input.
 *
 * Confidence encodes evidence class (C2.4): tablebase 1.0 > mate 0.95 >
 * SEE 0.9 > geometric 0.85 > STRUCTURAL 0.75 (the positional class — a
 * tactical mechanism, where one exists, is always the better explanation)
 * > data-computed 1.0 (ranked below despite the number — the class ranks,
 * not the confidence) > heuristic 0.6.
 */

/** One source of truth: the DB enum. Detect can only emit storable motifs. */
export type MotifName = (typeof blunderMotifEnum.enumValues)[number];

/**
 * C2.4 precedence, higher wins. "forgone" (Task 3) ranks below structural:
 * a tactic that was actually punished outranks one that was merely
 * available in bestPv.
 */
export const EVIDENCE_CLASS = {
  tb: 8,
  mate: 7,
  see: 6,
  geometric: 5,
  structural: 4,
  forgone: 3,
  data: 2,
  heuristic: 1,
} as const;

export type Evidence = Record<string, unknown>;

export interface MotifDetection {
  motif: MotifName;
  confidence: number;
  /** C2.4 evidence class (EVIDENCE_CLASS), for ranking. */
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
  /** §4.2 classification of this ply (gates the forgone pass: MISS always). */
  classification?: string | null;
  /**
   * Best-play eval of the pre-move position, MOVER's POV in cp (mate for
   * the mover → 10000). Gates the forgone pass for MISTAKE/BLUNDER: a
   * bestPv winning ≥ 300cp is simultaneously an error and a forgone win.
   */
  bestEvalCp?: number | null;
  /**
   * Mobility across the quiet run (C2.3 PASSIVITY: "dropped over a run of
   * three or more non-forcing moves"): mover's mobility at the run's start
   * vs after this move. Computed by the adapter from stored positions.
   */
  runMobility?: { start: number; end: number };
}

export interface Ctx {
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
      evidenceClass: EVIDENCE_CLASS.tb,
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
      evidenceClass: EVIDENCE_CLASS.tb,
      stakeCp: 800,
      evidence: { ...evidence, refutationPromotes: true },
    });
  }

  detections.push({
    motif: "ENDGAME_TECHNIQUE",
    confidence: 1.0,
    evidenceClass: EVIDENCE_CLASS.tb,
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
    evidenceClass: EVIDENCE_CLASS.mate,
    stakeCp: 10_000,
    evidence: {
      matingSquare: squareName(matingSquare),
      king: squareName(king),
      pawnShield: escapes.map(squareName),
      mateInPlies: ctx.refutationSteps.length,
    },
  };
}

// The former missedBackRankMate special case is superseded by the forgone
// pass: the SUFFERED backRank predicate runs unchanged on the mirrored
// bestPv context and emits MISSED_BACK_RANK.

/**
 * The move walks into a FORCED mate whose line lands on the mover's king
 * zone — mate-class evidence for KING_SAFETY_COLLAPSE even when the
 * attacker COUNT didn't rise (the attackers were already parked there).
 * C2.3's "mate alone is not a motif" is respected: a mate that never
 * touches the zone falls through to whatever else fires.
 */
function mateAllowed(ctx: Ctx): MotifDetection | null {
  if (!ctx.finalIsMate) return null;
  if ((ctx.finalPos.turn === "w" ? "white" : "black") !== ctx.mover) return null;
  if (ctx.refutationSteps.length === 0) return null;
  const zone = kingZone(ctx.after, ctx.mover);
  const zoneHits = ctx.refutationSteps.filter((step) => {
    if (step.mover === ctx.mover) return false;
    try {
      return zone.has(uciSquares(step.uci).to);
    } catch {
      return false;
    }
  }).length;
  if (zoneHits === 0) return null;
  return {
    motif: "KING_SAFETY_COLLAPSE",
    confidence: 0.85,
    evidenceClass: EVIDENCE_CLASS.mate,
    stakeCp: 10_000,
    evidence: {
      forcedMate: true,
      mateInPlies: ctx.refutationSteps.length,
      zoneHits,
    },
  };
}

/** Value of whatever the PLAYED move captured (0 for a quiet move). */
function capturedValueOfMove(ctx: Ctx): number {
  try {
    const { to } = uciSquares(ctx.input.movedUci);
    const victim = ctx.before.board.get(to);
    if (victim && victim.color !== ctx.mover) {
      return SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
    }
    // En passant.
    if (ctx.input.movedSan.includes("x")) return SEE_VALUES.pawn;
  } catch {
    return 0;
  }
  return 0;
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
  // A RECAPTURE completing an even trade WE initiated is not a hang: when
  // their capture lands on our move's own destination square, net out what
  // we just took (minor-vs-minor tolerance 60cp). Captures elsewhere are
  // mutual grabs — the piece was genuinely en prise.
  try {
    const ourTo = uciSquares(ctx.input.movedUci).to;
    if (square === ourTo) {
      const movedCapture = capturedValueOfMove(ctx);
      if (captureSee <= movedCapture + 60) return null;
    }
  } catch {
    /* unparseable move — keep the raw SEE verdict */
  }

  const undefended = defendersOf(ctx.after.board, square, ctx.mover).isEmpty();
  return {
    motif: "HANGING_PIECE",
    confidence: undefended ? 0.9 : 0.75,
    evidenceClass: EVIDENCE_CLASS.see,
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
    evidenceClass: EVIDENCE_CLASS.see,
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
    evidenceClass: EVIDENCE_CLASS.geometric,
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
        evidenceClass: EVIDENCE_CLASS.geometric,
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
    evidenceClass: EVIDENCE_CLASS.geometric,
    stakeCp: behindPiece ? SEE_VALUES[behindPiece.role] : 500,
    evidence: {
      movedFrom: squareName(from),
      pinner: pin.pinner !== null ? squareName(pin.pinner) : null,
      behind: squareName(pin.behind),
      capture: first.uci,
    },
  };
}

/**
 * Fork geometry at refutation step `stepIndex`: the enemy piece landing
 * there attacks ≥2 of the mover's high-value targets (king counts; non-king
 * captures must not lose on SEE), evaluated on the position after that step.
 */
function forkGeometryAt(
  ctx: Ctx,
  stepIndex: number
): Omit<MotifDetection, "confidence"> | null {
  const step = ctx.refutationSteps[stepIndex];
  if (!step) return null;
  const { to: forkSquare } = uciSquares(step.uci);
  const afterStep = posFromFen(ctx.refutationFens[stepIndex + 1] ?? "");
  const forker = afterStep.board.get(forkSquare);
  if (!forker || forker.color === ctx.mover) return null;
  const reach = attacks(forker, forkSquare, afterStep.board.occupied);
  const targets: { square: Square; value: number; role: string }[] = [];
  for (const target of reach.intersect(afterStep.board[ctx.mover])) {
    const piece = afterStep.board.get(target);
    if (!piece) continue;
    const isKing = piece.role === "king";
    if (!isKing && SEE_VALUES[piece.role] < SEE_VALUES.knight) continue;
    if (!isKing) {
      const captureUci = `${squareName(forkSquare)}${squareName(target)}`;
      if (see(afterStep, captureUci) < 0) continue;
    }
    targets.push({ square: target, value: isKing ? 10_000 : SEE_VALUES[piece.role], role: piece.role });
  }
  if (targets.length < 2) return null;
  const stake = targets
    .filter((t) => t.role !== "king")
    .reduce((max, t) => Math.max(max, t.value), 0);
  return {
    motif: "FORK_ALLOWED",
    evidenceClass: EVIDENCE_CLASS.geometric,
    stakeCp: stake,
    evidence: {
      forkSquare: squareName(forkSquare),
      forker: forker.role,
      targets: targets.map((t) => ({ square: squareName(t.square), role: t.role })),
      move: step.uci,
    },
  };
}

function forkAllowed(ctx: Ctx): MotifDetection | null {
  const direct = forkGeometryAt(ctx, 0);
  if (direct) return { ...direct, confidence: 0.85 };
  // Post-exchange fork: the refutation's first pair is a null-net exchange —
  // their capture on square S, our recapture on the same S regaining at
  // least what was taken — and THEIR NEXT MOVE is the fork. The exchange is
  // a forced prefix, not the punishment; the fork is what the refutation
  // demonstrates. The same-square null-net gate is what keeps this from
  // attributing arbitrary deep tactics to the move.
  const s0 = ctx.refutationSteps[0];
  const s1 = ctx.refutationSteps[1];
  if (!s0 || !s1 || s0.capturedValue <= 0) return null;
  const exchangeSquare = uciSquares(s0.uci).to;
  if (uciSquares(s1.uci).to !== exchangeSquare || s1.capturedValue <= 0) return null;
  if (s1.capturedValue < s0.capturedValue - 60) return null;
  const post = forkGeometryAt(ctx, 2);
  if (!post) return null;
  return {
    ...post,
    confidence: 0.8,
    evidence: { ...post.evidence, viaExchangeOn: squareName(exchangeSquare) },
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
        evidenceClass: EVIDENCE_CLASS.geometric,
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
    evidenceClass: EVIDENCE_CLASS.geometric,
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
      evidenceClass: EVIDENCE_CLASS.geometric,
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

/**
 * HANGING_PIECE, delayed capture: the punished piece stood en prise in the
 * post-move position, but the refutation prepares first (an attack, a
 * zwischenzug) and only captures at ply 2–4. The first-ply case is
 * hangingPiece; this covers the "left it there and something else came
 * first" pattern the UNCLEAR sample was full of.
 */
function deepHangingPiece(ctx: Ctx): MotifDetection | null {
  // Same net-trade discipline as hangingPiece.
  let moverCounterplay = capturedValueOfMove(ctx);
  for (const [index, step] of ctx.refutationSteps.slice(0, 5).entries()) {
    if (index === 0) continue; // hangingPiece's territory
    if (step.mover === ctx.mover) {
      moverCounterplay += step.capturedValue;
      continue;
    }
    if (step.capturedSquare === null || step.capturedValue < SEE_VALUES.knight) continue;
    const square = step.capturedSquare;
    const piece = ctx.after.board.get(square);
    // Must be OUR piece, already sitting there when our move ended.
    if (!piece || piece.color !== ctx.mover || piece.role === "king") continue;
    if (attackersOf(ctx.after.board, square, opposite(ctx.mover)).isEmpty()) continue;
    // Not a trade the mover already recouped, and not a trapped piece
    // (no-safe-square pieces are TRAPPED_PIECE's diagnosis).
    if (moverCounterplay >= step.capturedValue - 100) continue;
    if (piece.role !== "pawn" && safeSquares(ctx.after, square).isEmpty()) continue;
    let captureSee = 0;
    try {
      captureSee = see(posFromFen(ctx.refutationFens[index]!), step.uci);
    } catch {
      captureSee = 0;
    }
    // Deliberately BELOW the specific mechanisms (fork/skewer/overload/
    // king-zone geometry, class ≥3 at 0.85): a delayed material loss is the
    // generic diagnosis, kept only when nothing sharper explains the ply.
    return {
      motif: "HANGING_PIECE",
      confidence: captureSee > 0 ? 0.65 : 0.62,
      evidenceClass: EVIDENCE_CLASS.geometric,
      stakeCp: step.capturedValue,
      evidence: {
        square: squareName(square),
        piece: piece.role,
        capturedAtPly: index + 1,
        capture: step.uci,
        see: captureSee,
        delayed: true,
      },
    };
  }
  return null;
}

/**
 * KING_SAFETY heuristic: a voluntary king move off its home square in the
 * opening (castling rights thrown away, not a forced reply to check) that
 * the engine punishes hard. The UNCLEAR sample's "Ke7 in the opening"
 * pattern.
 */
function openingKingWalk(ctx: Ctx): MotifDetection | null {
  const { input } = ctx;
  if (input.wpLoss < 10) return null;
  const fullmove = Number(input.fenBefore.split(" ")[5] ?? "99");
  if (fullmove > 12) return null;
  const { from } = uciSquares(input.movedUci);
  const home = ctx.mover === "white" ? sq("e1") : sq("e8");
  if (from !== home) return null;
  const piece = ctx.before.board.get(from);
  if (!piece || piece.role !== "king") return null;
  if (input.movedSan.startsWith("O-O")) return null;
  // Forced replies to check are survival, not a king walk.
  if (attackersOf(ctx.before.board, home, opposite(ctx.mover)).nonEmpty()) return null;
  return {
    motif: "KING_SAFETY_COLLAPSE",
    confidence: 0.6,
    evidenceClass: EVIDENCE_CLASS.heuristic,
    stakeCp: 200,
    evidence: {
      kingWalk: true,
      lostCastling: true,
      fullmove,
    },
  };
}

/**
 * KING_SAFETY heuristic, the other direction the UNCLEAR sample showed:
 * castling was available AND the engine's best move, the played move did
 * something else with the king still in the center, and it cost a
 * blunder-sized swing.
 */
function failedToCastle(ctx: Ctx): MotifDetection | null {
  const { input } = ctx;
  if (input.wpLoss < 15) return null;
  const best = input.bestPv[0];
  if (!best || best === input.movedUci) return null;
  let bestSan: string | null = null;
  try {
    const probe = GamePosition.fromFen(input.fenBefore, ctx.variant);
    const applied = probe.moveUci(best);
    bestSan = applied?.san ?? null;
  } catch {
    return null;
  }
  if (!bestSan || !bestSan.startsWith("O-O")) return null;
  if (input.movedSan.startsWith("O-O")) return null;
  return {
    motif: "KING_SAFETY_COLLAPSE",
    confidence: 0.6,
    evidenceClass: EVIDENCE_CLASS.heuristic,
    stakeCp: 300,
    evidence: {
      failedToCastle: true,
      bestWasCastling: bestSan,
    },
  };
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
    evidenceClass: EVIDENCE_CLASS.geometric,
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
    evidenceClass: EVIDENCE_CLASS.geometric,
    stakeCp: 150,
    evidence: { defectsBefore, defectsAfter },
  };
}

export function pawnDefects(pos: Pos, color: Color): number {
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
  // Already a bestPv-side predicate — under Task 3 it belongs to the
  // forgone family (the old ZWISCHENZUG_MISSED enum value stays in the DB
  // but is no longer emitted).
  return {
    motif: "MISSED_ZWISCHENZUG",
    confidence: 0.6,
    evidenceClass: EVIDENCE_CLASS.forgone,
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
    evidenceClass: EVIDENCE_CLASS.heuristic,
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
    evidenceClass: EVIDENCE_CLASS.heuristic,
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
    evidenceClass: EVIDENCE_CLASS.data,
    stakeCp: 0,
    evidence: { priorForcingPlies: 3 },
  };
}

/** C2.3/C2.4: runs every detector, ranks, returns all fired ≥ 0.6. */
/**
 * Forgone-side context (Task 3): classification MISS has no refutation —
 * the mechanism lives in bestPv, the line the player should have played.
 * Reuse buildCtx with fenAfter := fenBefore and refutation := bestPv, then
 * flip ctx.mover to the OPPONENT: every steps-based predicate now reads
 * "the enemy of ctx.mover creates a tactic against ctx.mover" as "the
 * actual mover's best line creates a tactic against the opponent" — same
 * predicates, other line, perspective flipped.
 */
function buildForgoneCtx(input: MotifDetectionInput): Ctx | null {
  if (input.bestPv.length === 0) return null;
  const mirror: MotifDetectionInput = {
    ...input,
    fenAfter: input.fenBefore,
    refutationPv: input.bestPv,
  };
  const ctx = buildCtx(mirror);
  if (!ctx) return null;
  return { ...ctx, mover: opposite(ctx.before.turn) };
}

/**
 * MISSED_PIN: bestPv[0] lands a line piece that ABSOLUTELY pins an enemy
 * piece to its king (it legally cannot leave the ray) and capturing the
 * pinned piece does not lose on SEE. The one forgone motif without a
 * refutation-side twin — pinnedPieceMoved is played-move-relative — built
 * from the same ray/SEE primitives.
 */
function missedPinAt(ctx: Ctx): Omit<MotifDetection, "motif" | "evidenceClass"> | null {
  const first = ctx.refutationSteps[0];
  if (!first) return null;
  const { to: from } = uciSquares(first.uci);
  const afterFirst = posFromFen(ctx.refutationFens[1] ?? "");
  const piece = afterFirst.board.get(from);
  if (!piece || piece.color === ctx.mover) return null;
  if (piece.role !== "bishop" && piece.role !== "rook" && piece.role !== "queen") return null;
  const king = afterFirst.board.kingOf(ctx.mover);
  if (king === undefined) return null;
  const sight = attacks(piece, from, afterFirst.board.occupied);
  for (const p1 of sight.intersect(afterFirst.board[ctx.mover])) {
    const front = afterFirst.board.get(p1);
    if (!front || front.role === "king" || front.role === "pawn") continue;
    // The king sits directly behind P1 on the pinner's ray → absolute pin.
    if (!ray(from, p1).has(king) || !between(from, king).has(p1)) continue;
    if (!attacks(piece, from, afterFirst.board.occupied.without(p1)).has(king)) continue;
    const captureUci = `${squareName(from)}${squareName(p1)}`;
    if (see(afterFirst, captureUci) < 0) continue;
    return {
      confidence: 0.85,
      stakeCp: SEE_VALUES[front.role],
      evidence: {
        pinner: squareName(from),
        pinned: { square: squareName(p1), role: front.role },
        king: squareName(king),
        move: first.uci,
      },
    };
  }
  return null;
}

/** [source detector, MISSED_ name] pairs run against the forgone context. */
const FORGONE_SOURCES: [
  (ctx: Ctx) => MotifDetection | null,
  MotifName,
][] = [
  [backRank, "MISSED_BACK_RANK"],
  [forkAllowed, "MISSED_FORK"],
  [skewerAllowed, "MISSED_SKEWER"],
  [discoveredAttackMissed, "MISSED_DISCOVERED_ATTACK"],
  [overloadedDefender, "MISSED_OVERLOAD"],
  [removingTheDefender, "MISSED_REMOVING_THE_DEFENDER"],
  [trappedPiece, "MISSED_TRAPPED_PIECE"],
];

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
  push(mateAllowed(ctx));
  push(hangingPiece(ctx));
  push(deepHangingPiece(ctx));
  push(materialism(ctx));
  push(overloadedDefender(ctx));
  push(removingTheDefender(ctx));
  push(pinnedPieceMoved(ctx));
  push(forkAllowed(ctx));
  push(skewerAllowed(ctx));
  push(discoveredAttackMissed(ctx));
  push(trappedPiece(ctx));
  push(kingSafetyCollapse(ctx));
  push(openingKingWalk(ctx));
  push(failedToCastle(ctx));
  push(pawnStructureCollapse(ctx));
  // Structural class (positional mechanisms) — registered after the
  // tactical detectors; class ranking keeps them below geometric.
  for (const detection of structuralDetectors(ctx)) push(detection);

  // Forgone class (Task 3): for classification MISS — which has no
  // refutation — and for any error whose bestPv wins ≥ 300cp or mates,
  // run the SAME geometric predicates against bestPv (mirrored context)
  // and emit MISSED_ variants. Both mechanisms are stored for a
  // MISTAKE/BLUNDER that is simultaneously an error and a forgone win.
  const forgoneGate =
    input.classification === "MISS" || (input.bestEvalCp ?? 0) >= 300;
  if (forgoneGate) {
    const forgoneCtx = buildForgoneCtx(input);
    if (forgoneCtx) {
      for (const [source, missedName] of FORGONE_SOURCES) {
        const detection = source(forgoneCtx);
        if (detection) {
          push({
            ...detection,
            motif: missedName,
            evidenceClass: EVIDENCE_CLASS.forgone,
            evidence: { ...detection.evidence, forgone: true, bestLineStart: input.bestPv[0] },
          });
        }
      }
      const pin = missedPinAt(forgoneCtx);
      if (pin) {
        push({
          ...pin,
          motif: "MISSED_PIN",
          evidenceClass: EVIDENCE_CLASS.forgone,
          evidence: { ...pin.evidence, forgone: true, bestLineStart: input.bestPv[0] },
        });
      }
    }
    // Played-move-relative by nature: runs on the ORIGINAL context but
    // belongs to the forgone family (bestPv holds the zwischenzug).
    push(zwischenzugMissed(ctx));
  }
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
      evidenceClass: EVIDENCE_CLASS.data,
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
  // One row per motif (blunder_tags is unique on (ply, motif)); multiple
  // detectors may diagnose the same motif — the best-evidenced one stands.
  const seen = new Set<MotifName>();
  return fired.filter((detection) => {
    if (seen.has(detection.motif)) return false;
    seen.add(detection.motif);
    return true;
  });
}
