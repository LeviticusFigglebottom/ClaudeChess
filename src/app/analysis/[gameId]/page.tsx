import type { Metadata } from "next";
import { ReviewClient } from "./review-client";

export const metadata: Metadata = { title: "Review — GAMBIT" };

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  return <ReviewClient gameId={gameId} />;
}
