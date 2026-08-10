import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TryChatError } from "./try-chat-service.js";

describe("TryChatError", () => {
  it("carries code", () => {
    const e = new TryChatError("quota_day", "今日已满");
    assert.equal(e.code, "quota_day");
    assert.equal(e.message, "今日已满");
    assert.equal(e.name, "TryChatError");
  });
});
