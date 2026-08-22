import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource/martian-mono/400.css";
import "@fontsource/martian-mono/500.css";
import "@fontsource/martian-mono/700.css";
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./globals.css";
import { AccountMenu } from "@/components/account-menu";
import { AuthProvider } from "@/components/auth-context";
import { BootDiagnostics } from "@/components/boot-diagnostics";
import { PrefsProvider } from "@/components/prefs-context";

export const metadata: Metadata = {
  title: "GAMBIT",
  description:
    "A diagnostic instrument for your own play — board, engine, and the trainers that don't exist anywhere else.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col antialiased">
        <PrefsProvider>
          <AuthProvider>
            <header className="border-b border-edge">
              <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
                <Link href="/" className="notation text-lg font-bold tracking-tight text-paper">
                  GAMBIT
                </Link>
                <Link href="/play" className="text-sm text-text-dim hover:text-text">
                  Play
                </Link>
                <Link href="/games" className="text-sm text-text-dim hover:text-text">
                  Games
                </Link>
                <Link href="/analysis" className="text-sm text-text-dim hover:text-text">
                  Analysis
                </Link>
                <span className="cursor-default text-sm text-text-faint" title="Phase 3">
                  Puzzles
                </span>
                <span
                  className="cursor-default text-sm text-text-faint"
                  title="Phase 5 — flag-gated"
                >
                  Train
                </span>
                <div className="ml-auto flex items-center gap-4">
                  <Link
                    href="/engine-check"
                    className="text-xs text-text-faint hover:text-text-dim"
                  >
                    engine check
                  </Link>
                  <AccountMenu />
                </div>
              </nav>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
            <footer className="border-t border-edge">
              <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 text-xs text-text-faint">
                <span>
                  GAMBIT — Phase 1.5
                  <Link href="/licenses" className="ml-3 hover:text-text-dim">
                    licenses
                  </Link>
                </span>
                <BootDiagnostics />
              </div>
            </footer>
          </AuthProvider>
        </PrefsProvider>
      </body>
    </html>
  );
}
