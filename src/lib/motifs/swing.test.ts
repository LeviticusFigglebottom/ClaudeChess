import { describe, expect, it } from "vitest";
import fixturesJson from "./fixtures.json";
import { classifySwing } from "./swing";

/**
 * §9.2 UNCLEAR subdivision: the swing classifier over stored records.
 * Pinned to existing C4 fixtures — one of each kind — so the classifier
 * and the detector suite can never drift apart silently.
 */

interface Fixture {
  id: string;
  input: {
    fenBefore: string;
    fenAfter: string;
    movedUci: string;
    refutationPv: string[];
  };
}

const fixtures = fixturesJson as unknown as Fixture[];
const byId = (id: string) => {
  const fixture = fixtures.find((f) => f.id === id);
  if (!fixture) throw new Error(`fixture ${id} missing`);
  return fixture.input;
};

describe("classifySwing", () => {
  it("a mating refutation is 'mate'", () => {
    expect(classifySwing(byId("back_rank-1"))).toBe("mate");
  });

  it("a refutation winning a piece is 'material'", () => {
    expect(classifySwing(byId("hanging_piece-1"))).toBe("material");
  });

  it("a structural fixture's quiet refutation is 'quiet'", () => {
    expect(classifySwing(byId("hole_created-1"))).toBe("quiet");
  });

  it("an initiated even trade does not count as a material swing", () => {
    // bishop_pair fixture: BxN answered by a recapture — net zero.
    expect(classifySwing(byId("bishop_pair_surrendered-1"))).toBe("quiet");
  });
});
