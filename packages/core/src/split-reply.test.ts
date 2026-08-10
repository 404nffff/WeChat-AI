import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { humanDelayMs, splitReplyIntoBubbles } from "./split-reply.js";

describe("splitReplyIntoBubbles", () => {
  it("keeps short text as one bubble", () => {
    assert.deepEqual(splitReplyIntoBubbles("你好呀～"), ["你好呀～"]);
  });

  it("splits by sentences", () => {
    const parts = splitReplyIntoBubbles(
      "今天天气真好呢！我们去散步吧？记得带伞哦。",
      { maxChunkChars: 20, maxChunks: 5, minChunkChars: 4 },
    );
    assert.ok(parts.length >= 2);
    assert.equal(parts.join(""), "今天天气真好呢！我们去散步吧？记得带伞哦。");
  });

  it("splits paragraphs", () => {
    const parts = splitReplyIntoBubbles("第一段内容比较长一点的。\n\n第二段也要单独发。", {
      maxChunkChars: 40,
    });
    assert.ok(parts.length >= 2);
  });

  it("splits on a single newline even when the whole string is short", () => {
    // Models often stuff multi-bubble intent into one string with `\n`.
    // That used to ship as one WeChat bubble; must become three.
    const parts = splitReplyIntoBubbles("在呢\n刚改完排版眼睛有点花\n你说", {
      maxChunkChars: 80,
      maxChunks: 5,
      minChunkChars: 2,
    });
    assert.deepEqual(parts, ["在呢", "刚改完排版眼睛有点花", "你说"]);
  });

  it("caps max chunks", () => {
    const long = Array.from({ length: 10 }, (_, i) => `句子${i}号。`).join("");
    const parts = splitReplyIntoBubbles(long, {
      maxChunks: 3,
      maxChunkChars: 8,
      minChunkChars: 2,
    });
    assert.ok(parts.length <= 3);
  });
});

describe("humanDelayMs", () => {
  it("returns positive delays", () => {
    assert.ok(humanDelayMs("你好", 0) >= 900);
    const d = humanDelayMs("这是一条稍微长一点的消息内容用来测延迟", 1);
    assert.ok(d >= 1000 && d <= 6000);
  });
});
