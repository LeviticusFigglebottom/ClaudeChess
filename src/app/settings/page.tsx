import type { Metadata } from "next";
import { SettingsSections } from "@/components/settings-panel";

export const metadata: Metadata = { title: "Settings — GAMBIT" };

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-5 text-2xl font-bold text-paper">Settings</h1>
      <SettingsSections />
    </div>
  );
}
