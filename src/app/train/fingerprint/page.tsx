import type { Metadata } from "next";
import { FingerprintClient } from "./fingerprint-client";

export const metadata: Metadata = { title: "Blunder fingerprint — GAMBIT" };

export default function FingerprintPage() {
  return <FingerprintClient />;
}
