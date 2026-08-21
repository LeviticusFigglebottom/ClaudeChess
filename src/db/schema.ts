import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Case-insensitive text (Postgres citext extension — enabled in migration 0001). */
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/**
 * Data model (spec §5). The load-bearing table is `plies`: one canonical
 * per-ply analysis record that calibration, fingerprinting, and time analysis
 * all read from. Evals are stored as White-POV centipawns (normalized once at
 * the /lib/eval boundary); win probabilities are MOVER-POV (that is what
 * classification consumes).
 */

export const gameSourceEnum = pgEnum("game_source", ["local", "online", "chesscom", "lichess"]);

export const colorEnum = pgEnum("color", ["white", "black"]);

/**
 * Rules variants (addendum A1.4). Mirrors VARIANTS in src/lib/chess/variant.ts
 * (kept literal here so drizzle-kit needs no app imports; a unit test pins
 * the two lists together). Every analysis, classification, and trainer query
 * MUST filter on variant — a chess960 blunder and a standard blunder are
 * different populations and are never pooled.
 */
export const variantEnum = pgEnum("variant", [
  "standard",
  "chess960",
  "threecheck",
  "koth",
  "crazyhouse",
]);

export const tierEnum = pgEnum("tier", ["free", "plus"]);

export const relationshipKindEnum = pgEnum("relationship_kind", ["friend", "follow", "block"]);

export const relationshipStatusEnum = pgEnum("relationship_status", ["pending", "accepted"]);

export const challengeColorEnum = pgEnum("challenge_color", ["white", "black", "random"]);

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

export const users = pgTable(
  "users",
  {
    /** Mirrors the Supabase auth.users id. */
    id: uuid("id").primaryKey(),
    /**
     * Case-insensitive unique, 3–20 chars (checked below). The reserved-word
     * list ("admin", "mod", route names, ...) is enforced at the application
     * layer where it can evolve without migrations.
     */
    handle: citext("handle").notNull().unique(),
    /** Null for anonymous accounts (A2.1 — anonymous-first). */
    email: text("email").unique(),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    countryCode: char("country_code", { length: 2 }),
    bio: text("bio"),
    /** FM/IM/GM etc — admin-granted only, never self-service. */
    title: text("title"),
    tier: tierEnum("tier").notNull().default("free"),
    prefersBoardTheme: text("prefers_board_theme"),
    prefersPieceSet: text("prefers_piece_set"),
    /** Soft delete with a 30-day recovery window, then hard cascade (A2.4). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    check("users_handle_length", sql`char_length(${table.handle}) between 3 and 20`),
  ]
);

export const ratings = pgTable(
  "ratings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A1.4: the rating key is (userId, variant, timeControl) — 960 rating is separate. */
    variant: variantEnum("variant").notNull().default("standard"),
    timeControl: timeControlBucketEnum("time_control").notNull(),
    rating: doublePrecision("rating").notNull(),
    rd: doublePrecision("rd").notNull(),
    volatility: doublePrecision("volatility").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ratings_user_variant_tc_idx").on(table.userId, table.variant, table.timeControl),
  ]
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull().default("standard"),
    /** Null for standard; required for chess960/custom starts (A1.4). */
    startFen: text("start_fen"),
    /** Scharnagl index 0–959 for chess960, null otherwise. */
    startPositionId: integer("start_position_id"),
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

    /** Variant-specific state (check counts, pockets, ...); null for standard (A1.4). */
    variantStateJson: jsonb("variant_state_json").$type<Record<string, unknown>>(),
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

// --- Account system (addendum A2.2) ---

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceLabel: text("device_label"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("sessions_user_idx").on(table.userId, table.createdAt)]
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** block must actually block: no challenges, no matchmaking pairing, no DMs. */
    kind: relationshipKindEnum("kind").notNull(),
    /** 'pending' only for friend requests; follow/block are immediate. */
    status: relationshipStatusEnum("status").notNull().default("accepted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("relationships_user_target_kind_idx").on(
      table.userId,
      table.targetUserId,
      table.kind
    ),
    index("relationships_target_idx").on(table.targetUserId, table.kind),
    check("relationships_no_self", sql`${table.userId} <> ${table.targetUserId}`),
  ]
);

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null + token = shareable open challenge link. */
    toUserId: uuid("to_user_id").references(() => users.id, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull().default("standard"),
    /** Raw time control, e.g. "300+3". */
    timeControl: text("time_control").notNull(),
    rated: boolean("rated").notNull().default(false),
    color: challengeColorEnum("color").notNull().default("random"),
    token: text("token").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("challenges_to_user_idx").on(table.toUserId, table.expiresAt),
    index("challenges_from_user_idx").on(table.fromUserId, table.createdAt),
  ]
);

/**
 * Per-user, per-month, per-model usage accounting (A2.4 rate limits, A3.8
 * affordability; shape per B0.4). Token counts are stable facts; cost is a
 * function of pricing that changes — recording both keeps the affordability
 * question answerable after a repricing. LLM rows key on the model id;
 * non-LLM counters (imports, deep-analysis plies) accumulate on the
 * `model = 'none'` row.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** First day of the month the counters cover. */
    month: date("month").notNull(),
    /** LLM model id for LLM rows; 'none' for the non-LLM counter row. */
    model: text("model").notNull().default("none"),
    llmCalls: integer("llm_calls").notNull().default(0),
    llmInputTokens: bigint("llm_input_tokens", { mode: "number" }).notNull().default(0),
    llmOutputTokens: bigint("llm_output_tokens", { mode: "number" }).notNull().default(0),
    /** Micro-dollars (10^-6 USD) — integer cents rounds cheap-model calls to zero. */
    llmCostMicros: bigint("llm_cost_micros", { mode: "number" }).notNull().default(0),
    importsRun: integer("imports_run").notNull().default(0),
    analysisPliesDeep: integer("analysis_plies_deep").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.month, table.model] })]
);

export const fairplayFlags = pgTable(
  "fairplay_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameId: uuid("game_id").references(() => games.id, { onDelete: "cascade" }),
    /** e.g. 'engine_correlation', 'accuracy_outlier', 'movetime_entropy', 'tab_blur'. */
    signal: text("signal").notNull(),
    score: real("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    outcome: text("outcome"),
  },
  (table) => [index("fairplay_user_idx").on(table.userId, table.createdAt)]
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Kept (nulled) after account hard-delete — audit history survives. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. 'auth.signin', 'rating.adjust', 'account.delete'. */
    action: text("action").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_user_idx").on(table.userId, table.createdAt)]
);

// --- Openings (addendum A3.4) ---

/**
 * Lichess chess-openings dataset, keyed by normalized FEN (epd: board, turn,
 * castling, ep — no move counters). Seeded from the vendored TSVs by
 * scripts/seed-openings.mjs; matching walks a game's positions and the
 * deepest hit wins. Standard chess only — chess960 games never match.
 */
export const openings = pgTable(
  "openings",
  {
    fenKey: text("fen_key").primaryKey(),
    eco: text("eco").notNull(),
    name: text("name").notNull(),
    pgn: text("pgn").notNull(),
    /** Ply depth of this line — the deepest-hit tiebreaker. */
    ply: integer("ply").notNull(),
  },
  (table) => [index("openings_eco_idx").on(table.eco)]
);
