import type { Metadata } from "next";
import { LiveClient } from "./live-client";

export const metadata: Metadata = { title: "Live game — GAMBIT" };

export default async function LiveGamePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <LiveClient gameId={id} />;
}
