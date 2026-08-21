import type { Metadata } from "next";
import { ChallengeClient } from "./challenge-client";

export const metadata: Metadata = { title: "Challenge — GAMBIT" };

export default async function ChallengePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ChallengeClient token={token} />;
}
