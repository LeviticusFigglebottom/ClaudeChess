import { and, eq, sql } from "drizzle-orm";
import { usageCounters } from "@/db/schema";
import { AccountError, isVerified, type Db, type UserRow } from "./types";

/**
 * Usage accounting and rate limits (A2.4, B0.4): per-user, per-month caps on
 * LLM calls, imports, and deep-analysis plies, enforced against
 * usage_counters and surfaced in the UI. EVERY LLM and analysis route must
 * pass through consumeUsage (or checkUsage before doing unpaid work) — an
 * unbounded LLM endpoint behind an anonymous session is a bill waiting to
 * happen.
 *
 * Counter rows key on (userId, month, model): one row per LLM model plus a
 * 'none' row for the non-LLM counters. Caps apply to the SUM across rows.
 */

export type UsageKind = "llmCalls" | "importsRun" | "analysisPliesDeep";

export interface UsageCaps {
  llmCalls: number;
  importsRun: number;
  analysisPliesDeep: number;
  /** Monthly LLM spend ceiling in micro-dollars (10^-6 USD). */
  llmCostMicros: number;
}

/**
 * Monthly caps by account standing. Anonymous accounts get zero on every
 * server-metered resource (A2.1 — import and LLM features require a
 * verified account; client-side analysis costs us nothing and is unmetered).
 * Numbers are deliberate defaults, tunable without schema impact.
 */
export const USAGE_CAPS: Record<"anonymous" | "free" | "plus", UsageCaps> = {
  anonymous: { llmCalls: 0, importsRun: 0, analysisPliesDeep: 0, llmCostMicros: 0 },
  free: {
    llmCalls: 400,
    importsRun: 30,
    analysisPliesDeep: 60_000,
    llmCostMicros: 2_500_000, // $2.50/month
  },
  plus: {
    llmCalls: 4_000,
    importsRun: 300,
    analysisPliesDeep: 600_000,
    llmCostMicros: 25_000_000, // $25/month
  },
};

export function capsForUser(
  user: Pick<UserRow, "tier" | "isAnonymous" | "emailVerifiedAt">
): UsageCaps {
  if (!isVerified(user)) return USAGE_CAPS.anonymous;
  return USAGE_CAPS[user.tier];
}

/** First day of `now`'s month (UTC) — the usage_counters date key. */
export function monthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

export interface UsageTotals {
  llmCalls: number;
  importsRun: number;
  analysisPliesDeep: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCostMicros: number;
}

async function totalsFor(db: Db, userId: string, month: string): Promise<UsageTotals> {
  const rows = await db
    .select({
      llmCalls: sql<number>`coalesce(sum(${usageCounters.llmCalls}), 0)::int`,
      importsRun: sql<number>`coalesce(sum(${usageCounters.importsRun}), 0)::int`,
      analysisPliesDeep: sql<number>`coalesce(sum(${usageCounters.analysisPliesDeep}), 0)::int`,
      llmInputTokens: sql<number>`coalesce(sum(${usageCounters.llmInputTokens}), 0)::bigint`,
      llmOutputTokens: sql<number>`coalesce(sum(${usageCounters.llmOutputTokens}), 0)::bigint`,
      llmCostMicros: sql<number>`coalesce(sum(${usageCounters.llmCostMicros}), 0)::bigint`,
    })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.month, month)));
  const row = rows[0];
  return {
    llmCalls: Number(row?.llmCalls ?? 0),
    importsRun: Number(row?.importsRun ?? 0),
    analysisPliesDeep: Number(row?.analysisPliesDeep ?? 0),
    llmInputTokens: Number(row?.llmInputTokens ?? 0),
    llmOutputTokens: Number(row?.llmOutputTokens ?? 0),
    llmCostMicros: Number(row?.llmCostMicros ?? 0),
  };
}

export interface UsageDecision {
  allowed: boolean;
  kind: UsageKind;
  /** Total used this month BEFORE this request. */
  used: number;
  cap: number;
  remaining: number;
  /** Set when the deciding constraint was the cost ceiling, not the count. */
  costLimited?: boolean;
}

export interface ConsumeRequest {
  kind: UsageKind;
  amount: number;
  /** LLM rows carry the model id (B0.4); non-LLM consumption books to 'none'. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
}

function decide(
  totals: UsageTotals,
  caps: UsageCaps,
  req: ConsumeRequest
): UsageDecision {
  const used = totals[req.kind];
  const cap = caps[req.kind];
  const withinCount = used + req.amount <= cap;
  const withinCost =
    (req.costMicros ?? 0) === 0 ||
    totals.llmCostMicros + (req.costMicros ?? 0) <= caps.llmCostMicros;
  return {
    allowed: withinCount && withinCost,
    kind: req.kind,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    ...(withinCount && !withinCost ? { costLimited: true } : {}),
  };
}

/** Read-only allowance check — for guarding work before it is performed. */
export async function checkUsage(
  db: Db,
  user: UserRow,
  req: ConsumeRequest,
  now: Date = new Date()
): Promise<UsageDecision> {
  if (req.amount < 0) throw new AccountError("usage_amount", "Amounts are non-negative.");
  return decide(await totalsFor(db, user.id, monthKey(now)), capsForUser(user), req);
}

/**
 * Atomically checks the cap and books the consumption. Serialized per
 * (user, month) with an advisory transaction lock so concurrent requests
 * cannot stack past the cap. Denied requests book nothing.
 */
export async function consumeUsage(
  db: Db,
  user: UserRow,
  req: ConsumeRequest,
  now: Date = new Date()
): Promise<UsageDecision> {
  if (req.amount < 0) throw new AccountError("usage_amount", "Amounts are non-negative.");
  const month = monthKey(now);
  const caps = capsForUser(user);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`usage:${user.id}:${month}`}))`
    );
    const totals = await totalsFor(tx, user.id, month);
    const decision = decide(totals, caps, req);
    if (!decision.allowed) return decision;

    const model = req.model ?? "none";
    const increment: Record<UsageKind, number> = {
      llmCalls: 0,
      importsRun: 0,
      analysisPliesDeep: 0,
    };
    increment[req.kind] = req.amount;
    await tx
      .insert(usageCounters)
      .values({
        userId: user.id,
        month,
        model,
        llmCalls: increment.llmCalls,
        importsRun: increment.importsRun,
        analysisPliesDeep: increment.analysisPliesDeep,
        llmInputTokens: req.inputTokens ?? 0,
        llmOutputTokens: req.outputTokens ?? 0,
        llmCostMicros: req.costMicros ?? 0,
      })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.month, usageCounters.model],
        set: {
          llmCalls: sql`${usageCounters.llmCalls} + ${increment.llmCalls}`,
          importsRun: sql`${usageCounters.importsRun} + ${increment.importsRun}`,
          analysisPliesDeep: sql`${usageCounters.analysisPliesDeep} + ${increment.analysisPliesDeep}`,
          llmInputTokens: sql`${usageCounters.llmInputTokens} + ${req.inputTokens ?? 0}`,
          llmOutputTokens: sql`${usageCounters.llmOutputTokens} + ${req.outputTokens ?? 0}`,
          llmCostMicros: sql`${usageCounters.llmCostMicros} + ${req.costMicros ?? 0}`,
        },
      });
    return decision;
  });
}

export interface UsageSummary {
  month: string;
  caps: UsageCaps;
  totals: UsageTotals;
  byModel: {
    model: string;
    llmCalls: number;
    llmInputTokens: number;
    llmOutputTokens: number;
    llmCostMicros: number;
  }[];
}

/** The visible counter (A2.4): what /account renders next to each cap. */
export async function getUsageSummary(
  db: Db,
  user: UserRow,
  now: Date = new Date()
): Promise<UsageSummary> {
  const month = monthKey(now);
  const totals = await totalsFor(db, user.id, month);
  const rows = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, user.id), eq(usageCounters.month, month)));
  return {
    month,
    caps: capsForUser(user),
    totals,
    byModel: rows
      .filter((row) => row.model !== "none")
      .map((row) => ({
        model: row.model,
        llmCalls: row.llmCalls,
        llmInputTokens: Number(row.llmInputTokens),
        llmOutputTokens: Number(row.llmOutputTokens),
        llmCostMicros: Number(row.llmCostMicros),
      })),
  };
}
