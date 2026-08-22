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
  smallint,
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

/**
 * Challenge lifecycle (Phase 1.5). 'open' until someone acts; expiry is a
 * property of expiresAt, not a stored status. An accepted challenge is the
 * Phase 4 handoff point where the multiplayer game row gets created.
 */
export const challengeStatusEnum = pgEnum("challenge_status", [
  "open",
  "accepted",
  "declined",
  "canceled",
]);

/**
 * Rating buckets: the five §7 time controls plus 'puzzle' (Phase 3's rated
 * puzzle mode keeps its own Glicko pool — never blended with game ratings,
 * and labeled as its own pool in any UI per the standing requirement).
 */
export const timeControlBucketEnum = pgEnum("time_control_bucket", [
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "daily",
  "puzzle",
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
  // Structural class (C2.3 extension): positional mechanisms, deterministic
  // geometry like everything above, ranked below geometric — a tactical
  // mechanism, where one exists, is always the better explanation.
  "HOLE_CREATED",
  "OUTPOST_CONCEDED",
  "BISHOP_PAIR_SURRENDERED",
  "STRUCTURE_DAMAGED",
  "BAD_PIECE_PLACEMENT",
  "FILE_OPENED_TOWARD_OWN_KING",
  "SPACE_CONCEDED",
  "GOOD_PIECE_TRADED",
  "PAWN_BREAK_MISSED",
  "KING_WALK",
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
    /**
     * Full B2.5 preference object (board, pieces, sound, animation, move list,
     * eval bar, accessibility) — the DB side of the localStorage↔DB sync that
     * must survive the anonymous→permanent conversion. The two named columns
     * above stay denormalized mirrors of prefs.boardTheme / prefs.pieceSet.
     */
    prefs: jsonb("prefs").$type<Record<string, unknown>>(),
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
    /**
     * Glicko-2 rating-period batch state (spec §7 — updates close per period,
     * never per game): the pending results since the last close, as
     * RatingPeriodState.pending. rating/rd/volatility above are the SETTLED
     * values from the last period close.
     */
    period: jsonb("period").$type<{ pending: unknown[] }>(),
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
    /** A3.1 studies: free-form analysis saved from the analysis board. */
    isStudy: boolean("is_study").notNull().default(false),
    playedAt: timestamp("played_at", { withTimezone: true }),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("games_user_idx").on(table.userId, table.playedAt),
    uniqueIndex("games_source_external_idx").on(table.userId, table.source, table.externalId),
  ]
);

// --- Import (Phase 2, C1) ---

/**
 * Per-user linked platform accounts (kickoff Phase 2): import is a product
 * feature — each user connects their own chess.com / Lichess handle. No
 * username is ever hardcoded or build-time configured. `verifiedAt` stays
 * null until a platform offers an ownership check (neither does today
 * without OAuth) — imported games are labeled unverified in the UI.
 */
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'chesscom' | 'lichess' (subset of game_source). */
    source: gameSourceEnum("source").notNull(),
    externalUsername: text("external_username").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** playedAt upper bound of already-imported games — the incremental cursor. */
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
    /** Weekly auto-import via cron (C1: polling only; hourly would be abusive). */
    autoImport: boolean("auto_import").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.source] })]
);

/**
 * Syzygy probe cache (B0.1): tablebase.lichess.ovh responses keyed by epd.
 * Shared across users — tablebase truth is user-independent.
 */
export const tbCache = pgTable("tb_cache", {
  /** epd (board, turn, castling, ep) of the probed position. */
  fenKey: text("fen_key").primaryKey(),
  /** Side-to-move WDL −2..2; null when the probe returned unknown. */
  wdl: smallint("wdl"),
  dtz: integer("dtz"),
  probedAt: timestamp("probed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Lichess opening-explorer proxy cache (Phase 3, 24h TTL). Key encodes the
 * full query (fen + variant + speeds + ratings).
 */
export const explorerCache = pgTable("explorer_cache", {
  key: text("key").primaryKey(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

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

    /**
     * Syzygy tablebase truth for ≤7-piece positions (B0.1), populated by the
     * Phase 2 probe. evalAfterCp is NEVER overwritten from tablebase data —
     * classification and win-prob consult these when tbHit; the eval graph
     * marks the region instead of jumping values. Standard-only.
     */
    tbWdl: smallint("tb_wdl"),
    tbDtz: integer("tb_dtz"),
    tbHit: boolean("tb_hit").notNull().default(false),
    tbProbedAt: timestamp("tb_probed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("plies_game_ply_idx").on(table.gameId, table.ply),
    index("plies_game_errors_idx")
      .on(table.gameId)
      .where(sql`${table.classification} in ('MISTAKE', 'BLUNDER')`),
  ]
);

/**
 * Motif tags (C2.4): one row per fired motif per ply, ranked by evidence
 * class then confidence — real blunders are frequently two things at once.
 * Detection is deterministic (C2); `evidence` carries the squares and PV
 * indices that triggered the detector (C3 renders them). `explanation` is
 * the optional LLM prose over that proven evidence (C5) — null until the
 * cached explanation call happens; never load-bearing.
 */
export const blunderTags = pgTable(
  "blunder_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plyId: bigint("ply_id", { mode: "number" })
      .notNull()
      .references(() => plies.id, { onDelete: "cascade" }),
    motif: blunderMotifEnum("motif").notNull(),
    /** Retained for compatibility; rank ordering is authoritative (C2.4). */
    secondaryMotif: blunderMotifEnum("secondary_motif"),
    /** 1 = top motif; every fired motif ≥ 0.6 gets a row. */
    rank: integer("rank").notNull().default(1),
    confidence: real("confidence").notNull(),
    /** Detector evidence: squares, PV indices, deltas — the C3 chain input. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    explanation: text("explanation"),
    /** Producer id: 'gambit-detectors-v1' for C2, a model id for C5 prose. */
    model: text("model").notNull(),
    taggedAt: timestamp("tagged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("blunder_tags_motif_idx").on(table.motif),
    uniqueIndex("blunder_tags_ply_motif_idx").on(table.plyId, table.motif),
  ]
);

export const calibrationAttempts = pgTable(
  "calibration_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fen: text("fen").notNull(),
    /** A1.4: calibration on 960/variant positions is a separate population. */
    variant: variantEnum("variant").notNull().default("standard"),
    /** Source ply when the position came from the user's own games. */
    plyId: bigint("ply_id", { mode: "number" }).references(() => plies.id, {
      onDelete: "set null",
    }),
    /** { phase, openness, materialBalance, sideAttacking, kingSafetyDelta, hasImbalance } */
    positionTags: jsonb("position_tags").$type<Record<string, string | number | boolean>>(),
    predictedWp: real("predicted_wp").notNull(),
    actualWp: real("actual_wp").notNull(),
    /** §9.1 secondary score: empirical outcome WP at the user's band, when in-book. */
    empiricalWp: real("empirical_wp"),
    squaredError: real("squared_error").notNull(),
    isCritical: boolean("is_critical").notNull().default(false),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("calibration_user_idx").on(table.userId, table.respondedAt)]
);

/** §9.3 critical-position recognition rounds ("critical / routine" in 3s). */
export const tempoAttempts = pgTable(
  "tempo_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plyId: bigint("ply_id", { mode: "number" })
      .notNull()
      .references(() => plies.id, { onDelete: "cascade" }),
    guessedCritical: boolean("guessed_critical").notNull(),
    actualCritical: boolean("actual_critical").notNull(),
    answeredInMs: integer("answered_in_ms").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tempo_user_idx").on(table.userId, table.respondedAt)]
);

/**
 * LLM response cache (§10, C5): explanations keyed by
 * (motifChain, evidenceHash), coach verdicts by (fen, san, reasoning hash).
 * The same blunder recurs across users — cache hits cost zero.
 */
export const llmCache = pgTable("llm_cache", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    /** Display SAN of the move at this node. */
    san: text("san"),
    /** §9.4 EV math: points per 100 games, memorization cost, EV/cost. */
    scoreDelta: real("score_delta").notNull().default(0),
    cost: real("cost").notNull().default(1),
    priority: real("priority").notNull().default(0),
    /** True when this node was flagged from the user's own played games. */
    isLeak: boolean("is_leak").notNull().default(false),
    /** SM-2 drilling state (§9.4). */
    easeFactor: real("ease_factor").notNull().default(2.5),
    intervalDays: real("interval_days").notNull().default(0),
    repetitions: integer("repetitions").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
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
    status: challengeStatusEnum("status").notNull().default("open"),
    /** Who accepted an open (token) challenge — for direct challenges, equals toUserId. */
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
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

// --- Multiplayer (Phase 4, §8/A3.5/A3.6) ---

export const liveGameStatusEnum = pgEnum("live_game_status", ["active", "finished", "aborted"]);

/**
 * Live multiplayer games. THE SERVER IS AUTHORITATIVE on clock and legality
 * (§8): every move replays server-side through the rules facade against
 * this row, clocks are charged from turnStartedAt with the same clock
 * module the UI renders from, and flagfall claims are verified against the
 * server's own arithmetic. Clients never compute remaining time for scoring.
 */
export const liveGames = pgTable(
  "live_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    whiteUserId: uuid("white_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blackUserId: uuid("black_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull().default("standard"),
    startFen: text("start_fen").notNull(),
    startPositionId: integer("start_position_id"),
    /** 'fischer' | 'bronstein' | 'delay' | 'daily' (A3.6). */
    clockMode: text("clock_mode").notNull(),
    clockInitialMs: integer("clock_initial_ms").notNull(),
    clockIncrementMs: integer("clock_increment_ms").notNull(),
    rated: boolean("rated").notNull().default(false),
    status: liveGameStatusEnum("status").notNull().default("active"),
    /** Space-joined UCI moves — the canonical move record. */
    movesUci: text("moves_uci").notNull().default(""),
    fen: text("fen").notNull(),
    turn: colorEnum("turn").notNull().default("white"),
    /** Banked clock ms as of turnStartedAt (server-authoritative). */
    clockWhiteMs: integer("clock_white_ms").notNull(),
    clockBlackMs: integer("clock_black_ms").notNull(),
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    /** Per-move %clk trail (mover's remaining AFTER each move), for the PGN. */
    clockTrailJson: jsonb("clock_trail_json").$type<number[]>().notNull().default([]),
    seq: integer("seq").notNull().default(0),
    drawOfferBy: colorEnum("draw_offer_by"),
    result: text("result"),
    termination: text("termination"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("live_games_white_idx").on(table.whiteUserId, table.status),
    index("live_games_black_idx").on(table.blackUserId, table.status),
    index("live_games_daily_idx")
      .on(table.turnStartedAt)
      .where(sql`${table.status} = 'active' and ${table.clockMode} = 'daily'`),
  ]
);

/** Append-only event log per live game — what the polling/SSE clients read. */
export const liveGameEvents = pgTable(
  "live_game_events",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => liveGames.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** 'move' | 'resign' | 'draw-offer' | 'draw-decline' | 'flag' | 'end' | 'abort' | 'blur' */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.seq] })]
);

/**
 * Matchmaking queue (§8): rating window widens with wait time; pairing MUST
 * pass the Phase 1.5 canPair guard (blocks are real).
 */
export const matchmakingQueue = pgTable(
  "matchmaking_queue",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull().default("standard"),
    clockMode: text("clock_mode").notNull(),
    clockInitialMs: integer("clock_initial_ms").notNull(),
    clockIncrementMs: integer("clock_increment_ms").notNull(),
    rated: boolean("rated").notNull().default(false),
    bucket: timeControlBucketEnum("bucket").notNull(),
    rating: doublePrecision("rating").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("matchmaking_pool_idx").on(table.variant, table.clockMode, table.rated)]
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
