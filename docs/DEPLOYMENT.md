# Deployment runbook — the Task 2 pass, ready to execute

Status: **blocked on credentials** (none present in the dev container as of
2026-08-22: no Vercel token, no Supabase project, no `ANTHROPIC_API_KEY`).
Everything below is verified as far as it can be without them; each step names
its gate so the pass produces measured pass/fail values, not vibes.

## What the Vercel project needs

Framework preset: Next.js (repo root). `npm run build` is green locally on the
branch tip — lint + typecheck included. `vercel.json` already carries the three
cron routes (purge-deleted daily, auto-import weekly, daily-timeouts hourly).

Environment variables (Production + Preview):

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API | absent = app runs local-only mode, so set both or neither |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page | anon/publishable key, safe for client |
| `DATABASE_URL` | Supabase → Project Settings → Database (pooled, port 6543 with `?pgbouncer=true`, or session pooler) | Drizzle server-side queries + migrations |
| `ANTHROPIC_API_KEY` | console.anthropic.com | server-only; powers `/api/coach`, `/api/classify-blunder`, §9.5 post-mortem |
| `ADMIN_USER_IDS` | comma-separated Supabase auth UUIDs | B1.3 title admin; can start empty |
| `CRON_SECRET` | random string | Vercel injects it as the cron bearer; routes 401 without it |
| `EXPLORER_BASE_URL` | **leave unset in production** | unset = real `explorer.lichess.ovh`. The dev-container 401 is an egress-network refusal (nginx 401 while `tablebase.lichess.ovh` answers 200 from the same shell — re-verified 2026-08-22); Vercel egress must be re-measured, which is gate (c) |
| `NEXT_PUBLIC_FF_*` | omit (default off) | trainers/variants stay flag-gated per §9; per-user labs overrides can still enable them |
| `GAMBIT_DEV_AUTH` / `NEXT_PUBLIC_GAMBIT_DEV_AUTH` | **never set** | dev-auth harness is a gate-infrastructure identity bypass |

One-time against the production `DATABASE_URL`:

```bash
npx drizzle-kit migrate        # 0000–0012 (npm run db:verify proves the chain on empty PG)
npm run db:seed:openings       # openings upsert (idempotent)
```

Supabase auth config: enable anonymous sign-ins (A2.1 anonymous-first), enable
email provider with confirmation for the anonymous→permanent conversion.

## The pass itself, in order

- **(a) Vercel + isolation.** Deploy; on the preview URL check DevTools
  `crossOriginIsolated === true` (or just load `/engine-check` — it renders
  exactly this plus engine liveness). Then from a checkout:
  `npm run gate -- --url https://<preview>` (appends to
  `docs/gate-history.jsonl`). COOP/COEP come from `next.config.ts`; every
  asset is self-hosted, so the only expected isolation risk is a
  Vercel-injected script (feedback widget/analytics) — if `/engine-check`
  shows red, that's the first suspect and a real finding.
- **(b) Real Supabase auth chain.** Fresh browser → anonymous session
  appears (user row, `isAnonymous`), play/import something → add email →
  confirmation link → verified. Gate: same `users.id` row before and after
  (A2.1 links, never copies — `account.test.ts` pins the logic; this verifies
  the live service honors it), history/prefs intact, usage caps switch from
  anonymous (all zero) to verified tiers.
- **(c) Explorer from production egress.** With `EXPLORER_BASE_URL` unset,
  hit the explorer panel / §9.1 / §9.4 on the deployment; re-run the Phase 3
  explorer gate (`gate-phase3.mts` explorer half) against it. Pass = 200s and
  warm-cache p95 ≤ 1500ms; then mark the mock-explorer stand-in superseded in
  README. Fail (same 401 as the dev container) = a real finding: the app
  degrades gracefully (surfaced `upstreamError`), document and move on.
- **(d) LLM routes end-to-end.** With `ANTHROPIC_API_KEY` set: §9.5
  post-mortem submit → judged; `/api/classify-blunder` explanation on a real
  tagged blunder. Gates: `usage_counters` increments match model calls;
  `llm_cache` row per `(motifChain, evidenceHash)`; repeat call = cache hit,
  **no** usage increment (invariant 12: cache hits are free).
- **(e) Playwright vs the deployed URL.** `gate-phase4.mts` (two-browser
  3+0 live game) pointed at the deployment — needs two real accounts or a
  temporary preview env with dev-auth (preview ONLY, never production);
  drift and propagation numbers get re-measured and recorded next to the
  local-infra numbers in README.

Record every measured value in README's gate tables; a deployed failure is a
finding to report, not to route around locally.
