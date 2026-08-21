import type { Metadata } from "next";
import { FriendsClient } from "./friends-client";

export const metadata: Metadata = { title: "Friends — GAMBIT" };

export default function FriendsPage() {
  return <FriendsClient />;
}
