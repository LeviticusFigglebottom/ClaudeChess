import type { Metadata } from "next";
import { TempoClient } from "./tempo-client";

export const metadata: Metadata = { title: "Time allocation — GAMBIT" };

export default function TempoPage() {
  return <TempoClient />;
}
