ALTER TABLE "blunder_tags" ALTER COLUMN "explanation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "blunder_tags" ADD COLUMN "rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "blunder_tags" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "blunder_tags_ply_motif_idx" ON "blunder_tags" USING btree ("ply_id","motif");