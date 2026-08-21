CREATE TYPE "public"."challenge_color" AS ENUM('white', 'black', 'random');--> statement-breakpoint
CREATE TYPE "public"."relationship_kind" AS ENUM('friend', 'follow', 'block');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('free', 'plus');--> statement-breakpoint
CREATE TYPE "public"."variant" AS ENUM('standard', 'chess960', 'threecheck', 'koth', 'crazyhouse');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid,
	"variant" "variant" DEFAULT 'standard' NOT NULL,
	"time_control" text NOT NULL,
	"rated" boolean DEFAULT false NOT NULL,
	"color" "challenge_color" DEFAULT 'random' NOT NULL,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "challenges_token_unique" UNIQUE("token")
);--> statement-breakpoint
CREATE TABLE "fairplay_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" uuid,
	"signal" text NOT NULL,
	"score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"outcome" text
);--> statement-breakpoint
CREATE TABLE "openings" (
	"fen_key" text PRIMARY KEY NOT NULL,
	"eco" text NOT NULL,
	"name" text NOT NULL,
	"pgn" text NOT NULL,
	"ply" integer NOT NULL
);--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"kind" "relationship_kind" NOT NULL,
	"status" "relationship_status" DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_no_self" CHECK ("relationships"."user_id" <> "relationships"."target_user_id")
);--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_label" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"user_id" uuid NOT NULL,
	"month" date NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"llm_cost_cents" integer DEFAULT 0 NOT NULL,
	"imports_run" integer DEFAULT 0 NOT NULL,
	"analysis_plies_deep" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_user_id_month_pk" PRIMARY KEY("user_id","month")
);--> statement-breakpoint
DROP INDEX "ratings_user_tc_idx";--> statement-breakpoint
-- Repaired by scripts/fix-generated-migrations.mjs (B0.8): drizzle-kit emits
-- custom types in ALTER statements qualified with a literal undefined schema.
-- citext lives in the public schema (extension enabled in 0001); the snapshot
-- already records the type correctly, so future diffs are unaffected.
ALTER TABLE "users" ALTER COLUMN "handle" SET DATA TYPE citext;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "variant" "variant" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "start_fen" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "start_position_id" integer;--> statement-breakpoint
ALTER TABLE "plies" ADD COLUMN "variant_state_json" jsonb;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "variant" "variant" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country_code" char(2);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tier" "tier" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefers_board_theme" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefers_piece_set" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fairplay_flags" ADD CONSTRAINT "fairplay_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fairplay_flags" ADD CONSTRAINT "fairplay_flags_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "challenges_to_user_idx" ON "challenges" USING btree ("to_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "challenges_from_user_idx" ON "challenges" USING btree ("from_user_id","created_at");--> statement-breakpoint
CREATE INDEX "fairplay_user_idx" ON "fairplay_flags" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "openings_eco_idx" ON "openings" USING btree ("eco");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_user_target_kind_idx" ON "relationships" USING btree ("user_id","target_user_id","kind");--> statement-breakpoint
CREATE INDEX "relationships_target_idx" ON "relationships" USING btree ("target_user_id","kind");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ratings_user_variant_tc_idx" ON "ratings" USING btree ("user_id","variant","time_control");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_length" CHECK (char_length("users"."handle") between 3 and 20);
