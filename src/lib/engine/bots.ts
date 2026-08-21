import calibration from "./bot-calibration.json";
import { BOT_RATINGS, formulaParams, type BotPolicyParams, type BotRating } from "./bot";
import { BOT_RD } from "@/lib/rating/glicko2";

/**
 * The nine Tier-A bots (spec §8 Phase 1). Names are the instrument's, not
 * personas — this product is a measuring device, and the bot IS its rating.
 * Fixed Glicko rating at the nominal band with RD 30 (spec §7) so they
 * inform the user's rating without drifting.
 */

export type BotAnchor = "direct" | "chained(1)" | "chained(2)" | "maia";

export interface BotDefinition {
  rating: BotRating;
  name: string;
  params: BotPolicyParams;
  calibrated: boolean;
  measuredElo: number | null;
  ci95: number | null;
  /**
   * Gate amendment: how the band's rating was anchored. Direct bands met
   * ±75 vs a UCI_Elo reference; chained(n) bands are n bot-links from the
   * anchor and carry their reported CI instead of a ±75 claim. Surfaced in
   * the UI wherever the bot's rating is shown.
   */
  anchor: BotAnchor | null;
  rd: number;
}

interface CalibrationBand {
  pBlunder: number;
  temperature: number;
  measuredElo: number | null;
  ci95: number | null;
  games: number;
  anchor?: BotAnchor;
}

const bands = calibration.bands as Record<string, CalibrationBand>;

export function botForRating(rating: BotRating): BotDefinition {
  const band = bands[String(rating)];
  const params: BotPolicyParams = band
    ? { pBlunder: band.pBlunder, temperature: band.temperature }
    : formulaParams(rating);
  const calibrated = Boolean(band && band.measuredElo !== null);
  if (!calibrated && typeof console !== "undefined") {
    console.warn(`[gambit] bot ${rating} is running UNCALIBRATED params — gate not closed`);
  }
  return {
    rating,
    name: `GAMBIT ${rating}`,
    params,
    calibrated,
    measuredElo: band?.measuredElo ?? null,
    ci95: band?.ci95 ?? null,
    anchor: calibrated ? (band?.anchor ?? "direct") : null,
    rd: BOT_RD,
  };
}

/** Short UI tag for the anchor quality ("±48" / "chained ±95" / "uncalibrated"). */
export function anchorTag(bot: BotDefinition): string {
  if (!bot.calibrated || bot.anchor === null) return "uncalibrated";
  const ci = bot.ci95 !== null ? ` ±${bot.ci95}` : "";
  if (bot.anchor === "direct") return `direct${ci}`;
  if (bot.anchor === "maia") return `maia${ci}`;
  return `chained${ci}`;
}

export function allBots(): BotDefinition[] {
  return BOT_RATINGS.map((rating) => botForRating(rating));
}
