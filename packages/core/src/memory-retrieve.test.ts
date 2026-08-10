import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryRow } from "@wechat-ai/db";
import {
  extractTerms,
  normalizeFactList,
  selectMemoriesForPrompt,
} from "./memory-retrieve.js";

function mem(content: string, id = content): MemoryRow {
  return {
    id,
    bot_account_id: "b",
    peer_id: "p",
    persona_id: "per",
    kind: "fact",
    content,
  };
}

describe("memory-retrieve", () => {
  it("extractTerms finds CJK bigrams and latin words", () => {
    const t = extractTerms("用户叫小明 likes coffee");
    assert.ok(t.includes("coffee"));
    assert.ok(t.some((x) => x.includes("小明") || x === "小明"));
  });

  it("selectMemoriesForPrompt injects all when under fullInjectMax", () => {
    const list = [mem("A"), mem("B"), mem("C")];
    const out = selectMemoriesForPrompt(list, "无关", {
      topK: 2,
      fullInjectMax: 20,
    });
    assert.equal(out.length, 3);
  });

  it("selectMemoriesForPrompt picks relevant top-K when over fullInjectMax", () => {
    const list = Array.from({ length: 25 }, (_, i) =>
      mem(`无关事实编号${i}`, `id${i}`),
    );
    list.push(mem("用户的名字是小明", "name"));
    list.push(mem("用户喜欢草莓", "fruit"));
    const out = selectMemoriesForPrompt(list, "我叫什么名字？小明", {
      topK: 5,
      fullInjectMax: 10,
    });
    assert.ok(out.length <= 5);
    assert.ok(out.some((m) => m.content.includes("小明")));
  });

  it("normalizeFactList dedupes and drops substrings", () => {
    const out = normalizeFactList(
      ["用户喜欢咖啡", "用户喜欢咖啡", "喜欢咖啡", "用户叫小红", "  "],
      100,
    );
    assert.ok(out.some((f) => f.includes("喜欢咖啡")));
    assert.equal(out.filter((f) => f.includes("咖啡")).length, 1);
    assert.ok(out.some((f) => f.includes("小红")));
  });

  it("normalizeFactList respects maxItems", () => {
    const facts = Array.from({ length: 30 }, (_, i) => `事实${i}`);
    const out = normalizeFactList(facts, 10);
    assert.equal(out.length, 10);
  });
});
