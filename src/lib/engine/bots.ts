import calibration from "./bot-calibration.json";
import { BOT_RATINGS, formulaParams, type BotPolicyParams, type BotRating } from "./bot";
import { BOT_RD } from "@/lib/rating/glicko2";

/**
 * The nine Tier-A bots (spec §8 Phase 1). Names are the instrument's, not
 * personas — this product is a measuring device, and the bot IS its rating.
 * Fixed Glicko rating at the nominal band with RD 30 (spec §7) so they
 * inform the user's rating without drifting.
 */

export interface BotDefinition {
  rating: BotRating;
  name: string;
  params: BotPolicyParams;
  calibrated: boolean;
  measuredElo: number | null;
  rd: number;
}

interface CalibrationBand {
  pBlunder: number;
  temperature: number;
  measuredElo: number | null;
  ci95: number | null;
  games: number;
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
    rd: BOT_RD,
  };
}

export function allBots(): BotDefinition[] {
  return BOT_RATINGS.map((rating) => botForRating(rating));
}
