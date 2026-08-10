import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFactsJson } from "./prompt.js";

describe("parseFactsJson", () => {
  it("parses plain array", () => {
    assert.deepEqual(parseFactsJson('["a","b"]'), ["a", "b"]);
  });

  it("parses fenced noise", () => {
    assert.deepEqual(
      parseFactsJson('Here:\n```json\n["喜欢猫"]\n```'),
      ["喜欢猫"],
    );
  });
});
