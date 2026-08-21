import type { Metadata } from "next";
import { PlayClient } from "./play-client";

export const metadata: Metadata = {
  title: "Play — GAMBIT",
};

export default function PlayPage() {
  return <PlayClient />;
}
