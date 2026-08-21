CREATE TYPE "public"."blunder_motif" AS ENUM('HANGING_PIECE', 'OVERLOADED_DEFENDER', 'PINNED_PIECE_MOVED', 'BACK_RANK', 'FORK_ALLOWED', 'SKEWER_ALLOWED', 'DISCOVERED_ATTACK_MISSED', 'TRAPPED_PIECE', 'REMOVING_THE_DEFENDER', 'ZWISCHENZUG_MISSED', 'KING_SAFETY_COLLAPSE', 'PAWN_STRUCTURE_COLLAPSE', 'MATERIALISM', 'PREMATURE_ATTACK', 'PASSIVITY', 'ENDGAME_TECHNIQUE', 'PAWN_RACE_MISCOUNT', 'OPPOSITION_LOST', 'TIME_PRESSURE', 'TUNNEL_VISION_POST_FORCING', 'UNCLEAR');--> statement-breakpoint
CREATE TYPE "public"."classification" AS ENUM('BOOK', 'BRILLIANT', 'GREAT', 'BEST', 'EXCELLENT', 'GOOD', 'INACCURACY', 'MISTAKE', 'BLUNDER', 'MISS');--> statement-breakpoint
CREATE TYPE "public"."color" AS ENUM('white', 'black');--> statement-breakpoint
CREATE TYPE "public"."game_source" AS ENUM('local', 'online', 'chesscom', 'lichess');--> statement-breakpoint
CREATE TYPE "public"."postmortem_verdict" AS ENUM('CORRECT', 'RIGHT_MOVE_WRONG_REASON', 'MISREAD_THREAT', 'MISSED_OPPORTUNITY', 'SOUND_BUT_INCOMPLETE');--> statement-breakpoint
CREATE TYPE "public"."repertoire_status" AS ENUM('known', 'learning', 'unseen');--> statement-breakpoint
CREATE TYPE "public"."time_control_bucket" AS ENUM('bullet', 'blitz', 'rapid', 'classical', 'daily');--> statement-breakpoint
CREATE TABLE "blunder_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ply_id" bigint NOT NULL,
	"motif" "blunder_motif" NOT NULL,
	"secondary_motif" "blunder_motif",
	"confidence" real NOT NULL,
	"explanation" text NOT NULL,
	"model" text NOT NULL,
	"tagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fen" text NOT NULL,
	"position_tags" jsonb,
	"predicted_wp" real NOT NULL,
	"actual_wp" real NOT NULL,
	"squared_error" real NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "game_source" NOT NULL,
	"external_id" text,
	"pgn" text NOT NULL,
	"white_name" text NOT NULL,
	"black_name" text NOT NULL,
	"user_color" "color" NOT NULL,
	"result" text NOT NULL,
	"termination" text,
	"time_control" text,
	"eco" text,
	"opening" text,
	"played_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plies" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"move_number" integer NOT NULL,
	"color" "color" NOT NULL,
	"san" text NOT NULL,
	"uci" text NOT NULL,
	"fen_before" text NOT NULL,
	"fen_after" text NOT NULL,
	"eval_before_cp" integer,
	"eval_after_cp" integer,
	"mate_before" integer,
	"mate_after" integer,
	"best_move_uci" text,
	"pv1" jsonb,
	"pv2" jsonb,
	"pv3" jsonb,
	"wp_before" real,
	"wp_after" real,
	"wp_loss" real,
	"classification" "classification",
	"clock_ms_remaining" integer,
	"time_spent_ms" integer,
	"is_critical" boolean DEFAULT false NOT NULL,
	"analyzed_at_depth" integer
);
--> statement-breakpoint
CREATE TABLE "postmortem_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ply_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"user_reasoning" text NOT NULL,
	"verdict" "postmortem_verdict" NOT NULL,
	"critique" text NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzle_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"puzzle_id" text NOT NULL,
	"solved" boolean NOT NULL,
	"time_ms" integer,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzles" (
	"id" text PRIMARY KEY NOT NULL,
	"fen" text NOT NULL,
	"moves_uci" jsonb NOT NULL,
	"rating" integer NOT NULL,
	"rating_deviation" integer NOT NULL,
	"themes" jsonb NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"user_id" uuid NOT NULL,
	"time_control" time_control_bucket NOT NULL,
	"rating" double precision NOT NULL,
	"rd" double precision NOT NULL,
	"volatility" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repertoire_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"color" "color" NOT NULL,
	"fen" text NOT NULL,
	"move_uci" text NOT NULL,
	"reach_prob" real NOT NULL,
	"rating_band" text NOT NULL,
	"white_wins" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"black_wins" integer DEFAULT 0 NOT NULL,
	"ev_per_node" real DEFAULT 0 NOT NULL,
	"status" "repertoire_status" DEFAULT 'unseen' NOT NULL,
	"last_reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "blunder_tags" ADD CONSTRAINT "blunder_tags_ply_id_plies_id_fk" FOREIGN KEY ("ply_id") REFERENCES "public"."plies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD CONSTRAINT "calibration_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plies" ADD CONSTRAINT "plies_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortem_responses" ADD CONSTRAINT "postmortem_responses_ply_id_plies_id_fk" FOREIGN KEY ("ply_id") REFERENCES "public"."plies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortem_responses" ADD CONSTRAINT "postmortem_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_puzzle_id_puzzles_id_fk" FOREIGN KEY ("puzzle_id") REFERENCES "public"."puzzles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD CONSTRAINT "repertoire_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blunder_tags_motif_idx" ON "blunder_tags" USING btree ("motif");--> statement-breakpoint
CREATE INDEX "calibration_user_idx" ON "calibration_attempts" USING btree ("user_id","responded_at");--> statement-breakpoint
CREATE INDEX "games_user_idx" ON "games" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE UNIQUE INDEX "games_source_external_idx" ON "games" USING btree ("user_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plies_game_ply_idx" ON "plies" USING btree ("game_id","ply");--> statement-breakpoint
CREATE INDEX "plies_game_errors_idx" ON "plies" USING btree ("game_id") WHERE "plies"."classification" in ('MISTAKE', 'BLUNDER');--> statement-breakpoint
CREATE INDEX "postmortem_user_idx" ON "postmortem_responses" USING btree ("user_id","responded_at");--> statement-breakpoint
CREATE INDEX "puzzle_attempts_user_idx" ON "puzzle_attempts" USING btree ("user_id","attempted_at");--> statement-breakpoint
CREATE INDEX "puzzles_rating_idx" ON "puzzles" USING btree ("rating");--> statement-breakpoint
CREATE UNIQUE INDEX "ratings_user_tc_idx" ON "ratings" USING btree ("user_id","time_control");--> statement-breakpoint
CREATE UNIQUE INDEX "repertoire_user_pos_idx" ON "repertoire_nodes" USING btree ("user_id","color","fen","move_uci");