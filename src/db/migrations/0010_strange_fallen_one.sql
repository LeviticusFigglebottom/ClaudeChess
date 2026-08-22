CREATE TYPE "public"."live_game_status" AS ENUM('active', 'finished', 'aborted');--> statement-breakpoint
CREATE TABLE "live_game_events" (
	"game_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_game_events_game_id_seq_pk" PRIMARY KEY("game_id","seq")
);
--> statement-breakpoint
CREATE TABLE "live_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"white_user_id" uuid NOT NULL,
	"black_user_id" uuid NOT NULL,
	"variant" "variant" DEFAULT 'standard' NOT NULL,
	"start_fen" text NOT NULL,
	"start_position_id" integer,
	"clock_mode" text NOT NULL,
	"clock_initial_ms" integer NOT NULL,
	"clock_increment_ms" integer NOT NULL,
	"rated" boolean DEFAULT false NOT NULL,
	"status" "live_game_status" DEFAULT 'active' NOT NULL,
	"moves_uci" text DEFAULT '' NOT NULL,
	"fen" text NOT NULL,
	"turn" "color" DEFAULT 'white' NOT NULL,
	"clock_white_ms" integer NOT NULL,
	"clock_black_ms" integer NOT NULL,
	"turn_started_at" timestamp with time zone,
	"clock_trail_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"draw_offer_by" "color",
	"result" text,
	"termination" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matchmaking_queue" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"variant" "variant" DEFAULT 'standard' NOT NULL,
	"clock_mode" text NOT NULL,
	"clock_initial_ms" integer NOT NULL,
	"clock_increment_ms" integer NOT NULL,
	"rated" boolean DEFAULT false NOT NULL,
	"bucket" time_control_bucket NOT NULL,
	"rating" double precision NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_game_events" ADD CONSTRAINT "live_game_events_game_id_live_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."live_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_games" ADD CONSTRAINT "live_games_white_user_id_users_id_fk" FOREIGN KEY ("white_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_games" ADD CONSTRAINT "live_games_black_user_id_users_id_fk" FOREIGN KEY ("black_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchmaking_queue" ADD CONSTRAINT "matchmaking_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_games_white_idx" ON "live_games" USING btree ("white_user_id","status");--> statement-breakpoint
CREATE INDEX "live_games_black_idx" ON "live_games" USING btree ("black_user_id","status");--> statement-breakpoint
CREATE INDEX "live_games_daily_idx" ON "live_games" USING btree ("turn_started_at") WHERE "live_games"."status" = 'active' and "live_games"."clock_mode" = 'daily';--> statement-breakpoint
CREATE INDEX "matchmaking_pool_idx" ON "matchmaking_queue" USING btree ("variant","clock_mode","rated");