import type { Metadata } from "next";
import { RepertoireClient } from "./repertoire-client";

export const metadata: Metadata = { title: "Repertoire EV — GAMBIT" };

export default function RepertoirePage() {
  return <RepertoireClient />;
}
