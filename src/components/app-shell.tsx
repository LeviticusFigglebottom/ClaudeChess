"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "./account-menu";
import { RunnerChip } from "./analysis-runner";
import { BootDiagnostics } from "./boot-diagnostics";

/**
 * The app chrome: fixed sidebar on desktop, top bar + bottom tab bar on
 * mobile — chess.com-style shell around GAMBIT's instrument surfaces.
 * AccountMenu stays the ONLY `button[aria-haspopup="menu"]` in the DOM
 * (the deployment gates click it by that selector).
 */

const NAV = [
  { href: "/play", label: "Play", icon: PawnIcon },
  { href: "/puzzles", label: "Puzzles", icon: PuzzleIcon },
  { href: "/train", label: "Train", icon: TargetIcon },
  { href: "/games", label: "Games", icon: ArchiveIcon },
  { href: "/analysis", label: "Analysis", icon: ScopeIcon },
  { href: "/friends", label: "Friends", icon: PeopleIcon },
] as const;

const MOBILE_NAV = NAV.slice(0, 5);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-edge bg-surface lg:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <KnightMark className="h-8 w-8 text-accent" />
          <span className="notation text-lg font-bold tracking-tight text-paper">GAMBIT</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="sidebar-item" data-active={isActive(href)}>
              <Icon className="h-5 w-5 shrink-0" />
              {label}
            </Link>
          ))}
          <div className="mt-auto" />
          <Link href="/settings" className="sidebar-item" data-active={isActive("/settings")}>
            <GearIcon className="h-5 w-5 shrink-0" />
            Settings
          </Link>
        </nav>
        <div className="flex flex-col gap-1.5 px-5 py-3 text-[11px] text-text-faint">
          <BootDiagnostics />
          <span>
            <Link href="/licenses" className="hover:text-text-dim">
              licenses
            </Link>
            <span className="px-1.5">·</span>
            <Link href="/engine-check" className="hover:text-text-dim">
              engine check
            </Link>
          </span>
        </div>
      </aside>

      <div className="flex min-h-screen w-full flex-col lg:pl-56">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-edge bg-bg/85 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-4 py-2.5 lg:px-8">
            <Link href="/" className="flex items-center gap-2 lg:invisible">
              <KnightMark className="h-7 w-7 text-accent" />
              <span className="notation text-base font-bold tracking-tight text-paper">GAMBIT</span>
            </Link>
            <span className="flex min-w-0 items-center gap-3">
              <RunnerChip />
              <AccountMenu />
            </span>
          </div>
        </header>

        {/* Wide screens get the width: the old max-w-6xl (1152px) left a
            1990px monitor mostly empty and made every surface feel shrunk. */}
        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6 pb-24 lg:px-8 lg:pb-8">
          {children}
        </main>

        {/* Mobile bottom tabs */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-edge bg-surface lg:hidden">
          {MOBILE_NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
                isActive(href) ? "text-accent" : "text-text-faint"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          ))}
          <Link
            href="/settings"
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              isActive("/settings") ? "text-accent" : "text-text-faint"
            }`}
          >
            <GearIcon className="h-5 w-5" />
            More
          </Link>
        </nav>
      </div>
    </div>
  );
}

/* Inline icon set — stroke inherits currentColor, no external assets (COEP). */

function KnightMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <path
        d="M9 27h15M11 24h11c0-6-1.5-8.5-4-11l1.7-2.6a1 1 0 0 0-.3-1.4L15 6.2c-.5 2-2.2 2.9-4.1 4.3C9 12 8 14 8.5 15.8c.4 1.3 1.6 1.8 2.7 1.3l2.3-1.1c-1.5 2.5-2.5 5-2.5 8Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
function PawnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M6 21h12M8 18h8c-.6-3-2-4.6-3.4-5.8h.9a1 1 0 0 0 0-2h-.6a3 3 0 1 0-3.8 0h-.6a1 1 0 0 0 0 2h.9C9.9 13.4 8.6 15 8 18Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
function PuzzleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M9.5 4.5A1.5 1.5 0 0 1 12.5 4.5V6H16a1 1 0 0 1 1 1v3.5h1.5a1.5 1.5 0 0 1 0 3H17V19a1 1 0 0 1-1 1h-3.5v-1.5a1.5 1.5 0 0 0-3 0V20H6a1 1 0 0 1-1-1v-3.5H6.5a1.5 1.5 0 0 0 0-3H5V7a1 1 0 0 1 1-1h3.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function TargetIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </svg>
  );
}
function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2H4V7Zm1 4h14v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7Zm5 3h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ScopeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 11h5M11 8.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function PeopleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="9" cy="9" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.5 19c.8-2.9 3-4.5 5.5-4.5s4.7 1.6 5.5 4.5M15.5 6.6a3.2 3.2 0 1 1 1.6 6M16.6 14.7c2 .4 3.5 1.9 4 4.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
