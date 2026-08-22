import type { Classification } from "./classify";

/**
 * Deterministic move explanations (the chess.com-style "why"): pure
 * templates over the PROVEN record — classification, measured win-% loss,
 * stored engine lines, mate distances, and the motif detectors' evidence.
 * No model writes here (C0/C2/C5: the LLM may only prose over evidence via
 * its own metered route; these strings can be wrong about nothing).
 */

export interface ExplainMotif {
  motif: string;
  evidence: Record<string, unknown> | null;
}

export interface ExplainInput {
  san: string;
  classification: Classification | null;
  /** Mover-POV win-probability loss (0..100). */
  wpLoss: number | null;
  playedIsBest: boolean;
  bestSan: string | null;
  /** Signed White-POV mate distance AFTER the move (null = no forced mate). */
  mateAfterWhitePov: number | null;
  moverIsWhite: boolean;
  motifs: ExplainMotif[];
  provisional: boolean;
  degraded: boolean;
}

/** Human phrase per motif — the detector's meaning, nothing more. */
const MOTIF_PHRASES: Record<string, string> = {
  HANGING_PIECE: "it leaves a piece hanging",
  FORK_ALLOWED: "it walks into a fork",
  SKEWER_ALLOWED: "it allows a skewer",
  PIN_ALLOWED: "it allows a pin",
  DISCOVERED_ATTACK_MISSED: "it overlooks a discovered attack",
  BACK_RANK: "it exposes the back rank",
  OVERLOADED_DEFENDER: "it overloads a defender that was already stretched",
  REMOVING_THE_DEFENDER: "the opponent can simply remove the defender",
  TRAPPED_PIECE: "a piece ends up trapped",
  PINNED_PIECE_MOVED: "it moves a pinned piece",
  ZWISCHENZUG: "it misses an in-between move",
  TUNNEL_VISION_POST_FORCING: "played on autopilot right after the forcing sequence",
  MATERIALISM: "it grabs material and pays for it",
  PREMATURE_ATTACK: "the attack is premature — the position doesn't support it yet",
  KING_SAFETY_COLLAPSE: "it lets king safety collapse",
  PASSIVITY: "it drifts — the pieces end up doing less every move",
  TIME_PRESSURE: "played fast under clock pressure",
  HOLE_CREATED: "it creates a permanent hole",
  OUTPOST_CONCEDED: "it concedes a strong outpost",
  BISHOP_PAIR_SURRENDERED: "it gives up the bishop pair for too little",
  STRUCTURE_DAMAGED: "it damages the pawn structure",
  PAWN_STRUCTURE_COLLAPSE: "the pawn structure gives way",
  BAD_PIECE_PLACEMENT: "it puts a piece on the wrong square",
  FILE_OPENED_TOWARD_OWN_KING: "it opens a file toward the own king",
  SPACE_CONCEDED: "it concedes central space that can't be won back",
  GOOD_PIECE_TRADED: "it trades off the wrong piece",
  PAWN_BREAK_MISSED: "it misses the pawn break",
  KING_WALK: "the king walks into danger",
  MISSED_FORK: "a fork was available",
  MISSED_PIN: "a pin was available",
  MISSED_SKEWER: "a skewer was available",
  MISSED_DISCOVERED_ATTACK: "a discovered attack was available",
  MISSED_BACK_RANK: "a back-rank strike was available",
  MISSED_OVERLOAD: "an overloaded defender could have been exploited",
  MISSED_REMOVING_THE_DEFENDER: "removing the defender was winning",
  MISSED_TRAPPED_PIECE: "an enemy piece could have been trapped",
  MISSED_ZWISCHENZUG: "an in-between move was stronger",
  MATE_MISSED: "a forced mate was available",
  MATE_ALLOWED: "it allows a forced mate",
  UNCLEAR: "no single tactical mechanism names this — a quiet positional slide",
};

/** Interpolate the few evidence keys that read naturally when present. */
function evidenceSuffix(evidence: Record<string, unknown> | null): string {
  if (!evidence) return "";
  for (const key of ["square", "on", "target", "hole", "file"]) {
    const value = evidence[key];
    if (typeof value === "string" && /^[a-h][1-8]$|^[a-h]$/.test(value)) {
      return ` (${key === "file" ? `${value}-file` : value})`;
    }
  }
  return "";
}

export function motifPhrase(tag: ExplainMotif): string {
  const base = MOTIF_PHRASES[tag.motif] ?? tag.motif.toLowerCase().replaceAll("_", " ");
  return `${base}${evidenceSuffix(tag.evidence)}`;
}

function mateText(input: ExplainInput): string | null {
  const mate = input.mateAfterWhitePov;
  if (mate === null) return null;
  const winner = mate > 0 ? "White" : "Black";
  const moverLoses = input.moverIsWhite ? mate < 0 : mate > 0;
  return moverLoses
    ? `${winner} now has forced mate in ${Math.abs(mate)}`
    : `${winner} has forced mate in ${Math.abs(mate)}`;
}

export function explainPly(input: ExplainInput): { verdict: string; notes: string[] } {
  const loss = Math.max(0, Math.round(input.wpLoss ?? 0));
  const notes: string[] = [];
  const primary = input.motifs[0];
  const mate = mateText(input);

  let verdict: string;
  switch (input.classification) {
    case "BOOK":
      verdict = "Book theory — this line is well charted.";
      break;
    case "BEST":
      verdict = "The engine's first choice.";
      break;
    case "BRILLIANT":
      verdict = "A sound sacrifice — material is given up and the engine confirms it works.";
      break;
    case "GREAT":
      verdict = "The only move that holds — every alternative falls off sharply.";
      break;
    case "EXCELLENT":
      verdict = "Precise — concedes essentially nothing.";
      break;
    case "GOOD":
      verdict = "A solid move.";
      break;
    case "INACCURACY":
      verdict = `Slightly loose — ${loss} win-% slips away${primary ? `: ${motifPhrase(primary)}` : ""}.`;
      break;
    case "MISTAKE":
      verdict = `A real concession — ${loss} win-% given up${primary ? `: ${motifPhrase(primary)}` : ""}.`;
      break;
    case "BLUNDER":
      verdict = mate
        ? `A blunder — ${mate}.`
        : `A blunder — ${loss} win-% thrown away${primary ? `: ${motifPhrase(primary)}` : ""}.`;
      break;
    case "MISS":
      verdict = input.bestSan
        ? `A win goes begging — ${input.bestSan} was the chance${primary ? ` (${motifPhrase(primary)})` : ""}.`
        : "A winning chance goes by unplayed.";
      break;
    default:
      verdict = "Not analyzed yet.";
  }

  if (
    !input.playedIsBest &&
    input.bestSan &&
    input.classification !== "BOOK" &&
    input.classification !== "MISS" &&
    input.classification !== "BEST" &&
    input.classification !== "BRILLIANT" &&
    input.classification !== "GREAT"
  ) {
    notes.push(`Better was ${input.bestSan}.`);
  }
  for (const tag of input.motifs.slice(1, 3)) {
    notes.push(`Also in play: ${motifPhrase(tag)}.`);
  }
  if (mate && input.classification !== "BLUNDER") notes.push(`${mate}.`);
  if (input.provisional) notes.push("Provisional (quick pass) — being refined to full depth.");
  if (input.degraded) notes.push("Search incomplete for this position — verdict is best-effort.");

  return { verdict, notes };
}

/** White-POV eval label: "+0.83", "−1.20", "#5", "−#3". */
export function evalLabel(cp: number | null, mate: number | null): string | null {
  if (mate !== null) return mate > 0 ? `#${mate}` : `−#${Math.abs(mate)}`;
  if (cp === null) return null;
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(2)}`;
}
