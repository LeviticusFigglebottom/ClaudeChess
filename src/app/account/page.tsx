import type { Metadata } from "next";
import { AccountClient } from "./account-client";

export const metadata: Metadata = { title: "Account — GAMBIT" };

export default function AccountPage() {
  return <AccountClient />;
}
