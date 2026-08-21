ALTER TABLE "plies" ADD COLUMN "tb_wdl" smallint;--> statement-breakpoint
ALTER TABLE "plies" ADD COLUMN "tb_dtz" integer;--> statement-breakpoint
ALTER TABLE "plies" ADD COLUMN "tb_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plies" ADD COLUMN "tb_probed_at" timestamp with time zone;