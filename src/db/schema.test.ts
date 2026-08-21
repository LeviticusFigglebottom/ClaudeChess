import { describe, expect, it } from "vitest";
import { VARIANTS } from "@/lib/chess/variant";
import { CLASSIFICATIONS } from "@/lib/eval/classify";
import { classificationEnum, variantEnum } from "./schema";

/**
 * The schema keeps enum literals inline (drizzle-kit runs schema.ts without
 * app import resolution), so these tests are what pin the DB enums to their
 * domain sources of truth.
 */
describe("schema enums mirror the domain constants", () => {
  it("variant enum matches VARIANTS (addendum A1.4)", () => {
    expect(variantEnum.enumValues).toEqual([...VARIANTS]);
  });

  it("classification enum matches CLASSIFICATIONS (spec §4.2)", () => {
    expect(classificationEnum.enumValues).toEqual([...CLASSIFICATIONS]);
  });
});
