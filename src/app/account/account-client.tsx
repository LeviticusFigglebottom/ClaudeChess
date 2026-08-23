"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-context";
import {
  ApiError,
  accountApi,
  deviceId,
  type MeResponse,
} from "@/lib/account/client";

/**
 * Account page (Phase 1.5): profile, the VISIBLE usage counters + caps
 * (A2.4 gate), device sessions, export, and deletion with its 30-day window.
 */
export function AccountClient() {
  const auth = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    accountApi
      .me()
      .then((response) => {
        setMe(response);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load account.");
      });
  }, []);

  useEffect(() => {
    if (auth.status === "ready") reload();
  }, [auth.status, reload]);

  if (auth.status === "disabled") {
    return (
      <Shell>
        <p className="text-sm text-text-dim">
          Accounts are not configured on this deployment (no Supabase environment).
          Everything still works locally — games, ratings and settings live in this
          browser.
        </p>
      </Shell>
    );
  }
  if (auth.status === "deleted") {
    return (
      <Shell>
        <div className="max-w-lg rounded-xl border border-warn-2 p-5">
          <h2 className="mb-2 text-lg font-semibold text-warn-2">Account pending deletion</h2>
          <p className="text-sm text-text-dim">
            This account is scheduled for permanent deletion
            {auth.recoverableUntil
              ? ` — recoverable until ${new Date(auth.recoverableUntil).toLocaleDateString()}`
              : ""}
            . After that, every game, rating and preference is gone for good.
          </p>
          <button
            onClick={() => void auth.recoverAccount()}
            className="mt-4 btn-primary px-4 py-1.5 text-sm"
          >
            Recover my account
          </button>
        </div>
      </Shell>
    );
  }
  if (auth.status !== "ready" || !me) {
    return (
      <Shell>
        <p className="text-sm text-text-faint">{error ?? "Loading…"}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileCard me={me} onSaved={reload} />
        <UsageCard me={me} />
        <SessionsCard me={me} onChanged={reload} />
        <DataCard me={me} />
        <FairplayCard />
        {me.isAdmin && <AdminCard />}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="mb-5 text-2xl font-bold text-paper">Account</h1>
      {children}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 text-base font-semibold text-paper">{title}</h2>
      {children}
    </section>
  );
}

function ProfileCard({ me, onSaved }: { me: MeResponse; onSaved: () => void }) {
  const auth = useAuth();
  const [handle, setHandle] = useState(me.user.handle);
  const [displayName, setDisplayName] = useState(me.user.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await accountApi.updateProfile({
        ...(handle !== me.user.handle ? { handle } : {}),
        displayName: displayName || null,
      });
      setMessage("Saved.");
      onSaved();
      void auth.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Profile">
      <div className="mb-2 flex items-center gap-3 text-sm">
        <span
          className={`inline-block h-2 w-2 rounded-full ${me.user.isAnonymous ? "bg-lcd" : "bg-brilliant"}`}
          aria-hidden
        />
        {me.user.isAnonymous ? (
          <span className="text-text-dim">
            Guest account — add an email (top-right menu) to keep your history everywhere.
          </span>
        ) : (
          <span className="text-text-dim">
            {me.user.email}
            {me.user.emailVerifiedAt === null ? " · unconfirmed" : " · verified"}
            {" · "}
            <span className="uppercase">{me.user.tier}</span>
            {me.user.title && (
              <span className="notation ml-1 text-brilliant">{me.user.title}</span>
            )}
          </span>
        )}
      </div>
      <label className="mb-2 block">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">Handle</span>
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          className="notation w-full rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
          maxLength={20}
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">
          Display name
        </span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="w-full rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
          maxLength={60}
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="btn-primary px-4 py-1.5 text-sm"
        >
          Save
        </button>
        {message && <span className="text-xs text-text-faint">{message}</span>}
      </div>
    </Card>
  );
}

function meterColor(used: number, cap: number): string {
  if (cap === 0) return "var(--edge-strong)";
  const ratio = used / cap;
  if (ratio >= 1) return "var(--warn-2)";
  if (ratio >= 0.8) return "var(--warn-1)";
  return "var(--lcd)";
}

function UsageMeter({ label, used, cap, hint }: { label: string; used: number; cap: number; hint?: string }) {
  const pct = cap === 0 ? 0 : Math.min(100, (used / cap) * 100);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-text-dim">{label}</span>
        <span className="notation text-xs text-text">
          {cap === 0 ? "locked" : `${used.toLocaleString()} / ${cap.toLocaleString()}`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-raise"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={used}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: meterColor(used, cap) }}
        />
      </div>
      {hint && <p className="mt-1 text-xs text-text-faint">{hint}</p>}
    </div>
  );
}

function UsageCard({ me }: { me: MeResponse }) {
  const { usage } = me;
  const locked = usage.caps.llmCalls === 0;
  return (
    <Card title={`Monthly usage — ${usage.month.slice(0, 7)}`}>
      {locked && (
        <p className="mb-3 text-xs text-text-faint">
          Game import, server analysis and coach features unlock with a verified
          account (they cost real compute). Playing, puzzles and in-browser analysis
          are unlimited for everyone.
        </p>
      )}
      <UsageMeter label="Game imports" used={usage.totals.importsRun} cap={usage.caps.importsRun} />
      <UsageMeter
        label="Deep analysis (plies)"
        used={usage.totals.analysisPliesDeep}
        cap={usage.caps.analysisPliesDeep}
      />
      <UsageMeter label="Coach / classification calls" used={usage.totals.llmCalls} cap={usage.caps.llmCalls} />
      <UsageMeter
        label="LLM spend"
        used={Math.round(usage.totals.llmCostMicros / 10_000)}
        cap={Math.round(usage.caps.llmCostMicros / 10_000)}
        hint={
          usage.caps.llmCostMicros > 0
            ? `$${(usage.totals.llmCostMicros / 1_000_000).toFixed(2)} of $${(usage.caps.llmCostMicros / 1_000_000).toFixed(2)}`
            : undefined
        }
      />
      <p className="text-xs text-text-faint">
        Limits reset on the 1st. Every metered route checks these counters before it
        does any paid work.
      </p>
    </Card>
  );
}

function SessionsCard({ me, onChanged }: { me: MeResponse; onChanged: () => void }) {
  const thisDevice = deviceId();
  return (
    <Card title="Devices">
      <ul className="text-sm">
        {me.sessions.map((session) => (
          <li
            key={session.id}
            className="flex items-center justify-between gap-3 border-b border-edge py-1.5 last:border-0"
          >
            <span className={session.revokedAt ? "text-text-faint line-through" : "text-text-dim"}>
              {session.deviceLabel ?? "Unknown device"}
              {session.id === thisDevice && (
                <span className="ml-2 text-xs text-brilliant">this device</span>
              )}
            </span>
            {!session.revokedAt && session.id !== thisDevice && (
              <button
                onClick={() => void accountApi.revokeSession(session.id).then(onChanged)}
                className="text-xs text-text-faint hover:text-warn-2"
              >
                revoke
              </button>
            )}
          </li>
        ))}
        {me.sessions.length === 0 && <li className="text-text-faint">No devices recorded.</li>}
      </ul>
      <p className="mt-2 text-xs text-text-faint">
        A revoked device signs itself out the next time it checks in.
      </p>
    </Card>
  );
}

function DataCard({ me }: { me: MeResponse }) {
  const auth = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await accountApi.deleteAccount();
      await auth.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Deletion failed — try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Your data">
      <p className="mb-3 text-sm text-text-dim">
        Everything GAMBIT knows about your play is yours: a full PGN archive plus all
        analysis as JSON.
      </p>
      <a
        href="/api/account/export"
        className="inline-block rounded border border-edge px-4 py-1.5 text-sm text-text hover:border-edge-strong"
        download={`gambit-export-${me.user.handle}.json`}
      >
        Download export
      </a>
      <div className="mt-5 border-t border-edge pt-4">
        {confirming ? (
          <div>
            <p className="mb-2 text-sm text-warn-2">
              Delete this account? You have 30 days to change your mind; after that
              every game, rating and preference is permanently removed.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => void remove()}
                disabled={busy}
                className="rounded bg-warn-2 px-4 py-1.5 text-sm font-medium text-field hover:opacity-90 disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded border border-edge px-4 py-1.5 text-sm text-text-dim"
              >
                Keep my account
              </button>
            </div>
            {error && <p className="mt-2 text-xs text-warn-2">{error}</p>}
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="text-sm text-text-faint hover:text-warn-2"
          >
            Delete account…
          </button>
        )}
      </div>
    </Card>
  );
}

function AdminCard() {
  const [handle, setHandle] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const grant = async () => {
    setMessage(null);
    try {
      const result = await accountApi.grantTitle(handle, title === "" ? null : title);
      setMessage(
        result.user.title
          ? `${result.user.handle} is now ${result.user.title}.`
          : `Title removed from ${result.user.handle}.`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Grant failed.");
    }
  };

  return (
    <Card title="Admin — titles (B1.3)">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">
            Handle
          </span>
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            className="notation rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs uppercase tracking-wide text-text-faint">
            Title
          </span>
          <select
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="text-sm"
          >
            <option value="">— revoke —</option>
            {["GM", "IM", "FM", "CM", "NM", "WGM", "WIM", "WFM", "WCM"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void grant()}
          className="btn-primary px-4 py-1.5 text-sm"
        >
          Apply
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-text-faint">{message}</p>}
    </Card>
  );
}

const SIGNAL_LABELS: Record<string, string> = {
  engine_correlation: "Engine correlation",
  accuracy_outlier: "Accuracy outlier",
  movetime_entropy: "Move-time consistency",
  tab_blur: "Tab switches in rated game",
};

function FairplayCard() {
  const [signals, setSignals] = useState<
    { id: string; gameId: string | null; signal: string; score: number; createdAt: string }[] | null
  >(null);

  useEffect(() => {
    fetch("/api/account/fairplay")
      .then(async (response) => (response.ok ? response.json() : { signals: [] }))
      .then((body: { signals?: [] }) => setSignals(body.signals ?? []))
      .catch(() => setSignals([]));
  }, []);

  return (
    <Card title="Fair play">
      <p className="mb-3 text-xs text-text-faint">
        Signals recorded on your rated games (A2.3). They are informational — nothing is
        automated off them — and this list shows you everything recorded about you.
      </p>
      {signals === null ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : signals.length === 0 ? (
        <p className="text-sm text-text-dim">No signals recorded.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {signals.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-text">{SIGNAL_LABELS[row.signal] ?? row.signal}</span>
              <span className="notation text-xs text-text-dim">
                {row.score.toFixed(2)} · {new Date(row.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
