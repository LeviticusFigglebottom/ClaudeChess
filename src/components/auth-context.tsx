"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApiError,
  accountApi,
  bootstrapAccount,
  type OwnProfile,
} from "@/lib/account/client";
import type { SaveGamePayload } from "@/lib/account/games";
import { hasStoredPrefs, loadPrefs, normalizePrefs, savePrefs } from "@/lib/prefs/prefs";
import { createClient } from "@/lib/supabase/client";
import { usePrefs } from "./prefs-context";
import { applyServerRatingState, getAllRatingStates } from "./ratings-store";

/**
 * Anonymous-first auth (A2.1): an anonymous Supabase session is created on
 * first visit — play, puzzles, and local analysis all work before any email
 * exists. Conversion to a permanent account keeps the same auth id, so every
 * DB row (games, ratings, attempts) stays linked. When Supabase env is
 * absent, status is "disabled" and the app runs exactly as it did pre-1.5:
 * pure localStorage.
 */

export type AuthStatus =
  | "disabled" // no Supabase env — local-only mode
  | "connecting"
  | "ready"
  | "offline" // env present but bootstrap failed; retry available
  | "deleted"; // account soft-deleted; recovery offered

interface AuthContextValue {
  status: AuthStatus;
  profile: OwnProfile | null;
  /** Set while a conversion email confirmation is pending. */
  pendingEmail: string | null;
  recoverableUntil: string | null;
  refresh(): Promise<void>;
  convertToAccount(email: string, password: string): Promise<{ pendingConfirmation: boolean }>;
  signInWithPassword(email: string, password: string): Promise<void>;
  signOutDevice(): Promise<void>;
  recoverAccount(): Promise<void>;
  saveFinishedGame(payload: SaveGamePayload): void;
}

const AuthContext = createContext<AuthContextValue>({
  status: "disabled",
  profile: null,
  pendingEmail: null,
  recoverableUntil: null,
  refresh: async () => undefined,
  convertToAccount: async () => ({ pendingConfirmation: false }),
  signInWithPassword: async () => undefined,
  signOutDevice: async () => undefined,
  recoverAccount: async () => undefined,
  saveFinishedGame: () => undefined,
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { prefs, update } = usePrefs();
  const [status, setStatus] = useState<AuthStatus>(
    supabaseConfigured() ? "connecting" : "disabled"
  );
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [recoverableUntil, setRecoverableUntil] = useState<string | null>(null);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const busyRef = useRef(false);
  const lastSyncedPrefsRef = useRef<string | null>(null);
  const statusRef = useRef<AuthStatus>(status);
  statusRef.current = status;

  const getSupabase = useCallback((): SupabaseClient | null => {
    if (!supabaseConfigured()) return null;
    supabaseRef.current ??= createClient();
    return supabaseRef.current;
  }, []);

  const bootstrap = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const response = await bootstrapAccount({
        prefs: hasStoredPrefs() ? (loadPrefs() as unknown as Record<string, unknown>) : null,
        ratings: getAllRatingStates(),
      });
      if (response.deviceRevoked) {
        // This device was revoked from the account page: sign out and start
        // a fresh anonymous session (the auth listener re-bootstraps).
        await getSupabase()?.auth.signOut();
        return;
      }
      setProfile(response.user);
      setRecoverableUntil(null);
      if (response.prefs) {
        const normalized = normalizePrefs(response.prefs);
        lastSyncedPrefsRef.current = JSON.stringify(normalized);
        savePrefs(normalized);
        update(normalized);
      } else {
        lastSyncedPrefsRef.current = JSON.stringify(loadPrefs());
      }
      for (const entry of response.ratings) {
        applyServerRatingState(entry.variant, entry.bucket, entry.state);
      }
      setStatus("ready");
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        const body = error.body as { recoverableUntil?: string } | null;
        setRecoverableUntil(body?.recoverableUntil ?? null);
        setStatus("deleted");
        return;
      }
      if (error instanceof ApiError && error.code === "accounts_disabled") {
        setStatus("disabled");
        return;
      }
      console.warn("[auth] bootstrap failed — running local-only:", error);
      setStatus("offline");
    } finally {
      busyRef.current = false;
    }
  }, [getSupabase, update]);

  const connect = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) {
      setStatus("disabled");
      return;
    }
    setStatus("connecting");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw error;
      }
      await bootstrap();
    } catch (error) {
      console.warn("[auth] session setup failed — running local-only:", error);
      setStatus("offline");
    }
  }, [bootstrap, getSupabase]);

  // First mount: create/refresh the session, then reconcile.
  useEffect(() => {
    void connect();
    const supabase = getSupabase();
    if (!supabase) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setProfile(null);
        // Fresh anonymous session so the app keeps working.
        setTimeout(() => void connect(), 0);
      } else if (event === "USER_UPDATED" || event === "SIGNED_IN") {
        setTimeout(() => void bootstrap(), 0);
      }
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B2.5 preference sync: signed-in preference changes push to the DB
  // (debounced); localStorage remains the offline cache.
  useEffect(() => {
    if (statusRef.current !== "ready") return;
    const serialized = JSON.stringify(prefs);
    if (serialized === lastSyncedPrefsRef.current) return;
    const timer = setTimeout(() => {
      accountApi
        .savePrefs(prefs as unknown as Record<string, unknown>)
        .then(() => {
          lastSyncedPrefsRef.current = serialized;
        })
        .catch(() => {
          // Offline — the localStorage copy is intact; next bootstrap seeds it.
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [prefs, status]);

  const refresh = useCallback(async () => {
    await bootstrap();
  }, [bootstrap]);

  const convertToAccount = useCallback(
    async (email: string, password: string) => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Accounts are not configured.");
      const { data, error } = await supabase.auth.updateUser({ email, password });
      if (error) throw new Error(error.message);
      const stillAnonymous = data.user?.is_anonymous ?? false;
      if (stillAnonymous || data.user?.email_confirmed_at == null) {
        setPendingEmail(email);
        await bootstrap();
        return { pendingConfirmation: true };
      }
      setPendingEmail(null);
      await bootstrap();
      return { pendingConfirmation: false };
    },
    [bootstrap, getSupabase]
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Accounts are not configured.");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      setPendingEmail(null);
      await bootstrap();
    },
    [bootstrap, getSupabase]
  );

  const signOutDevice = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
  }, [getSupabase]);

  const recoverAccount = useCallback(async () => {
    await accountApi.recoverAccount();
    await bootstrap();
  }, [bootstrap]);

  const saveFinishedGame = useCallback((payload: SaveGamePayload) => {
    if (statusRef.current !== "ready") return; // local-only mode: PGN download still works
    accountApi
      .saveGame(payload)
      .then((result) => {
        if (result.rating) {
          applyServerRatingState(result.rating.variant, result.rating.bucket, result.rating.state);
        }
      })
      .catch((error) => {
        console.warn("[auth] game save failed (kept locally):", error);
      });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      profile,
      pendingEmail,
      recoverableUntil,
      refresh,
      convertToAccount,
      signInWithPassword,
      signOutDevice,
      recoverAccount,
      saveFinishedGame,
    }),
    [
      status,
      profile,
      pendingEmail,
      recoverableUntil,
      refresh,
      convertToAccount,
      signInWithPassword,
      signOutDevice,
      recoverAccount,
      saveFinishedGame,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
