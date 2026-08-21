"use client";

import type { CSSProperties, ReactElement } from "react";
import type { PieceSetId } from "@/lib/prefs/prefs";

/**
 * Piece rendering for react-chessboard (customPieces) and figurine notation
 * (B2.3: the move list drawn in the user's own piece set). 'classic' is the
 * board library's built-in set; SVG sets come from /public/pieces/<set>/
 * with manifest entries (B2.5).
 */

const PIECE_CODES = [
  "wK",
  "wQ",
  "wR",
  "wB",
  "wN",
  "wP",
  "bK",
  "bQ",
  "bR",
  "bB",
  "bN",
  "bP",
] as const;
type PieceCode = (typeof PIECE_CODES)[number];

type PieceRenderer = (props: { squareWidth: number }) => ReactElement;

export function customPiecesFor(setId: PieceSetId): Record<PieceCode, PieceRenderer> | undefined {
  if (setId === "classic") return undefined;
  return Object.fromEntries(
    PIECE_CODES.map((code) => [
      code,
      ({ squareWidth }: { squareWidth: number }) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/pieces/${setId}/${code}.svg`}
          width={squareWidth}
          height={squareWidth}
          alt=""
          draggable={false}
          style={{ pointerEvents: "none" }}
        />
      ),
    ])
  ) as Record<PieceCode, PieceRenderer>;
}

const SAN_PIECE_LETTERS = new Set(["K", "Q", "R", "B", "N"]);

/**
 * SAN with the leading piece letter replaced by the mover's piece glyph from
 * the active set ("figurine" mode). Falls back to plain SAN for the classic
 * (bundled) set, which has no standalone SVG files.
 */
export function FigurineSan({
  san,
  color,
  setId,
  style,
}: {
  san: string;
  color: "w" | "b";
  setId: PieceSetId;
  style?: CSSProperties;
}) {
  const letter = san.charAt(0);
  if (setId === "classic" || !SAN_PIECE_LETTERS.has(letter)) {
    return <span style={style}>{san}</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1, ...style }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/pieces/${setId}/${color}${letter}.svg`}
        alt={letter}
        style={{ width: "1.15em", height: "1.15em", verticalAlign: "-0.2em" }}
        draggable={false}
      />
      {san.slice(1)}
    </span>
  );
}
