import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Data model (spec §5). The load-bearing table is `plies`: one canonical
 * per-ply analysis record that calibration, fingerprinting, and time analysis
 * all read from. Evals are stored as White-POV centipawns (normalized once at
 * the /lib/eval boundary); win probabilities are MOVER-POV (that is what
 * classification consumes).
 */

export const gameSourceEnum = pgEnum("game_source", ["local", "online", "chesscom", "lichess"]);

export const colorEnum = pgEnum("color", ["white", "black"]);

export const timeControlBucketEnum = pgEnum("time_control_bucket", [
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "daily",
]);

export const classificationEnum = pgEnum("classification", [
  "BOOK",
  "BRILLIANT",
  "GREAT",
  "BEST",
  "EXCELLENT",
  "GOOD",
  "INACCURACY",
  "MISTAKE",
  "BLUNDER",
  "MISS",
]);

/** Fixed blunder-motif taxonomy (spec §9.2) — closed set, no free text. */
export const blunderMotifEnum = pgEnum("blunder_motif", [
  "HANGING_PIECE",
  "OVERLOADED_DEFENDER",
  "PINNED_PIECE_MOVED",
  "BACK_RANK",
  "FORK_ALLOWED",
  "SKEWER_ALLOWED",
  "DISCOVERED_ATTACK_MISSED",
  "TRAPPED_PIECE",
  "REMOVING_THE_DEFENDER",
  "ZWISCHENZUG_MISSED",
  "KING_SAFETY_COLLAPSE",
  "PAWN_STRUCTURE_COLLAPSE",
  "MATERIALISM",
  "PREMATURE_ATTACK",
  "PASSIVITY",
  "ENDGAME_TECHNIQUE",
  "PAWN_RACE_MISCOUNT",
  "OPPOSITION_LOST",
  "TIME_PRESSURE",
  "TUNNEL_VISION_POST_FORCING",
  "UNCLEAR",
]);

export const repertoireStatusEnum = pgEnum("repertoire_status", ["known", "learning", "unseen"]);

export const postmortemVerdictEnum = pgEnum("postmortem_verdict", [
  "CORRECT",
  "RIGHT_MOVE_WRONG_REASON",
  "MISREAD_THREAT",
  "MISSED_OPPORTUNITY",
  "SOUND_BUT_INCOMPLETE",
]);

export const users = pgTable("users", {
  /** Mirrors the Supabase auth.users id. */
  id: uuid("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ratings = pgTable(
  "ratings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    timeControl: timeControlBucketEnum("time_control").notNull(),
    rating: doublePrecision("rating").notNull(),
    rd: doublePrecision("rd").notNull(),
    volatility: doublePrecision("volatility").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ratings_user_tc_idx").on(table.userId, table.timeControl)]
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: gameSourceEnum("source").notNull(),
    /** Game id on the source platform (chess.com uuid / lichess id). */
    externalId: text("external_id"),
    pgn: text("pgn").notNull(),
    whiteName: text("white_name").notNull(),
    blackName: text("black_name").notNull(),
    userColor: colorEnum("user_color").notNull(),
    /** "1-0" | "0-1" | "1/2-1/2" | "*" */
    result: text("result").notNull(),
    /** e.g. "checkmate", "resignation", "timeout", "agreement" */
    termination: text("termination"),
    /** Raw time control string, e.g. "300+3", "1/86400". */
    timeControl: text("time_control"),
    eco: text("eco"),
    opening: text("opening"),
    playedAt: timestamp("played_at", { withTimezone: true }),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("games_user_idx").on(table.userId, table.playedAt),
    uniqueIndex("games_source_external_idx").on(table.userId, table.source, table.externalId),
  ]
);

export const plies = pgTable(
  "plies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    /** 1-based half-move index within the game. */
    ply: integer("ply").notNull(),
    moveNumber: integer("move_number").notNull(),
    color: colorEnum("color").notNull(),

    san: text("san").notNull(),
    uci: text("uci").notNull(),
    fenBefore: text("fen_before").notNull(),
    fenAfter: text("fen_after").notNull(),

    /** White-POV centipawns; null when the eval is a mate score. */
    evalBeforeCp: integer("eval_before_cp"),
    evalAfterCp: integer("eval_after_cp"),
    /** Signed White-POV mate distance; null when not a mate. */
    mateBefore: integer("mate_before"),
    mateAfter: integer("mate_after"),

    bestMoveUci: text("best_move_uci"),
    /** Top engine lines as JSON arrays of UCI moves. */
    pv1: jsonb("pv1").$type<string[]>(),
    pv2: jsonb("pv2").$type<string[]>(),
    pv3: jsonb("pv3").$type<string[]>(),

    /** Mover-POV win probabilities (0..100) and loss. */
    wpBefore: real("wp_before"),
    wpAfter: real("wp_after"),
    wpLoss: real("wp_loss"),

    classification: classificationEnum("classification"),

    /** Nulls when the PGN lacks %clk. */
    clockMsRemaining: integer("clock_ms_remaining"),
    timeSpentMs: integer("time_spent_ms"),

    /** Spec §9.3 — computed at analysis time. */
    isCritical: boolean("is_critical").notNull().default(false),

    analyzedAtDepth: integer("analyzed_at_depth"),
  },
  (table) => [
    uniqueIndex("plies_game_ply_idx").on(table.gameId, table.ply),
    index("plies_game_errors_idx")
      .on(table.gameId)
      .where(sql`${table.classification} in ('MISTAKE', 'BLUNDER')`),
  ]
);

export const blunderTags = pgTable(
  "blunder_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plyId: bigint("ply_id", { mode: "number" })
      .notNull()
      .references(() => plies.id, { onDelete: "cascade" }),
    motif: blunderMotifEnum("motif").notNull(),
    secondaryMotif: blunderMotifEnum("secondary_motif"),
    confidence: real("confidence").notNull(),
    explanation: text("explanation").notNull(),
    /** Model identifier that produced the tag, for auditing agreement rates. */
    model: text("model").notNull(),
    taggedAt: timestamp("tagged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("blunder_tags_motif_idx").on(table.motif)]
);

export const calibrationAttempts = pgTable(
  "calibration_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fen: text("fen").notNull(),
    /** { phase, openness, materialBalance, sideAttacking, kingSafetyDelta, hasImbalance } */
    positionTags: jsonb("position_tags").$type<Record<string, string | number | boolean>>(),
    predictedWp: real("predicted_wp").notNull(),
    actualWp: real("actual_wp").notNull(),
    squaredError: real("squared_error").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("calibration_user_idx").on(table.userId, table.respondedAt)]
);

export const repertoireNodes = pgTable(
  "repertoire_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    color: colorEnum("color").notNull(),
    fen: text("fen").notNull(),
    moveUci: text("move_uci").notNull(),
    reachProb: real("reach_prob").notNull(),
    ratingBand: text("rating_band").notNull(),
    whiteWins: integer("white_wins").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    blackWins: integer("black_wins").notNull().default(0),
    evPerNode: real("ev_per_node").notNull().default(0),
    status: repertoireStatusEnum("status").notNull().default("unseen"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("repertoire_user_pos_idx").on(table.userId, table.color, table.fen, table.moveUci),
  ]
);

export const postmortemResponses = pgTable(
  "postmortem_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plyId: bigint("ply_id", { mode: "number" })
      .notNull()
      .references(() => plies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userReasoning: text("user_reasoning").notNull(),
    verdict: postmortemVerdictEnum("verdict").notNull(),
    critique: text("critique").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("postmortem_user_idx").on(table.userId, table.respondedAt)]
);

export const puzzles = pgTable(
  "puzzles",
  {
    id: text("id").primaryKey(),
    fen: text("fen").notNull(),
    /** Solution as a JSON array of UCI moves. */
    movesUci: jsonb("moves_uci").$type<string[]>().notNull(),
    rating: integer("rating").notNull(),
    ratingDeviation: integer("rating_deviation").notNull(),
    themes: jsonb("themes").$type<string[]>().notNull(),
    popularity: integer("popularity").notNull().default(0),
  },
  (table) => [index("puzzles_rating_idx").on(table.rating)]
);

export const puzzleAttempts = pgTable(
  "puzzle_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    puzzleId: text("puzzle_id")
      .notNull()
      .references(() => puzzles.id, { onDelete: "cascade" }),
    solved: boolean("solved").notNull(),
    timeMs: integer("time_ms"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("puzzle_attempts_user_idx").on(table.userId, table.attemptedAt)]
);
