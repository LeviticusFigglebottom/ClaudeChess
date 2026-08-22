import type { Metadata } from "next";
import { PuzzlesClient } from "./puzzles-client";

export const metadata: Metadata = { title: "Puzzles — GAMBIT" };

export default function PuzzlesPage() {
  return <PuzzlesClient />;
}
