-- Supabase security advisor criticals, 2026-08-23 (rls_disabled_in_public +
-- sensitive_columns_exposed): the auto-generated PostgREST/GraphQL data API
-- exposed every public table to anyone holding the browser-shipped anon key
-- (probe-confirmed: users — including email — games, sessions, puzzles all
-- readable AND writable with 200s). GAMBIT never uses that API: every query
-- runs over the direct Postgres connection as the table owner, auth lives in
-- the auth schema, and the Realtime poke is a broadcast channel that reads
-- no tables. So the entire public data-API surface closes:
--   1. RLS ON for every table with ZERO policies — the API roles (anon,
--      authenticated) can do nothing; the server's owner connection is
--      unaffected (non-FORCE RLS never applies to the table owner).
--   2. Explicit REVOKEs from the API roles, including DEFAULT PRIVILEGES so
--      future tables are born closed — defense in depth over (1).
-- db:verify (gate G5) now FAILS any table that ships without RLS, so a new
-- table cannot silently reopen the surface. The API roles exist on Supabase;
-- create them inert elsewhere (PGlite gate runs, local dev postgres).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE "anon" NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE "authenticated" NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "blunder_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calibration_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "challenges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_cache_global" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "explorer_agg" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "explorer_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairplay_flags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "games" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "linked_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "live_game_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "live_games" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "matchmaking_queue" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "openings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "postmortem_responses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "puzzle_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "puzzles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ratings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relationships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repertoire_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tb_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tempo_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "anon", "authenticated";
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "anon", "authenticated";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM "anon", "authenticated";
