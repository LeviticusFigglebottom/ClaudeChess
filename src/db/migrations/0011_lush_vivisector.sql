CREATE TABLE "llm_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tempo_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ply_id" bigint NOT NULL,
	"guessed_critical" boolean NOT NULL,
	"actual_critical" boolean NOT NULL,
	"answered_in_ms" integer NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD COLUMN "variant" "variant" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD COLUMN "ply_id" bigint;--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD COLUMN "empirical_wp" real;--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD COLUMN "is_critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "san" text;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "score_delta" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "cost" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "priority" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "is_leak" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "ease_factor" real DEFAULT 2.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "interval_days" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "repetitions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tempo_attempts" ADD CONSTRAINT "tempo_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tempo_attempts" ADD CONSTRAINT "tempo_attempts_ply_id_plies_id_fk" FOREIGN KEY ("ply_id") REFERENCES "public"."plies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tempo_user_idx" ON "tempo_attempts" USING btree ("user_id","responded_at");--> statement-breakpoint
ALTER TABLE "calibration_attempts" ADD CONSTRAINT "calibration_attempts_ply_id_plies_id_fk" FOREIGN KEY ("ply_id") REFERENCES "public"."plies"("id") ON DELETE set null ON UPDATE no action;