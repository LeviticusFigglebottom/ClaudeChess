import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { BootDiagnostics } from "@/components/boot-diagnostics";

export const metadata: Metadata = {
  title: "GAMBIT",
  description:
    "A chess platform whose actual product is a set of trainers that don't exist anywhere else.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col antialiased">
        <header className="border-b border-zinc-800">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-bold tracking-tight text-amber-400">
              GAMBIT
            </Link>
            <Link href="/play" className="text-sm text-zinc-300 hover:text-white">
              Play
            </Link>
            <span className="cursor-default text-sm text-zinc-600" title="Phase 2">
              Analysis
            </span>
            <span className="cursor-default text-sm text-zinc-600" title="Phase 3">
              Puzzles
            </span>
            <span className="cursor-default text-sm text-zinc-600" title="Phase 5 — flag-gated">
              Train
            </span>
            <div className="ml-auto">
              <Link href="/engine-check" className="text-xs text-zinc-500 hover:text-zinc-300">
                engine check
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-zinc-800">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 text-xs text-zinc-500">
            <span>
              GAMBIT — Phase 0.5
              <Link href="/licenses" className="ml-3 text-zinc-600 hover:text-zinc-400">
                licenses
              </Link>
            </span>
            <BootDiagnostics />
          </div>
        </footer>
      </body>
    </html>
  );
}
