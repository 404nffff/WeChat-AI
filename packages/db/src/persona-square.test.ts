import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generatePersonaSlug,
  personaHeatScore,
} from "./repos.js";

describe("generatePersonaSlug", () => {
  it("produces unique-ish slugs", () => {
    const a = generatePersonaSlug("user123", "腹黑学姐");
    const b = generatePersonaSlug("user123", "腹黑学姐");
    assert.match(a, /^p-/);
    assert.notEqual(a, b);
  });
});

describe("personaHeatScore", () => {
  it("weights use / assign / fork", () => {
    assert.equal(personaHeatScore({}), 0);
    assert.equal(
      personaHeatScore({ use_count: 1, assign_count: 1, fork_count: 1 }),
      2 + 5 + 3,
    );
    assert.equal(personaHeatScore({ use_count: 3 }), 6);
  });
});
