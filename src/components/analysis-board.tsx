"use client";

import type { PieceSetId } from "@/lib/prefs/prefs";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GamePosition } from "@/lib/chess";
import { GameTree, type TreeNode } from "@/lib/chess/tree";
import { isValidFen } from "@/lib/chess/position";
import { openingForEpd } from "@/lib/chess/openings";
import type { VariantId } from "@/lib/chess/variant";
import { classifyMove, type Classification, type WhitePovEval } from "@/lib/eval";
import { ClassificationIcon } from "./classification-icon";
import { ExplorerPanel } from "./explorer-panel";
import { FigurineSan } from "./pieces";
import { GameBoard } from "./game-board";
import { usePrefs } from "./prefs-context";
import { useAuth } from "./auth-context";
import { useEngineAnalysis } from "./use-engine-analysis";

/**
 * Analysis board (A3.1) on the variation tree (A3.2): both sides playable,
 * branching lines with promote/delete/comment, streaming review-depth
 * engine analysis of the current node, FEN/PGN import (Lichess literate
 * PGNs load their suggested lines as variations), and studies saved to the
 * account (RAV PGN — never plies rows, so variations never feed §9 stats).
 */

function formatEval(evaluation: WhitePovEval, format: "cp" | "wp" | "both", wpWhite: number): string {
  const cpText =
    evaluation.mateIn !== null
      ? evaluation.mateIn > 0
        ? `+M${evaluation.mateIn}`
        : `-M${-evaluation.mateIn}`
      : `${(evaluation.cp ?? 0) >= 0 ? "+" : ""}${((evaluation.cp ?? 0) / 100).toFixed(2)}`;
  const wpText = `${wpWhite.toFixed(0)}%`;
  if (format === "cp") return cpText;
  if (format === "wp") return wpText;
  return `${cpText} · ${wpText}`;
}

interface PendingBadge {
  nodeId: number;
  playedUci: string;
  moverColor: "w" | "b";
  legalMoveCount: number;
  epdAfter: string;
  baseline: { bestUci: string; wpWhiteBefore: number } | null;
}

export function AnalysisBoard({ initialGameId }: { initialGameId?: string }) {
  const { prefs } = usePrefs();
  const auth = useAuth();
  const treeRef = useRef<GameTree>(new GameTree());
  const [version, setVersion] = useState(0); // bump to re-render tree edits
  const [currentId, setCurrentId] = useState(0);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [badges, setBadges] = useState<Map<number, Classification | null>>(new Map());
  const [sanInput, setSanInput] = useState("");
  const [loadInput, setLoadInput] = useState("");
  const [studyId, setStudyId] = useState<string | null>(null);
  const [studyName, setStudyName] = useState("");
  const [studies, setStudies] = useState<{ id: string; name: string; variant: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<PendingBadge | null>(null);

  const tree = treeRef.current;
  const engine = useEngineAnalysis(tree.variant);
  const currentNode = tree.node(currentId) ?? tree.root;
  const fen = currentNode.fenAfter;
  const position = useMemo(() => GamePosition.fromFen(fen, tree.variant), [fen, tree.variant]);

  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const { status: engineStatus, analyze, stop } = engine;
  const gameOver = position.isCheckmate()
    ? `Checkmate — ${position.turn === "w" ? "Black" : "White"} wins`
    : position.isStalemate()
      ? "Draw — stalemate"
      : null;

  useEffect(() => {
    if (engineStatus !== "ready") return;
    if (gameOver) stop();
    else analyze(fen);
  }, [engineStatus, fen, gameOver, analyze, stop]);

  // Live badge resolution (BOOK immediately; loss bands once depth ≥ 12).
  const resolvePending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    let classification: Classification | null = null;
    if (tree.variant === "standard" && openingForEpd(pending.epdAfter) !== null) {
      classification = "BOOK";
    } else {
      if (!pending.baseline) {
        pendingRef.current = null;
        return;
      }
      const top = engine.lines[0];
      if (engine.depth < 12 || !top) return;
      const mover = pending.moverColor;
      classification = classifyMove({
        variant: tree.variant,
        wpBefore: mover === "w" ? pending.baseline.wpWhiteBefore : 100 - pending.baseline.wpWhiteBefore,
        wpAfter: mover === "w" ? top.wpWhite : 100 - top.wpWhite,
        playedUci: pending.playedUci,
        bestUci: pending.baseline.bestUci,
        legalMoveCount: pending.legalMoveCount,
        isBook: false,
      });
    }
    const done = pending;
    pendingRef.current = null;
    setBadges((previous) => new Map(previous).set(done.nodeId, classification));
  }, [engine.depth, engine.lines, tree.variant]);

  useEffect(() => {
    resolvePending();
  }, [resolvePending]);

  const playMove = useCallback(
    (input: { from: string; to: string } | { san: string }): boolean => {
      const legalBefore = position.legalMoveCount();
      const top = engine.lines[0];
      const node = tree.play(currentId, input);
      if (!node) return false;
      pendingRef.current = {
        nodeId: node.id,
        playedUci: node.uci,
        moverColor: node.color,
        legalMoveCount: legalBefore,
        epdAfter: node.fenAfter.split(" ").slice(0, 4).join(" "),
        baseline: top?.firstUci ? { bestUci: top.firstUci, wpWhiteBefore: top.wpWhite } : null,
      };
      setCurrentId(node.id);
      bump();
      resolvePending();
      return true;
    },
    [tree, currentId, position, engine.lines, bump, resolvePending]
  );

  // Keyboard navigation.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const node = tree.node(currentId);
        if (node && node.parentId !== null) setCurrentId(node.parentId);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const node = tree.node(currentId) ?? tree.root;
        if (node.children[0]) setCurrentId(node.children[0].id);
      } else if (event.key === "Home") {
        setCurrentId(0);
      } else if (event.key === "End") {
        const line = tree.mainline();
        if (line.length) setCurrentId(line.at(-1)!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tree, currentId]);

  const replaceTree = useCallback(
    (next: GameTree, keepStudy?: { id: string; name: string }) => {
      treeRef.current = next;
      pendingRef.current = null;
      setBadges(new Map());
      setCurrentId(next.mainline().at(-1)?.id ?? 0);
      setStudyId(keepStudy?.id ?? null);
      setStudyName(keepStudy?.name ?? "");
      bump();
    },
    [bump]
  );

  // Load a reviewed game into the board (?game=…).
  useEffect(() => {
    if (!initialGameId || auth.status !== "ready") return;
    fetch(`/api/games/${initialGameId}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          game?: { pgn: string; variant: string };
          error?: { message: string };
        };
        if (!response.ok || !body.game) throw new Error(body.error?.message ?? "load failed");
        const variant = (body.game.variant === "chess960" ? "chess960" : "standard") as VariantId;
        replaceTree(GameTree.fromPgn(body.game.pgn, variant));
        setNotice("Game loaded — Lichess annotations arrive as variations where present.");
      })
      .catch((error) =>
        setNotice(error instanceof Error ? error.message : "Could not load the game.")
      );
  }, [initialGameId, auth.status, replaceTree]);

  const loadStudies = useCallback(() => {
    fetch("/api/studies")
      .then(async (response) => (response.ok ? response.json() : { studies: [] }))
      .then((body: { studies?: { id: string; name: string; variant: string }[] }) =>
        setStudies(body.studies ?? [])
      )
      .catch(() => setStudies([]));
  }, []);

  useEffect(() => {
    if (auth.status === "ready") loadStudies();
  }, [auth.status, loadStudies]);

  const saveStudy = useCallback(async () => {
    const name = studyName.trim() || `Study ${new Date().toLocaleDateString()}`;
    try {
      const response = await fetch("/api/studies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: studyId ?? undefined,
          name,
          variant: tree.variant,
          pgn: tree.toPgn({ Event: `GAMBIT study: ${name}` }),
        }),
      });
      const body = (await response.json()) as { id?: string; error?: { message: string } };
      if (!response.ok || !body.id) throw new Error(body.error?.message ?? "save failed");
      setStudyId(body.id);
      setStudyName(name);
      setNotice(`Saved “${name}”.`);
      loadStudies();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  }, [studyId, studyName, tree, loadStudies]);

  const openStudy = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/games/${id}`);
        const body = (await response.json()) as {
          game?: { pgn: string; variant: string; whiteName?: string };
          error?: { message: string };
        };
        if (!response.ok || !body.game) throw new Error(body.error?.message ?? "load failed");
        const variant = (body.game.variant === "chess960" ? "chess960" : "standard") as VariantId;
        replaceTree(GameTree.fromPgn(body.game.pgn, variant), {
          id,
          name: body.game.whiteName ?? "Study",
        });
        setNotice(null);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not open the study.");
      }
    },
    [replaceTree]
  );

  const loadFenOrPgn = useCallback(() => {
    const text = loadInput.trim();
    if (!text) return;
    try {
      if (text.includes("\n") || text.includes("1.") || text.startsWith("[")) {
        replaceTree(GameTree.fromPgn(text));
      } else if (isValidFen(text, "standard")) {
        replaceTree(new GameTree(text, "standard"));
      } else if (isValidFen(text, "chess960")) {
        replaceTree(new GameTree(text, "chess960"));
      } else {
        throw new Error("Neither a valid FEN nor a parseable PGN.");
      }
      setLoadInput("");
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load that.");
    }
  }, [loadInput, replaceTree]);

  const topLine = engine.lines[0];
  const whiteBarPct = topLine ? topLine.wpWhite : 50;
  void version;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex w-full max-w-[640px] items-stretch gap-2">
        {prefs.evalBar.show && (
          <div
            className="w-4 shrink-0 overflow-hidden rounded-sm border border-edge"
            title={topLine ? `White win probability ${topLine.wpWhite.toFixed(1)}%` : "eval bar"}
          >
            <div className="flex h-full flex-col">
              <div
                className="w-full bg-black-adv"
                style={{
                  height: `${orientation === "white" ? 100 - whiteBarPct : whiteBarPct}%`,
                  transition: "height var(--motion-eval) ease-out",
                }}
              />
              <div className="w-full flex-1 bg-white-adv" />
            </div>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <GameBoard
            boardId="analysis"
            fen={fen}
            orientation={orientation}
            lastMove={
              currentNode.id !== 0
                ? { from: currentNode.uci.slice(0, 2), to: currentNode.uci.slice(2, 4) }
                : null
            }
            interactive
            onMove={(from, to) => playMove({ from, to })}
            destsFrom={(square) => position.destsFrom(square)}
            canSelect={(square) => {
              const piece = position.pieceAt(square);
              return Boolean(piece && piece.color === position.turn);
            }}
          />
          {gameOver && (
            <div className="mt-3 rounded-lg border border-edge-strong bg-raise px-4 py-2 text-center font-medium text-text">
              {gameOver}
            </div>
          )}
        </div>
      </div>

      <div className="flex w-full flex-col gap-4 lg:w-96">
        <div className="flex flex-wrap gap-2">
          <SmallButton onClick={() => replaceTree(new GameTree())}>Reset</SmallButton>
          <SmallButton onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}>
            Flip
          </SmallButton>
          {currentNode.id !== 0 && (
            <>
              <SmallButton
                onClick={() => {
                  tree.promote(currentNode.id);
                  bump();
                }}
              >
                Promote line
              </SmallButton>
              <SmallButton
                onClick={() => {
                  const parent = currentNode.parentId ?? 0;
                  tree.deleteFrom(currentNode.id);
                  setCurrentId(parent);
                  bump();
                }}
              >
                Delete from here
              </SmallButton>
            </>
          )}
        </div>

        <div className="rounded-xl border border-edge bg-surface-2 p-3">
          <div className="mb-2 flex items-baseline justify-between text-xs text-text-faint">
            <span>
              {engine.status === "booting" && "Engine booting…"}
              {engine.status === "error" && "Engine failed to load"}
              {engine.status === "ready" &&
                `${engine.meta?.name ?? "Stockfish"} · ${engine.meta?.threads} thread${(engine.meta?.threads ?? 1) > 1 ? "s" : ""}${tree.variant === "chess960" ? " · 960" : ""}`}
            </span>
            {engine.status === "ready" && engine.depth > 0 && (
              <span className="notation">
                d{engine.depth} · {(engine.nps / 1_000_000).toFixed(1)}Mn/s
              </span>
            )}
          </div>
          {gameOver ? (
            <p className="text-sm text-text-dim">Game over.</p>
          ) : (
            <ul className="space-y-1.5">
              {engine.lines.map((line) => (
                <li key={line.multipv} className="flex gap-2 text-sm">
                  <span className="notation w-20 shrink-0 font-medium text-lcd">
                    {formatEval(line.evaluation, prefs.evalBar.format, line.wpWhite)}
                  </span>
                  <button
                    className="truncate text-left text-text-dim hover:text-text"
                    title={line.pvSan.join(" ")}
                    onClick={() => line.firstUci && playMove({ san: line.pvSan[0] ?? "" })}
                  >
                    {line.pvSan.slice(0, 8).join(" ")}
                  </button>
                </li>
              ))}
              {engine.status === "ready" && engine.lines.length === 0 && (
                <li className="text-sm text-text-faint">analyzing…</li>
              )}
            </ul>
          )}
        </div>

        <div data-testid="move-tree" className="max-h-80 overflow-y-auto rounded-lg border border-edge p-3 text-sm">
          {tree.root.children.length === 0 ? (
            <p className="text-text-faint">
              Make a move — a second move from the same position starts a variation.
            </p>
          ) : (
            <VariationLine
              nodes={tree.root.children}
              currentId={currentId}
              onSelect={setCurrentId}
              badges={badges}
              figurine={prefs.moveList === "figurine"}
              pieceSet={prefs.pieceSet}
              depth={0}
            />
          )}
        </div>

        <ExplorerPanel
          fen={fen}
          variant={tree.variant}
          onPlayMove={(san) => playMove({ san })}
        />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (playMove({ san: sanInput.trim() })) setSanInput("");
          }}
          className="flex gap-2"
        >
          <input
            value={sanInput}
            onChange={(event) => setSanInput(event.target.value)}
            placeholder="Type a move (SAN — e4, Nf3, O-O)"
            aria-label="Keyboard move entry"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-transparent px-3 py-1.5 text-sm placeholder:text-text-faint"
          />
          <button className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong">
            Play
          </button>
        </form>

        <details className="rounded-lg border border-edge px-3 py-2">
          <summary className="cursor-pointer select-none text-sm text-text-dim hover:text-text">
            Load position / PGN · studies
          </summary>
          <div className="mt-2">
            <textarea
              value={loadInput}
              onChange={(event) => setLoadInput(event.target.value)}
              placeholder="Paste a FEN or a PGN (variations supported)…"
              rows={3}
              className="w-full rounded border border-edge bg-transparent px-2 py-1.5 text-xs text-text placeholder:text-text-faint"
            />
            <div className="mt-1.5 flex gap-2">
              <SmallButton onClick={loadFenOrPgn}>Load</SmallButton>
            </div>
            {auth.status === "ready" && (
              <div className="mt-3 border-t border-edge pt-2">
                <div className="flex gap-2">
                  <input
                    value={studyName}
                    onChange={(event) => setStudyName(event.target.value)}
                    placeholder="study name…"
                    className="min-w-0 flex-1 rounded border border-edge bg-transparent px-2 py-1 text-xs text-text placeholder:text-text-faint"
                    aria-label="Study name"
                  />
                  <SmallButton onClick={() => void saveStudy()}>
                    {studyId ? "Save" : "Save as study"}
                  </SmallButton>
                </div>
                {studies.length > 0 && (
                  <ul className="mt-2 max-h-28 overflow-y-auto">
                    {studies.map((study) => (
                      <li key={study.id} className="flex items-center justify-between py-0.5">
                        <button
                          onClick={() => void openStudy(study.id)}
                          className="truncate text-xs text-text-dim hover:text-text"
                        >
                          {study.name}
                          {study.variant === "chess960" && (
                            <span className="notation ml-1 text-text-faint">960</span>
                          )}
                        </button>
                        <button
                          onClick={() => {
                            void fetch("/api/studies", {
                              method: "DELETE",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: study.id }),
                            }).then(() => loadStudies());
                          }}
                          className="text-xs text-text-faint hover:text-warn-2"
                          aria-label={`Delete study ${study.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </details>
        {notice && <p className="text-xs text-text-faint">{notice}</p>}
      </div>
    </div>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
    >
      {children}
    </button>
  );
}

/** Recursive variation renderer: mainline flows inline; variations indent. */
function VariationLine({
  nodes,
  currentId,
  onSelect,
  badges,
  figurine,
  pieceSet,
  depth,
}: {
  nodes: TreeNode[];
  currentId: number;
  onSelect: (id: number) => void;
  badges: Map<number, Classification | null>;
  figurine: boolean;
  pieceSet: PieceSetId;
  depth: number;
}) {
  const elements: React.ReactNode[] = [];
  let chain: TreeNode[] | undefined = nodes;
  while (chain && chain.length > 0) {
    const main: TreeNode = chain[0]!;
    elements.push(
      <MoveButton
        key={main.id}
        node={main}
        active={main.id === currentId}
        onSelect={onSelect}
        badge={badges.get(main.id) ?? null}
        figurine={figurine}
        pieceSet={pieceSet}
        showNumber={main.color === "w" || elements.length === 0}
      />
    );
    if (main.comment) {
      elements.push(
        <span key={`c${main.id}`} className="text-xs italic text-text-faint">
          {main.comment}{" "}
        </span>
      );
    }
    for (const variation of chain.slice(1)) {
      elements.push(
        <span
          key={`v${variation.id}`}
          className={`my-0.5 block border-l border-edge pl-3 ${depth > 2 ? "" : ""}`}
        >
          <VariationLine
            nodes={[variation]}
            currentId={currentId}
            onSelect={onSelect}
            badges={badges}
            figurine={figurine}
            pieceSet={pieceSet}
            depth={depth + 1}
          />
        </span>
      );
    }
    chain = main.children;
  }
  return <span className={depth === 0 ? "leading-7" : "leading-6"}>{elements}</span>;
}

function MoveButton({
  node,
  active,
  onSelect,
  badge,
  figurine,
  pieceSet,
  showNumber,
}: {
  node: TreeNode;
  active: boolean;
  onSelect: (id: number) => void;
  badge: Classification | null;
  figurine: boolean;
  pieceSet: PieceSetId;
  showNumber: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(node.id)}
      className={`mr-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 align-baseline ${
        active ? "bg-raise text-text" : "text-text-dim hover:bg-raise hover:text-text"
      }`}
    >
      {showNumber && (
        <span className="notation text-xs text-text-faint">
          {node.moveNumber}
          {node.color === "w" ? "." : "…"}
        </span>
      )}
      <span className="notation">
        {figurine ? <FigurineSan san={node.san} color={node.color} setId={pieceSet} /> : node.san}
      </span>
      {badge && <ClassificationIcon classification={badge} className="text-xs" />}
    </button>
  );
}
