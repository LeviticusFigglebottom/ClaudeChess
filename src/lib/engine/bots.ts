import calibrationV2 from "./bot-calibration-v2.json";
import {
  BOT_RATINGS,
  REFERENCE_MOVETIME_MS,
  type BotPlan,
  type BotRating,
} from "./bot";
import { BOT_RD } from "@/lib/rating/glicko2";

/**
 * The nine Tier-A bots (spec §8 Phase 1) on POLICY v2 — organic weakening
 * (owner directive 2026-08-23; bot-calibration-v2.json documents the two
 * tiers and their anchoring). Names are the instrument's, not personas —
 * this product is a measuring device, and the bot IS its rating. Fixed
 * Glicko rating at the nominal band with RD 30 (spec §7) so they inform
 * the user's rating without drifting.
 */

export type BotAnchor = "direct" | "chained(1)" | "chained(2)" | "native" | "maia";

export interface BotDefinition {
  rating: BotRating;
  name: string;
  plan: BotPlan;
  calibrated: boolean;
  measuredElo: number | null;
  ci95: number | null;
  /**
   * How the band's rating is anchored: "native" = SF UCI_LimitStrength at a
   * ruler-clean label (the setting that DEFINED the scale — exact by
   * construction); "direct" = measured vs a ruler anchor within ±75 or with
   * its CI reported; "chained(n)" = n bot-links from the anchor. Surfaced
   * in the UI wherever the bot's rating is shown.
   */
  anchor: BotAnchor | null;
  rd: number;
}

interface V2Band {
  method: "organic" | "sf-limitstrength";
  depth?: number;
  multipv?: number;
  temperature?: number;
  uciElo?: number;
  /** 1200/1400: node cap under the limiter (hardware-independent; json note). */
  nodes?: number;
  measuredElo: number | null;
  ci95: number | null;
  games: number;
  anchor?: BotAnchor;
}

const bands = calibrationV2.bands as Record<string, V2Band>;

export function botPlanFor(rating: BotRating): BotPlan {
  const band = bands[String(rating)];
  if (band?.method === "sf-limitstrength" && band.uciElo !== undefined) {
    if (band.nodes !== undefined) {
      return { kind: "limitStrength", uciElo: band.uciElo, nodes: band.nodes };
    }
    return { kind: "limitStrength", uciElo: band.uciElo, movetimeMs: REFERENCE_MOVETIME_MS };
  }
  if (band?.method === "organic") {
    return {
      kind: "organic",
      depth: band.depth ?? 4,
      multipv: band.multipv ?? 4,
      temperature: band.temperature ?? 3,
    };
  }
  // No band entry — conservative organic default (flagged uncalibrated).
  return { kind: "organic", depth: 4, multipv: 4, temperature: 3 };
}

export function botForRating(rating: BotRating): BotDefinition {
  const band = bands[String(rating)];
  const calibrated = Boolean(band && band.measuredElo !== null);
  if (!calibrated && typeof console !== "undefined") {
    console.warn(`[gambit] bot ${rating} is running UNCALIBRATED params — gate not closed`);
  }
  return {
    rating,
    name: `GAMBIT ${rating}`,
    plan: botPlanFor(rating),
    calibrated,
    measuredElo: band?.measuredElo ?? null,
    ci95: band?.ci95 ?? null,
    anchor: calibrated ? (band?.anchor ?? "direct") : null,
    rd: BOT_RD,
  };
}

/** Short UI tag for the anchor quality ("direct ±48" / "native (engine)" / "uncalibrated"). */
export function anchorTag(bot: BotDefinition): string {
  if (!bot.calibrated || bot.anchor === null) return "uncalibrated";
  const ci = bot.ci95 !== null ? ` ±${bot.ci95}` : "";
  if (bot.anchor === "native") return "native (engine)";
  if (bot.anchor === "direct") return `direct${ci}`;
  if (bot.anchor === "maia") return `maia${ci}`;
  return `chained${ci}`;
}

export function allBots(): BotDefinition[] {
  return BOT_RATINGS.map((rating) => botForRating(rating));
}
