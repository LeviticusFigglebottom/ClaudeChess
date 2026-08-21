/**
 * Post-generate migration fixer (B0.8). drizzle-kit's codegen has two known
 * defects that produce invalid SQL; hand-editing survives only until the next
 * generate, so this runs automatically after every `npm run db:generate`
 * (and is idempotent). A test asserts the repaired patterns never ship.
 *
 * Defect 1: custom types in ALTER statements are emitted schema-qualified as
 *   `"undefined"."citext"` → rewritten to `citext`.
 * Defect 2: an ADD CONSTRAINT ... PRIMARY KEY can be emitted BEFORE the
 *   ADD COLUMN statements for columns it references (seen in 0004) → the
 *   constraint statement is moved after the last ADD COLUMN for that table
 *   in the same file.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SEPARATOR = "--> statement-breakpoint";
const migrationsDir = path.resolve("src/db/migrations");

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
let touched = 0;

for (const file of files) {
  const filePath = path.join(migrationsDir, file);
  const original = await readFile(filePath, "utf8");
  let statements = original.split(SEPARATOR).map((s) => s.replace(/^\n/, "").replace(/\n$/, ""));

  let changed = false;

  // Defect 1 — "undefined"."citext" (or any "undefined"-qualified type).
  statements = statements.map((statement) => {
    if (!statement.includes('"undefined".')) return statement;
    changed = true;
    console.log(`${file}: rewrote "undefined"-qualified type`);
    return statement.replace(/"undefined"\."(\w+)"/g, "$1");
  });

  // Defect 2 — PK constraint ordered before the columns it references.
  const addColumnRe = /^ALTER TABLE ("[^"]+") ADD COLUMN "([^"]+)"/;
  const pkRe = /^ALTER TABLE ("[^"]+") ADD CONSTRAINT "[^"]+" PRIMARY KEY\(([^)]*)\)/;
  for (let i = 0; i < statements.length; i++) {
    const pk = statements[i].trim().match(pkRe);
    if (!pk) continue;
    const table = pk[1];
    const pkColumns = [...pk[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    let lastAddColumnIndex = -1;
    for (let j = i + 1; j < statements.length; j++) {
      const add = statements[j].trim().match(addColumnRe);
      if (add && add[1] === table && pkColumns.includes(add[2])) lastAddColumnIndex = j;
    }
    if (lastAddColumnIndex === -1) continue;
    const [constraint] = statements.splice(i, 1);
    statements.splice(lastAddColumnIndex, 0, constraint); // lands right after the last needed ADD COLUMN
    changed = true;
    console.log(`${file}: moved PRIMARY KEY constraint for ${table} after its ADD COLUMNs`);
    i--; // re-scan the statement that shifted into position i
  }

  if (changed) {
    await writeFile(filePath, statements.join(`${SEPARATOR}\n`) + "\n");
    touched++;
  }
}

console.log(touched === 0 ? "migrations: nothing to fix" : `migrations: repaired ${touched} file(s)`);
