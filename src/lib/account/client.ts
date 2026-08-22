"use client";

import type { RatingPeriodState } from "@/lib/rating/period";
import type { SaveGamePayload, SaveGameResult } from "./games";
import type { UsageSummary } from "./usage";

/**
 * Browser-side API client for the account routes. Every helper returns null
 * (or a typed error) rather than throwing on network/HTTP failure — the app
 * must keep working fully offline/unconfigured (A2.1: play first, sign up
 * maybe).
 */

export interface OwnProfile {
  id: string;
  handle: string;
  email: string | null;
  isAnonymous: boolean;
  emailVerifiedAt: string | null;
  displayName: string | null;
  countryCode: string | null;
  bio: string | null;
  title: string | null;
  tier: "free" | "plus";
  createdAt: string;
  deletedAt: string | null;
}

export interface RatingStatePayload {
  variant: string;
  bucket: string;
  state: RatingPeriodState;
  updatedAt: string;
}

export interface BootstrapResponse {
  user: OwnProfile;
  converted: boolean;
  created: boolean;
  prefs: Record<string, unknown> | null;
  ratings: RatingStatePayload[];
  deviceRevoked: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const err = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(
      response.status,
      err.error?.code ?? "http_error",
      err.error?.message ?? `Request failed (${response.status})`,
      body
    );
  }
  return body as T;
}

const DEVICE_KEY = "gambit.device.v1";

/** Stable per-browser device id for the sessions table. */
export function deviceId(): string | null {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export function deviceLabel(): string {
  try {
    const ua = navigator.userAgent;
    const browser = /Firefox\//.test(ua)
      ? "Firefox"
      : /Edg\//.test(ua)
        ? "Edge"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
    const platform = /Windows/.test(ua)
      ? "Windows"
      : /Mac OS/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Device";
    return `${browser} on ${platform}`;
  } catch {
    return "Browser";
  }
}

export function bootstrapAccount(payload: {
  prefs: Record<string, unknown> | null;
  ratings: { variant: string; bucket: string; state: RatingPeriodState }[];
  desiredHandle?: string;
}): Promise<BootstrapResponse> {
  return api<BootstrapResponse>("/api/account/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      deviceId: deviceId(),
      deviceLabel: deviceLabel(),
    }),
  });
}

export interface MeResponse {
  user: OwnProfile;
  usage: UsageSummary;
  sessions: { id: string; deviceLabel: string | null; createdAt: string; revokedAt: string | null }[];
  isAdmin: boolean;
}

export const accountApi = {
  me: () => api<MeResponse>("/api/account/me"),
  updateProfile: (patch: Record<string, unknown>) =>
    api<{ user: OwnProfile }>("/api/account/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  savePrefs: (prefs: Record<string, unknown>) =>
    api<{ prefs: Record<string, unknown> }>("/api/account/prefs", {
      method: "PUT",
      body: JSON.stringify({ prefs }),
    }),
  deleteAccount: () =>
    api<{ softDeleted: boolean; recoverableUntil: string }>("/api/account", {
      method: "DELETE",
    }),
  recoverAccount: () => api<{ user: OwnProfile }>("/api/account/recover", { method: "POST" }),
  revokeSession: (sessionId: string) =>
    api<{ ok: true }>("/api/account/sessions", {
      method: "POST",
      body: JSON.stringify({ action: "revoke", sessionId }),
    }),
  saveGame: (payload: SaveGamePayload) =>
    api<SaveGameResult>("/api/games", { method: "POST", body: JSON.stringify(payload) }),
  listGames: (limit = 20) =>
    api<{ games: Record<string, unknown>[] }>(`/api/games?limit=${limit}`),
  grantTitle: (handle: string, title: string | null) =>
    api<{ user: { handle: string; title: string | null } }>("/api/admin/title", {
      method: "POST",
      body: JSON.stringify({ handle, title }),
    }),
};

export interface PublicUserPayload {
  id: string;
  handle: string;
  displayName: string | null;
  countryCode: string | null;
  title: string | null;
}

export interface LichessMatchPayload {
  userId: string;
  handle: string;
  displayName: string | null;
  lichessUsername: string;
}

export interface FriendsResponse {
  friends: PublicUserPayload[];
  incoming: { requestId: string; from: PublicUserPayload }[];
  outgoing: { requestId: string; to: PublicUserPayload }[];
  blocked: PublicUserPayload[];
  /** GAMBIT users I follow on Lichess (verified↔verified handle matches). */
  lichessMatches: LichessMatchPayload[];
}

export const friendsApi = {
  list: () => api<FriendsResponse>("/api/friends"),
  request: (handle: string) =>
    api<{ status: string }>("/api/friends", {
      method: "POST",
      body: JSON.stringify({ action: "request", handle }),
    }),
  respond: (requestId: string, accept: boolean) =>
    api<{ ok: true }>("/api/friends", {
      method: "POST",
      body: JSON.stringify({ action: "respond", requestId, accept }),
    }),
  remove: (userId: string) =>
    api<{ ok: true }>("/api/friends", {
      method: "POST",
      body: JSON.stringify({ action: "remove", userId }),
    }),
  block: (handle: string) =>
    api<{ blocked: PublicUserPayload }>("/api/friends", {
      method: "POST",
      body: JSON.stringify({ action: "block", handle }),
    }),
  unblock: (userId: string) =>
    api<{ ok: true }>("/api/friends", {
      method: "POST",
      body: JSON.stringify({ action: "unblock", userId }),
    }),
};

export interface ChallengeViewPayload {
  id: string;
  from: PublicUserPayload;
  to: PublicUserPayload | null;
  variant: string;
  timeControl: string;
  rated: boolean;
  color: "white" | "black" | "random";
  status: "open" | "accepted" | "declined" | "canceled" | "expired";
  token: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedBy: PublicUserPayload | null;
}

export const challengesApi = {
  list: () =>
    api<{ incoming: ChallengeViewPayload[]; outgoing: ChallengeViewPayload[] }>(
      "/api/challenges"
    ),
  create: (input: {
    toHandle?: string;
    variant: string;
    timeControl: string;
    rated: boolean;
    color: "white" | "black" | "random";
  }) =>
    api<{ challenge: ChallengeViewPayload }>("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ action: "create", ...input }),
    }),
  byToken: (token: string) =>
    api<{ challenge: ChallengeViewPayload }>(`/api/challenge/${encodeURIComponent(token)}`),
  accept: (idOrToken: { id?: string; token?: string }) =>
    api<{ challenge: ChallengeViewPayload; play: null }>("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ action: "accept", ...idOrToken }),
    }),
  decline: (id: string) =>
    api<{ ok: true }>("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ action: "decline", id }),
    }),
  cancel: (id: string) =>
    api<{ ok: true }>("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ action: "cancel", id }),
    }),
};
