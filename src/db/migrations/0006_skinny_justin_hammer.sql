CREATE TYPE "public"."challenge_status" AS ENUM('open', 'accepted', 'declined', 'canceled');--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "status" "challenge_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "accepted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "period" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;