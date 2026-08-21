ALTER TABLE "usage_counters" DROP CONSTRAINT "usage_counters_user_id_month_pk";--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "model" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_month_model_pk" PRIMARY KEY("user_id","month","model");--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "llm_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "llm_output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "llm_cost_micros" bigint DEFAULT 0 NOT NULL;
