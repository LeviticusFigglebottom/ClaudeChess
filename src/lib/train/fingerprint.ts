import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { blunderTags, games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { AccountError } from "@/lib/account/types";
import type { VariantId } from "@/lib/chess/variant";
import { GamePosition } from "@/lib/chess/position";
import { drillThemesForMotifs, MOTIF_NATURE, type BlunderMotif } from "@/lib/eval/motif-themes";
import { classifySwing } from "@/lib/motifs/swing";
import { cachedJsonCall, evidenceHash, llmAvailable } from "@/lib/llm/client";

/**
 * §9.2 Blunder Fingerprinting, on the C5 pipeline: detection already ran
 * deterministically inside the Phase 2 analysis pass and lives in
 * blunder_tags with rank + evidence. This module is the presentation
 * layer — distribution, trend, drill deck — plus the ONLY LLM touchpoint:
 * prose explanations of already-proven motif chains, cached by
 * (motifChain, evidenceHash), fully optional (C0/C5).
 *
 * Population discipline (A1.4): everything filters on ONE variant.
 */

export interface FingerprintReport {
  variant: VariantId;
  errorPlies: number;
  distribution: { motif: string; count: number; share: number }[];
  /** Per-month share of the user's top motifs — is it shrinking? */
  trend: { month: string; errorPlies: number; byMotif: Record<string, number> }[];
  /** Drill themes for the top-3 motifs (B1.2 map; drill-unavailable marked). */
  drill: { motifs: string[]; themes: string[]; unavailable: string[] };
  /**
   * Headline stat: named-tactical vs positional/quiet error counts and the
   * tactical share of that pair ("other" = clock/search-habit, outside the
   * ratio). A player at 80% named tactics needs different work than one at
   * 40% — the ratio IS the diagnosis.
   */
  nature: { tactical: number; positional: number; other: number; tacticalShare: number };
  /**
   * UNCLEAR as a first-class category — positional / quiet errors, not a
   * detection failure — with its swing subdivision (does the punishment
   * mate, win material, or stay quiet?).
   */
  unclear: { count: number; share: number; mates: number; material: number; quiet: number };
}

export async function fingerprintReport(
  db: Db,
  userId: string,
  variant: VariantId = "standard"
): Promise<FingerprintReport> {
  const rows = await db
    .select({
      motif: blunderTags.motif,
      rank: blunderTags.rank,
      playedAt: games.playedAt,
      plyId: blunderTags.plyId,
    })
    .from(blunderTags)
    .innerJoin(plies, eq(blunderTags.plyId, plies.id))
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(and(eq(games.userId, userId), eq(games.variant, variant), eq(blunderTags.rank, 1)));

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.motif, (counts.get(row.motif) ?? 0) + 1);
  const total = rows.length;
  const distribution = [...counts.entries()]
    .map(([motif, count]) => ({ motif, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);

  const byMonth = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const month = (row.playedAt ?? new Date()).toISOString().slice(0, 7);
    const bucket = byMonth.get(month) ?? new Map<string, number>();
    bucket.set(row.motif, (bucket.get(row.motif) ?? 0) + 1);
    byMonth.set(month, bucket);
  }
  const trend = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, bucket]) => ({
      month,
      errorPlies: [...bucket.values()].reduce((a, b) => a + b, 0),
      byMotif: Object.fromEntries(bucket),
    }));

  const topMotifs = distribution
    .filter((row) => row.motif !== "UNCLEAR")
    .slice(0, 3)
    .map((row) => row.motif as BlunderMotif);
  const themes = drillThemesForMotifs(topMotifs);
  const unavailable = topMotifs.filter(
    (motif) => drillThemesForMotifs([motif]).length === 0
  );

  // Headline nature split (tactical vs positional; UNCLEAR is positional).
  const nature = { tactical: 0, positional: 0, other: 0, tacticalShare: 0 };
  for (const row of rows) nature[MOTIF_NATURE[row.motif as BlunderMotif] ?? "other"]++;
  const named = nature.tactical + nature.positional;
  nature.tacticalShare = named > 0 ? nature.tactical / named : 0;

  // UNCLEAR swing subdivision — pure replay over the stored record (the
  // refutation of ply N is ply N+1's stored pv1).
  const unclearPlies = await db
    .select({
      gameId: plies.gameId,
      ply: plies.ply,
      fenBefore: plies.fenBefore,
      fenAfter: plies.fenAfter,
      uci: plies.uci,
    })
    .from(blunderTags)
    .innerJoin(plies, eq(blunderTags.plyId, plies.id))
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(
      and(
        eq(games.userId, userId),
        eq(games.variant, variant),
        eq(blunderTags.rank, 1),
        eq(blunderTags.motif, "UNCLEAR")
      )
    );
  const unclear = { count: unclearPlies.length, share: total > 0 ? unclearPlies.length / total : 0, mates: 0, material: 0, quiet: 0 };
  if (unclearPlies.length > 0) {
    const gameIds = [...new Set(unclearPlies.map((row) => row.gameId))];
    const nextPlies = await db
      .select({ gameId: plies.gameId, ply: plies.ply, pv1: plies.pv1 })
      .from(plies)
      .where(
        and(
          inArray(plies.gameId, gameIds),
          inArray(plies.ply, [...new Set(unclearPlies.map((row) => row.ply + 1))])
        )
      );
    const refutations = new Map(nextPlies.map((row) => [`${row.gameId}:${row.ply}`, (row.pv1 as string[] | null) ?? []]));
    for (const row of unclearPlies) {
      const kind = classifySwing({
        fenBefore: row.fenBefore,
        fenAfter: row.fenAfter,
        movedUci: row.uci,
        refutationPv: refutations.get(`${row.gameId}:${row.ply + 1}`) ?? [],
        variant,
      });
      if (kind === "mate") unclear.mates++;
      else if (kind === "material") unclear.material++;
      else unclear.quiet++;
    }
  }

  return {
    variant,
    errorPlies: total,
    distribution,
    trend,
    drill: { motifs: topMotifs, themes, unavailable },
    nature,
    unclear,
  };
}

export interface MotifExplanation {
  explanation: string;
  cached: boolean;
  llm: boolean;
}

interface ExplanationJson extends Record<string, unknown> {
  explanation: string;
}

/**
 * C5 explanation flow for one error ply: cache lookup by
 * (motifChain, evidenceHash); on miss, ONE LLM call whose input is the
 * proven chain and evidence. Without an LLM key this returns null and the
 * feature stays fully functional (the chain itself renders per C3).
 */
export async function explainBlunder(
  db: Db,
  userId: string,
  plyId: number
): Promise<MotifExplanation | null> {
  const ply = (
    await db
      .select({
        id: plies.id,
        san: plies.san,
        fenBefore: plies.fenBefore,
        wpLoss: plies.wpLoss,
        classification: plies.classification,
        bestMoveUci: plies.bestMoveUci,
        gameUserId: games.userId,
        variant: games.variant,
      })
      .from(plies)
      .innerJoin(games, eq(plies.gameId, games.id))
      .where(eq(plies.id, plyId))
  )[0];
  if (!ply || ply.gameUserId !== userId) throw new AccountError("not_found", "No such ply.", 404);

  const tags = await db
    .select()
    .from(blunderTags)
    .where(eq(blunderTags.plyId, plyId))
    .orderBy(blunderTags.rank);
  if (tags.length === 0) return null;
  const chain = tags.map((tag) => tag.motif).join(">");
  const evidence = tags.map((tag) => ({ motif: tag.motif, rank: tag.rank, evidence: tag.evidence }));
  const key = `${chain}:${evidenceHash({ evidence, fen: ply.fenBefore, san: ply.san })}`;

  // Stored explanation from an earlier call?
  const existing = tags.find((tag) => tag.rank === 1 && tag.explanation);
  if (existing?.explanation) {
    return { explanation: existing.explanation, cached: true, llm: true };
  }
  if (!llmAvailable()) return null;

  const { value, cached } = await cachedJsonCall<ExplanationJson>(
    db,
    "motif-explain",
    key,
    {
      system:
        "You are a chess coach writing ONE short paragraph (max 90 words) explaining a mistake " +
        "whose mechanism has ALREADY been proven by engine analysis. You are given the proven " +
        "motif chain and its machine-checked evidence. Describe that mechanism in plain, vivid " +
        "language. Do NOT invent tactics, do NOT contradict the evidence, do NOT hedge. " +
        'Respond with JSON only, no markdown fences: {"explanation": "..."}',
      user: JSON.stringify({
        position: ply.fenBefore,
        played: ply.san,
        engineBest: ply.bestMoveUci,
        winProbabilityLost: ply.wpLoss,
        classification: ply.classification,
        provenMotifChain: chain,
        evidence,
      }),
      maxTokens: 300,
    },
    (raw) => {
      const value = raw as ExplanationJson;
      if (typeof value.explanation !== "string" || value.explanation.length === 0) {
        throw new Error("explanation missing");
      }
      return { explanation: value.explanation.slice(0, 700) };
    }
  );
  // Persist onto the rank-1 tag so the review UI shows it without a re-call.
  await db
    .update(blunderTags)
    .set({ explanation: value.explanation })
    .where(and(eq(blunderTags.plyId, plyId), eq(blunderTags.rank, 1)));
  return { explanation: value.explanation, cached, llm: true };
}

/**
 * The user's error plies for the fingerprint list UI. Each row carries the
 * engine's preferred move (pv1[0], in SAN where it replays) so UNCLEAR
 * instances can render "the engine preferred this — work out why" with no
 * mechanism claim and no invented explanation.
 */
export async function listErrorPlies(
  db: Db,
  userId: string,
  variant: VariantId,
  motif?: string,
  limit = 30
): Promise<
  {
    plyId: number;
    gameId: string;
    ply: number;
    san: string;
    motif: string;
    wpLoss: number | null;
    bestUci: string | null;
    bestSan: string | null;
  }[]
> {
  const rows = await db
    .select({
      plyId: blunderTags.plyId,
      gameId: plies.gameId,
      ply: plies.ply,
      san: plies.san,
      motif: blunderTags.motif,
      wpLoss: plies.wpLoss,
      fenBefore: plies.fenBefore,
      pv1: plies.pv1,
      playedAt: games.playedAt,
    })
    .from(blunderTags)
    .innerJoin(plies, eq(blunderTags.plyId, plies.id))
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(
      and(
        eq(games.userId, userId),
        eq(games.variant, variant),
        eq(blunderTags.rank, 1),
        motif ? eq(blunderTags.motif, motif as BlunderMotif) : undefined
      )
    )
    .orderBy(desc(games.playedAt))
    .limit(limit);
  return rows.map(({ playedAt: _unused, fenBefore, pv1, ...row }) => {
    const bestUci = ((pv1 as string[] | null) ?? [])[0] ?? null;
    let bestSan: string | null = null;
    if (bestUci) {
      try {
        bestSan = GamePosition.fromFen(fenBefore, variant).moveUci(bestUci)?.san ?? null;
      } catch {
        bestSan = null;
      }
    }
    return { ...row, bestUci, bestSan };
  });
}
