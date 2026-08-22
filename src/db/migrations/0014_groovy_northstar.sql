ALTER TABLE "plies" ADD COLUMN "degraded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plies" ADD COLUMN "degraded_reason" text;