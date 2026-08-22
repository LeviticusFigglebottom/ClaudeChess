CREATE TABLE "explorer_agg" (
	"epd" text NOT NULL,
	"rating_band" text NOT NULL,
	"speed" text NOT NULL,
	"move_uci" text NOT NULL,
	"white" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"black" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "explorer_agg_epd_rating_band_speed_move_uci_pk" PRIMARY KEY("epd","rating_band","speed","move_uci")
);
--> statement-breakpoint
CREATE INDEX "explorer_agg_epd_idx" ON "explorer_agg" USING btree ("epd");