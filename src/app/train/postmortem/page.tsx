import type { Metadata } from "next";
import { PostmortemClient } from "./postmortem-client";

export const metadata: Metadata = { title: "Post-mortem — GAMBIT" };

export default function PostmortemPage() {
  return <PostmortemClient />;
}
