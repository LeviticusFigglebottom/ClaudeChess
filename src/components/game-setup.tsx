"use client";

import { useState } from "react";
import { chess960BackRank } from "@/lib/chess";
import type { ClockConfig } from "@/lib/clock/clock";
import { BOT_RATINGS, type BotRating } from "@/lib/engine/bot";
import { anchorTag, botForRating } from "@/lib/engine/bots";
import { timeControlBucket } from "@/lib/clock/clock";
import { getRatingState, type RatingKey } from "./ratings-store";
import type { GameSetup } from "./use-bot-game";

/**
 * Time controls offered vs bots. No 1+0: the bot's deep pass costs real
 * seconds on its own clock, so honest bullet vs the engine policy is not
 * playable until premoves + multiplayer land (Phase 4).
 */
const CLOCK_PRESETS: { label: string; config: ClockConfig }[] = [
  { label: "3+2", config: { mode: "fischer", initialMs: 180_000, incrementMs: 2_000 } },
  { label: "5+0", config: { mode: "fischer", initialMs: 300_000, incrementMs: 0 } },
  { label: "5 d5", config: { mode: "delay", initialMs: 300_000, incrementMs: 5_000 } },
  { label: "3 br2", config: { mode: "bronstein", initialMs: 180_000, incrementMs: 2_000 } },
  { label: "10+0", config: { mode: "fischer", initialMs: 600_000, incrementMs: 0 } },
  { label: "15+10", config: { mode: "fischer", initialMs: 900_000, incrementMs: 10_000 } },
  { label: "∞", config: { mode: "none", initialMs: 0, incrementMs: 0 } },
];

export function GameSetupCard({
  onStart,
  onFreeBoard,
}: {
  onStart(setup: GameSetup): void;
  onFreeBoard(): void;
}) {
  const [variant, setVariant] = useState<"standard" | "chess960">("standard");
  const [sp, setSp] = useState<number>(() => Math.floor(Math.random() * 960));
  const [botRating, setBotRating] = useState<BotRating>(1200);
  const [color, setColor] = useState<"w" | "b" | "random">("random");
  const [clockIndex, setClockIndex] = useState(0);
  const [rated, setRated] = useState(true);

  const clock = (CLOCK_PRESETS[clockIndex] ?? CLOCK_PRESETS[0]!).config;
  const ratedAllowed = clock.mode !== "none";
  const effectiveRated = rated && ratedAllowed;
  const ratingKey: RatingKey | null = ratedAllowed
    ? `${variant}:${timeControlBucket(clock)}`
    : null;
  const ratingState = ratingKey ? getRatingState(ratingKey) : null;

  const start = () => {
    onStart({
      variant,
      startPositionId: variant === "chess960" ? sp : undefined,
      botRating,
      playerColor: color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color,
      clock,
      rated: effectiveRated,
    });
  };

  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
      active
        ? "border-lcd bg-raise text-text"
        : "border-edge text-text-dim hover:border-edge-strong hover:text-text"
    }`;

  return (
    <div className="max-w-xl rounded-xl border border-edge p-5">
      <h2 className="mb-4 text-lg font-semibold text-paper">Play a bot</h2>

      <div className="mb-4">
        <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Variant</p>
        <div className="flex flex-wrap items-center gap-2">
          <button className={chip(variant === "standard")} onClick={() => setVariant("standard")}>
            Standard
          </button>
          <button className={chip(variant === "chess960")} onClick={() => setVariant("chess960")}>
            Chess960
          </button>
          {variant === "chess960" && (
            <span className="flex items-center gap-2 text-sm text-text-dim">
              <span className="notation">
                SP{sp} · {chess960BackRank(sp).toUpperCase()}
              </span>
              <button
                className="rounded border border-edge px-2 py-0.5 text-xs hover:border-edge-strong"
                onClick={() => setSp(Math.floor(Math.random() * 960))}
              >
                reroll
              </button>
              <input
                type="number"
                min={0}
                max={959}
                value={sp}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 0 && value <= 959) setSp(value);
                }}
                aria-label="Chess960 start position number"
                className="w-20 rounded border border-edge bg-transparent px-2 py-0.5 text-sm"
              />
            </span>
          )}
        </div>
      </div>

      <div className="mb-4">
        <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Opponent</p>
        <div className="flex flex-wrap gap-2">
          {BOT_RATINGS.map((rating) => (
            <button
              key={rating}
              className={`${chip(botRating === rating)} notation`}
              onClick={() => setBotRating(rating)}
              title={`calibration: ${anchorTag(botForRating(rating))}`}
            >
              {rating}
            </button>
          ))}
        </div>
        <p className="notation mt-1.5 text-xs text-text-faint">
          {botForRating(botRating).name} · calibration: {anchorTag(botForRating(botRating))}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-6">
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Your color</p>
          <div className="flex gap-2">
            <button className={chip(color === "w")} onClick={() => setColor("w")}>
              White
            </button>
            <button className={chip(color === "random")} onClick={() => setColor("random")}>
              Random
            </button>
            <button className={chip(color === "b")} onClick={() => setColor("b")}>
              Black
            </button>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Time control</p>
          <div className="flex flex-wrap gap-2">
            {CLOCK_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                className={`${chip(clockIndex === index)} notation`}
                onClick={() => setClockIndex(index)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-5 flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dim">
          <input
            type="checkbox"
            checked={effectiveRated}
            disabled={!ratedAllowed}
            onChange={(event) => setRated(event.target.checked)}
            className="accent-[var(--lcd)]"
          />
          Rated
        </label>
        {ratingState && (
          <span className="notation text-xs text-text-faint">
            your {variant} {ratingKey?.split(":")[1]}: {Math.round(ratingState.rating.rating)} ±
            {Math.round(ratingState.rating.rd)}
            {ratingState.pending.length > 0 && ` · ${ratingState.pending.length}/12 pending`}
          </span>
        )}
        {!ratedAllowed && <span className="text-xs text-text-faint">untimed games are casual</span>}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={start}
          className="rounded-lg bg-paper px-5 py-2 font-medium text-field hover:bg-white-adv"
        >
          Start game
        </button>
        <button onClick={onFreeBoard} className="text-sm text-text-dim hover:text-text">
          or open the free analysis board →
        </button>
      </div>
    </div>
  );
}
