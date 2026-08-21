"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-context";
import {
  challengesApi,
  friendsApi,
  type ChallengeViewPayload,
  type FriendsResponse,
  type PublicUserPayload,
} from "@/lib/account/client";

/**
 * Friends, blocks, and challenges (Phase 1.5). Blocks are real: a blocked
 * pair cannot challenge, pair, or re-add each other until unblocked.
 * Accepted challenges become live games in Phase 4 — until then acceptance
 * is recorded and both sides see it.
 */
export function FriendsClient() {
  const auth = useAuth();
  const [friends, setFriends] = useState<FriendsResponse | null>(null);
  const [challenges, setChallenges] = useState<{
    incoming: ChallengeViewPayload[];
    outgoing: ChallengeViewPayload[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([friendsApi.list(), challengesApi.list()])
      .then(([friendsResponse, challengesResponse]) => {
        setFriends(friendsResponse);
        setChallenges(challengesResponse);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, []);

  useEffect(() => {
    if (auth.status === "ready") reload();
  }, [auth.status, reload]);

  const act = useCallback(
    (action: () => Promise<unknown>, doneNotice?: string) => {
      setNotice(null);
      action()
        .then(() => {
          if (doneNotice) setNotice(doneNotice);
          reload();
        })
        .catch((err) => setNotice(err instanceof Error ? err.message : "Action failed."));
    },
    [reload]
  );

  if (auth.status === "disabled" || auth.status === "offline") {
    return (
      <Shell>
        <p className="text-sm text-text-dim">
          Friends and challenges need the account service, which is not reachable in
          local-only mode.
        </p>
      </Shell>
    );
  }
  if (auth.status !== "ready" || !friends || !challenges) {
    return (
      <Shell>
        <p className="text-sm text-text-faint">{error ?? "Loading…"}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      {notice && <p className="mb-4 text-sm text-text-dim">{notice}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-edge p-5">
          <h2 className="mb-3 text-base font-semibold text-paper">Friends</h2>
          <AddFriendForm onSubmit={(handle) => act(() => friendsApi.request(handle), "Request sent.")} />

          {friends.incoming.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">
                Incoming requests
              </p>
              {friends.incoming.map((request) => (
                <Row key={request.requestId} user={request.from}>
                  <SmallButton onClick={() => act(() => friendsApi.respond(request.requestId, true))}>
                    accept
                  </SmallButton>
                  <SmallButton onClick={() => act(() => friendsApi.respond(request.requestId, false))}>
                    decline
                  </SmallButton>
                </Row>
              ))}
            </div>
          )}
          {friends.outgoing.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Sent</p>
              {friends.outgoing.map((request) => (
                <Row key={request.requestId} user={request.to}>
                  <span className="text-xs text-text-faint">pending</span>
                  <SmallButton onClick={() => act(() => friendsApi.remove(request.to.id))}>
                    retract
                  </SmallButton>
                </Row>
              ))}
            </div>
          )}

          <div className="mt-4">
            <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">
              Friends ({friends.friends.length})
            </p>
            {friends.friends.length === 0 && (
              <p className="text-sm text-text-faint">No friends yet — add one by handle.</p>
            )}
            {friends.friends.map((friend) => (
              <Row key={friend.id} user={friend}>
                <ChallengeButton
                  toHandle={friend.handle}
                  onDone={(challenge) =>
                    act(
                      async () => challenge,
                      `Challenge sent to ${friend.handle}.`
                    )
                  }
                />
                <SmallButton onClick={() => act(() => friendsApi.remove(friend.id))}>
                  unfriend
                </SmallButton>
                <SmallButton
                  danger
                  onClick={() => act(() => friendsApi.block(friend.handle), "Blocked.")}
                >
                  block
                </SmallButton>
              </Row>
            ))}
          </div>

          <div className="mt-4 border-t border-edge pt-3">
            <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">
              Blocked ({friends.blocked.length})
            </p>
            <p className="mb-2 text-xs text-text-faint">
              Blocked players cannot challenge you, get paired with you, or send
              friend requests — in either direction.
            </p>
            <BlockForm onSubmit={(handle) => act(() => friendsApi.block(handle), "Blocked.")} />
            {friends.blocked.map((blocked) => (
              <Row key={blocked.id} user={blocked}>
                <SmallButton onClick={() => act(() => friendsApi.unblock(blocked.id))}>
                  unblock
                </SmallButton>
              </Row>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-edge p-5">
          <h2 className="mb-3 text-base font-semibold text-paper">Challenges</h2>
          <OpenChallengeForm
            onCreated={(challenge) => {
              setNotice(null);
              setChallenges((current) =>
                current ? { ...current, outgoing: [challenge, ...current.outgoing] } : current
              );
            }}
          />

          <div className="mt-4">
            <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Incoming</p>
            {challenges.incoming.length === 0 && (
              <p className="text-sm text-text-faint">No open challenges.</p>
            )}
            {challenges.incoming.map((challenge) => (
              <ChallengeRow key={challenge.id} challenge={challenge}>
                <SmallButton
                  onClick={() =>
                    act(
                      () => challengesApi.accept({ id: challenge.id }),
                      "Challenge accepted — live play arrives with Phase 4 multiplayer."
                    )
                  }
                >
                  accept
                </SmallButton>
                <SmallButton onClick={() => act(() => challengesApi.decline(challenge.id))}>
                  decline
                </SmallButton>
              </ChallengeRow>
            ))}
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Outgoing</p>
            {challenges.outgoing.length === 0 && (
              <p className="text-sm text-text-faint">None open.</p>
            )}
            {challenges.outgoing.map((challenge) => (
              <ChallengeRow key={challenge.id} challenge={challenge}>
                {challenge.token && (
                  <SmallButton
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`${location.origin}/challenge/${challenge.token}`)
                        .then(() => setNotice("Challenge link copied."));
                    }}
                  >
                    copy link
                  </SmallButton>
                )}
                <SmallButton onClick={() => act(() => challengesApi.cancel(challenge.id))}>
                  cancel
                </SmallButton>
              </ChallengeRow>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-5 text-xl font-semibold text-paper">Friends &amp; challenges</h1>
      {children}
    </div>
  );
}

function Row({ user, children }: { user: PublicUserPayload; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge py-1.5 last:border-0">
      <span className="text-sm text-text">
        {user.title && <span className="notation mr-1 text-brilliant">{user.title}</span>}
        <span className="notation">{user.handle}</span>
        {user.displayName && <span className="ml-2 text-text-faint">{user.displayName}</span>}
      </span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded border border-edge px-2 py-0.5 text-xs hover:border-edge-strong ${
        danger ? "text-text-faint hover:text-warn-2" : "text-text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function AddFriendForm({ onSubmit }: { onSubmit: (handle: string) => void }) {
  const [handle, setHandle] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (handle.trim()) onSubmit(handle.trim());
        setHandle("");
      }}
    >
      <input
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        placeholder="add by handle…"
        className="notation flex-1 rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text placeholder:text-text-faint"
        aria-label="Friend's handle"
      />
      <button className="rounded bg-lcd px-3 py-1.5 text-sm font-medium text-field hover:opacity-90">
        Add
      </button>
    </form>
  );
}

function BlockForm({ onSubmit }: { onSubmit: (handle: string) => void }) {
  const [handle, setHandle] = useState("");
  return (
    <form
      className="mb-2 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (handle.trim()) onSubmit(handle.trim());
        setHandle("");
      }}
    >
      <input
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        placeholder="block by handle…"
        className="notation flex-1 rounded border border-edge bg-transparent px-2 py-1 text-xs text-text placeholder:text-text-faint"
        aria-label="Handle to block"
      />
      <button className="rounded border border-edge px-2 py-1 text-xs text-text-dim hover:border-edge-strong">
        Block
      </button>
    </form>
  );
}

const TIME_CONTROLS = ["180+2", "300+3", "600+5", "900+10"] as const;

function ChallengeButton({
  toHandle,
  onDone,
}: {
  toHandle: string;
  onDone: (challenge: ChallengeViewPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <SmallButton onClick={() => setOpen(true)}>challenge</SmallButton>;
  }
  return (
    <span className="flex items-center gap-1">
      {TIME_CONTROLS.map((timeControl) => (
        <button
          key={timeControl}
          className="notation rounded border border-edge px-1.5 py-0.5 text-xs text-text-dim hover:border-edge-strong hover:text-text"
          onClick={() => {
            challengesApi
              .create({ toHandle, variant: "standard", timeControl, rated: false, color: "random" })
              .then((response) => {
                setOpen(false);
                onDone(response.challenge);
              })
              .catch(() => setOpen(false));
          }}
        >
          {timeControl}
        </button>
      ))}
      <SmallButton onClick={() => setOpen(false)}>×</SmallButton>
    </span>
  );
}

function OpenChallengeForm({
  onCreated,
}: {
  onCreated: (challenge: ChallengeViewPayload) => void;
}) {
  const [variant, setVariant] = useState<"standard" | "chess960">("standard");
  const [timeControl, setTimeControl] = useState<string>("300+3");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setError(null);
    challengesApi
      .create({ variant, timeControl, rated: false, color: "random" })
      .then((response) => {
        onCreated(response.challenge);
        setLink(`${location.origin}/challenge/${response.challenge.token}`);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed."));
  };

  return (
    <div className="rounded-lg border border-edge p-3">
      <p className="mb-2 text-xs text-text-faint">
        Create an open challenge link — anyone who opens it can accept.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={variant}
          onChange={(event) => setVariant(event.target.value as "standard" | "chess960")}
          className="rounded border border-edge bg-field px-2 py-1 text-sm text-text"
          aria-label="Variant"
        >
          <option value="standard">Standard</option>
          <option value="chess960">Chess960</option>
        </select>
        <select
          value={timeControl}
          onChange={(event) => setTimeControl(event.target.value)}
          className="notation rounded border border-edge bg-field px-2 py-1 text-sm text-text"
          aria-label="Time control"
        >
          {TIME_CONTROLS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button
          onClick={create}
          className="rounded bg-lcd px-3 py-1 text-sm font-medium text-field hover:opacity-90"
        >
          Create link
        </button>
      </div>
      {link && (
        <p className="notation mt-2 break-all text-xs text-text-dim">
          {link}{" "}
          <button
            className="text-brilliant hover:underline"
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            copy
          </button>
        </p>
      )}
      {error && <p className="mt-2 text-xs text-warn-2">{error}</p>}
    </div>
  );
}

function ChallengeRow({
  challenge,
  children,
}: {
  challenge: ChallengeViewPayload;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge py-1.5 last:border-0">
      <span className="text-sm text-text-dim">
        <span className="notation">{challenge.from.handle}</span>
        <span className="notation ml-2 text-text">{challenge.timeControl}</span>
        <span className="ml-2 text-xs text-text-faint">
          {challenge.variant === "chess960" ? "960" : ""}
          {challenge.rated ? " rated" : " casual"}
          {challenge.token ? " · open link" : ""}
        </span>
      </span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
}
