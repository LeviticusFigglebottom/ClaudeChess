CREATE TABLE "eval_cache_global" (
	"variant" text NOT NULL,
	"epd" text NOT NULL,
	"depth" integer NOT NULL,
	"multipv" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_cache_global_variant_epd_depth_multipv_pk" PRIMARY KEY("variant","epd","depth","multipv")
);
