"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "./auth-context";

/**
 * Header account chip (Phase 1.5). Anonymous-first: guests see their guest
 * handle and a quiet "save your progress" path — never a wall. In local-only
 * mode (no Supabase env) the chip says so and everything else still works.
 */
export function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"none" | "convert" | "signin">("none");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  if (auth.status === "disabled") {
    return (
      <span
        className="cursor-default text-xs text-text-faint"
        title="Supabase env not configured — playing locally. Games and settings stay in this browser."
      >
        local mode
      </span>
    );
  }
  if (auth.status === "connecting") {
    return <span className="text-xs text-text-faint">…</span>;
  }
  if (auth.status === "offline") {
    return (
      <button
        onClick={() => void auth.refresh()}
        className="text-xs text-text-faint hover:text-text-dim"
        title="Could not reach the account service — click to retry. Playing locally meanwhile."
      >
        offline · retry
      </button>
    );
  }
  if (auth.status === "deleted") {
    return (
      <Link href="/account" className="text-xs text-warn-2 hover:text-text">
        account pending deletion
      </Link>
    );
  }

  const profile = auth.profile;
  const isGuest = profile?.isAnonymous ?? true;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-text-dim transition-colors hover:border-edge-strong hover:bg-surface-2 hover:text-text"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${isGuest ? "bg-lcd" : "bg-accent"}`}
          aria-hidden
        />
        <span className="notation">{profile?.handle ?? "guest"}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="card absolute right-0 z-30 mt-2 w-60 p-2"
        >
          {isGuest ? (
            <>
              <p className="px-2 py-1.5 text-xs text-text-faint">
                Playing as a guest. Your games, ratings and settings are saved to this
                account — add an email to keep them everywhere.
              </p>
              <button
                role="menuitem"
                className="btn-primary mt-1 w-full justify-start px-2 py-1.5 text-sm"
                onClick={() => {
                  setOpen(false);
                  setDialog("convert");
                }}
              >
                Create account
              </button>
              <button
                role="menuitem"
                className="mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-text-dim hover:bg-surface-2 hover:text-text"
                onClick={() => {
                  setOpen(false);
                  setDialog("signin");
                }}
              >
                Sign in to existing account
              </button>
            </>
          ) : (
            <p className="px-2 py-1.5 text-xs text-text-faint">
              {profile?.email}
              {profile?.emailVerifiedAt === null && (
                <span className="block text-warn-1">email unconfirmed</span>
              )}
            </p>
          )}
          <div className="my-1 border-t border-edge" />
          <Link
            role="menuitem"
            href="/account"
            className="block rounded px-2 py-1.5 text-sm text-text-dim hover:bg-surface-2 hover:text-text"
            onClick={() => setOpen(false)}
          >
            Account &amp; usage
          </Link>
          <Link
            role="menuitem"
            href="/friends"
            className="block rounded px-2 py-1.5 text-sm text-text-dim hover:bg-surface-2 hover:text-text"
            onClick={() => setOpen(false)}
          >
            Friends &amp; challenges
          </Link>
          {!isGuest && (
            <button
              role="menuitem"
              className="mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-text-dim hover:bg-surface-2 hover:text-text"
              onClick={() => {
                setOpen(false);
                void auth.signOutDevice();
              }}
            >
              Sign out on this device
            </button>
          )}
        </div>
      )}

      {dialog !== "none" && (
        <AuthDialog mode={dialog} onClose={() => setDialog("none")} />
      )}
    </div>
  );
}

function AuthDialog({ mode, onClose }: { mode: "convert" | "signin"; onClose: () => void }) {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Portal target: the dialog renders inside the header, whose
  // backdrop-blur makes it the containing block for position:fixed — the
  // modal would center in the 52px header strip with its top half above
  // the viewport (the clipped-email bug). document.body has no such
  // ancestor, so `fixed inset-0` means the real viewport again.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "convert") {
        const result = await auth.convertToAccount(email, password);
        if (result.pendingConfirmation) {
          setPending(true);
          return;
        }
      } else {
        await auth.signInWithPassword(email, password);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "convert" ? "Create account" : "Sign in"}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="card max-h-[92vh] w-full max-w-sm overflow-y-auto p-5">
        <h2 className="mb-1 text-lg font-semibold text-paper">
          {mode === "convert" ? "Create your account" : "Sign in"}
        </h2>
        {mode === "convert" && !pending && (
          <p className="mb-3 text-xs text-text-faint">
            Your guest games, ratings and settings come with you — same account, now
            with a login.
          </p>
        )}

        {pending ? (
          <div>
            <p className="text-sm text-text">
              Confirmation email sent to <span className="notation">{email}</span>.
            </p>
            <p className="mt-2 text-xs text-text-faint">
              Click the link in it to finish — your history stays right here in the
              meantime.
            </p>
            <button
              className="btn-primary mt-4 w-full px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">
                Email
              </span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">
                Password
              </span>
              {/* Correct autocomplete semantics = the browser/password manager
                  actually offers to SAVE the login and autofills it later. */}
              <input
                type="password"
                name="password"
                autoComplete={mode === "convert" ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
              />
            </label>
            {error && <p className="mb-2 text-xs text-warn-2">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className="btn-primary flex-1 px-3 py-1.5 text-sm"
              >
                {busy ? "…" : mode === "convert" ? "Create account" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong"
              >
                Cancel
              </button>
            </div>
            {mode === "signin" && (
              <p className="mt-3 text-xs text-text-faint">
                Signing in switches this device to that account; this browser&apos;s
                guest progress stays with the guest account.
              </p>
            )}
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
