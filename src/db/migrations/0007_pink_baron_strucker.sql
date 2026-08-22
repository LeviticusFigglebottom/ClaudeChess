CREATE TABLE "explorer_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"user_id" uuid NOT NULL,
	"source" "game_source" NOT NULL,
	"external_username" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_imported_at" timestamp with time zone,
	"auto_import" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_accounts_user_id_source_pk" PRIMARY KEY("user_id","source")
);
--> statement-breakpoint
CREATE TABLE "tb_cache" (
	"fen_key" text PRIMARY KEY NOT NULL,
	"wdl" smallint,
	"dtz" integer,
	"probed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "is_study" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;