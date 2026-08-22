-- Data repair: the original puzzle seed script JSON.stringify'd the themes
-- and moves_uci arrays before handing them to postgres-js, so every row
-- stored a jsonb STRING SCALAR containing JSON text instead of a jsonb
-- array. Drizzle's read path accidentally recovered the arrays (it
-- JSON.parses string-typed jsonb driver values), which is why puzzles
-- worked — but SQL-level operators saw the scalar, so the `themes ?|`
-- theme filter in nextPuzzle() has never matched a single row.
-- Re-cast the embedded JSON text back to real jsonb arrays.
UPDATE puzzles
SET themes = (themes #>> '{}')::jsonb
WHERE jsonb_typeof(themes) = 'string';
--> statement-breakpoint
UPDATE puzzles
SET moves_uci = (moves_uci #>> '{}')::jsonb
WHERE jsonb_typeof(moves_uci) = 'string';
