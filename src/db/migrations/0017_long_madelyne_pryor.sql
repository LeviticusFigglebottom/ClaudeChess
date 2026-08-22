CREATE TABLE "eval_cache" (
	"user_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"epd" text NOT NULL,
	"depth" integer NOT NULL,
	"multipv" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_cache_user_id_variant_epd_depth_multipv_pk" PRIMARY KEY("user_id","variant","epd","depth","multipv")
);
--> statement-breakpoint
ALTER TABLE "eval_cache" ADD CONSTRAINT "eval_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;