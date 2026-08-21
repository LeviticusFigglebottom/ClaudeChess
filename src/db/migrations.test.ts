import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for known drizzle-kit codegen defects (B0.8). The post-generate
 * fixer (scripts/fix-generated-migrations.mjs, wired into `npm run
 * db:generate`) repairs these; this test is the backstop that keeps invalid
 * SQL from ever shipping silently.
 */
const migrationsDir = path.resolve(__dirname, "migrations");
const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

describe("generated migrations are free of known codegen defects", () => {
  it("found migration files", () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('no migration contains an "undefined"-qualified type', () => {
    for (const file of sqlFiles) {
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      expect(sql.includes('"undefined".'), `${file} contains "undefined". qualification`).toBe(
        false
      );
    }
  });

  it("no PRIMARY KEY constraint precedes the ADD COLUMN of a column it references", () => {
    const addColumnRe = /^ALTER TABLE ("[^"]+") ADD COLUMN "([^"]+)"/;
    const pkRe = /^ALTER TABLE ("[^"]+") ADD CONSTRAINT "[^"]+" PRIMARY KEY\(([^)]*)\)/;
    for (const file of sqlFiles) {
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      const statements = sql.split("--> statement-breakpoint").map((s) => s.trim());
      for (let i = 0; i < statements.length; i++) {
        const pk = statements[i]?.match(pkRe);
        if (!pk) continue;
        const table = pk[1];
        const pkColumns = [...(pk[2] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        for (let j = i + 1; j < statements.length; j++) {
          const add = statements[j]?.match(addColumnRe);
          if (add && add[1] === table) {
            expect(
              pkColumns.includes(add[2] as string),
              `${file}: PK on ${table} references "${add[2]}" added later`
            ).toBe(false);
          }
        }
      }
    }
  });
});
