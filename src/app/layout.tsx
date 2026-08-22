import type { Metadata } from "next";
import "@fontsource/martian-mono/400.css";
import "@fontsource/martian-mono/500.css";
import "@fontsource/martian-mono/700.css";
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth-context";
import { PrefsProvider } from "@/components/prefs-context";

export const metadata: Metadata = {
  title: "GAMBIT",
  description:
    "A diagnostic instrument for your own play — board, engine, and the trainers that don't exist anywhere else.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <PrefsProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </PrefsProvider>
      </body>
    </html>
  );
}
