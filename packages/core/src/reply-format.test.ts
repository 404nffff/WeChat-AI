import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasStickerTextToken,
  parseMultiBubbleReply,
  renderAssistantHistoryForModel,
  stripAllStickerJson,
} from "./reply-format.js";

describe("parseMultiBubbleReply", () => {
  it("parses {messages:[...]}", () => {
    const r = parseMultiBubbleReply(
      `{"messages":["你好呀～","今天过得怎么样？"]}`,
    );
    assert.equal(r.fromJson, true);
    assert.deepEqual(r.bubbles, ["你好呀～", "今天过得怎么样？"]);
    assert.equal(r.displayText, "你好呀～\n今天过得怎么样？");
    assert.equal(r.parts.length, 2);
    assert.equal(r.parts[0]?.kind, "text");
  });

  it("collapses consecutive identical text bubbles", () => {
    // Model sometimes emits the same string twice — shipping both is the
    // byte-identical double bubble the user screenshots as a streaming bug.
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          "嗯",
          "在呢\n刚改完一份排版眼睛有点花\n你说",
          "在呢\n刚改完一份排版眼睛有点花\n你说",
          "你说呗",
        ],
      }),
      // Keep the long middle string as one part so the collapse is visible.
      { maxBubbles: 5, expandLongBubbles: false, fallbackSplit: false },
    );
    assert.deepEqual(
      r.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text),
      [
        "嗯",
        "在呢\n刚改完一份排版眼睛有点花\n你说",
        "你说呗",
      ],
    );
  });

  it("splits a single long string on newlines into multiple bubbles", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: ["在呢\n刚改完排版眼睛快瞎了\n你说你的"],
      }),
      { maxBubbles: 5, maxChunkChars: 80, expandLongBubbles: true },
    );
    assert.ok(r.parts.length >= 2, JSON.stringify(r.parts));
    assert.ok(
      r.parts.every((p) => p.kind === "text" && !p.text.includes("\n")),
      JSON.stringify(r.parts),
    );
  });

  it("parses fenced json", () => {
    const r = parseMultiBubbleReply(
      "```json\n{\"bubbles\":[\"喵\",\"在的\"]}\n```",
    );
    assert.equal(r.fromJson, true);
    assert.deepEqual(r.bubbles, ["喵", "在的"]);
  });

  it("parses bare array", () => {
    const r = parseMultiBubbleReply(`["嗨","想你了"]`);
    assert.equal(r.fromJson, true);
    assert.deepEqual(r.bubbles, ["嗨", "想你了"]);
  });

  it("parses mixed text + sticker objects", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          "好呀～",
          { type: "sticker", slug: "Happy-Cat" },
          "下次见",
        ],
      }),
    );
    assert.equal(r.fromJson, true);
    assert.deepEqual(r.parts, [
      { kind: "text", text: "好呀～" },
      { kind: "sticker", slug: "happy-cat" },
      { kind: "text", text: "下次见" },
    ]);
    assert.equal(r.displayText, "好呀～\n[表情:happy-cat]\n下次见");
  });

  it("accepts shorthand {sticker:slug}", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({ messages: [{ sticker: "wave" }] }),
    );
    assert.equal(r.parts[0]?.kind, "sticker");
    if (r.parts[0]?.kind === "sticker") {
      assert.equal(r.parts[0].slug, "wave");
    }
  });

  it("extracts sticker JSON embedded inside a text string", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          '(/•/ω•/) {"type":"sticker","slug":"s-1001-sticker-v3mum2"} 好啦～给你看！',
        ],
      }),
    );
    assert.equal(r.fromJson, true);
    const kinds = r.parts.map((p) => p.kind);
    assert.ok(kinds.includes("sticker"), JSON.stringify(r.parts));
    assert.ok(kinds.includes("text"), JSON.stringify(r.parts));
    const st = r.parts.find((p) => p.kind === "sticker");
    assert.equal(st && st.kind === "sticker" ? st.slug : "", "s-1001-sticker-v3mum2");
    // User-facing bubbles must not still contain raw sticker JSON
    assert.ok(
      !r.displayText.includes('"type"'),
      r.displayText,
    );
  });

  it("never leaks sticker JSON to text even when multi-bubble has embedded form", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          "哎呀，这么喜欢我家的洗澡小猫咪呀？",
          "(๑˃̵ᴗ˂̵) 好好好～",
          "再给你看一遍！",
          "不过就这一次啦～",
          '{"type":"sticker","slug":"s-1001-sticker-v3mum2"} 嘿嘿，是不是超可爱？\n我可没骗你吧喵～',
        ],
      }),
      { maxBubbles: 5 },
    );
    assert.ok(
      r.parts.some((p) => p.kind === "sticker"),
      `expected sticker part: ${JSON.stringify(r.parts)}`,
    );
    for (const p of r.parts) {
      if (p.kind === "text") {
        assert.ok(
          !/"type"\s*:\s*"sticker"/i.test(p.text),
          `leaked JSON in text: ${p.text}`,
        );
        assert.ok(!p.text.includes("s-1001-sticker-v3mum2") || !p.text.includes("{"), p.text);
      }
    }
  });

  it("caps stickers per reply", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          { type: "sticker", slug: "a" },
          { type: "sticker", slug: "b" },
          { type: "sticker", slug: "c" },
        ],
      }),
      { maxStickers: 2, maxBubbles: 5 },
    );
    const stickers = r.parts.filter((p) => p.kind === "sticker");
    assert.equal(stickers.length, 2);
  });

  it("falls back to text split when not json", () => {
    const r = parseMultiBubbleReply("今天天气真好呢！我们去散步吧？", {
      maxBubbles: 5,
    });
    assert.equal(r.fromJson, false);
    assert.ok(r.bubbles.length >= 1);
  });

  it("caps max bubbles", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({ messages: ["1", "2", "3", "4", "5", "6"] }),
      { maxBubbles: 3 },
    );
    assert.equal(r.bubbles.length, 3);
  });

  it("re-splits when model stuffs whole reply into one messages element", () => {
    const essay =
      "今天天气真的很好呢！我们下午去公园散步怎么样？记得带上水杯哦～";
    const r = parseMultiBubbleReply(JSON.stringify({ messages: [essay] }), {
      maxBubbles: 5,
      maxChunkChars: 24,
      expandLongBubbles: true,
    });
    assert.equal(r.fromJson, true);
    assert.ok(
      r.bubbles.length >= 2,
      `expected >=2 bubbles, got ${r.bubbles.length}: ${JSON.stringify(r.bubbles)}`,
    );
    assert.ok(!r.bubbles.some((b) => b.includes('{"messages"')));
  });

  it("splits plain long prose without json", () => {
    const r = parseMultiBubbleReply(
      "第一句话在这里结束。第二句也不短一点。第三句继续说下去吧！",
      { maxBubbles: 5, maxChunkChars: 20 },
    );
    assert.ok(r.bubbles.length >= 2);
  });

  // The model reads its own history, where a sticker was rendered as
  // `[表情:slug]`, and imitates that notation as plain text. Until this was
  // parseable it shipped to WeChat verbatim.
  it("recovers a sticker from the [表情:slug] history token", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({
        messages: [
          "刚才不是给你发了一个嘛",
          "[表情:s-66707-sticker-tjgwdw]",
          "这个可爱吧?",
        ],
      }),
    );
    assert.deepEqual(r.parts, [
      { kind: "text", text: "刚才不是给你发了一个嘛" },
      { kind: "sticker", slug: "s-66707-sticker-tjgwdw" },
      { kind: "text", text: "这个可爱吧?" },
    ]);
  });

  it("splits a token inlined mid-sentence, and accepts full-width forms", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({ messages: ["给你看～［表情：Happy-Cat］喜欢吗"] }),
    );
    assert.deepEqual(r.parts, [
      { kind: "text", text: "给你看～" },
      { kind: "sticker", slug: "happy-cat" },
      { kind: "text", text: "喜欢吗" },
    ]);
  });

  it("strips a malformed token rather than sending it as text", () => {
    // Slug too long for the token grammar → cannot become a sticker part.
    const bad = `[表情:${"x".repeat(80)}]`;
    assert.equal(stripAllStickerJson(`看这个 ${bad} 呀`), "看这个 呀");
    const r = parseMultiBubbleReply(JSON.stringify({ messages: [bad] }));
    assert.deepEqual(r.parts, []);
  });

  it("leaves ordinary bracketed text alone", () => {
    const r = parseMultiBubbleReply(
      JSON.stringify({ messages: ["[公告] 明天见", "笑死[捂脸]"] }),
    );
    assert.deepEqual(r.bubbles, ["[公告] 明天见", "笑死[捂脸]"]);
  });
});

describe("renderAssistantHistoryForModel", () => {
  it("replays stored stickers in the format the model is told to emit", () => {
    assert.equal(
      renderAssistantHistoryForModel("唔 给你看个好看的\n[表情:S-66707-Sticker-Tjgwdw]"),
      '唔 给你看个好看的\n{"type":"sticker","slug":"s-66707-sticker-tjgwdw"}',
    );
  });

  it("round-trips: rewritten history parses back to the same sticker", () => {
    const stored = "好呀～\n[表情:happy-cat]\n下次见";
    const replayed = renderAssistantHistoryForModel(stored);
    const r = parseMultiBubbleReply(JSON.stringify({ messages: [replayed] }));
    assert.deepEqual(r.parts, [
      { kind: "text", text: "好呀～" },
      { kind: "sticker", slug: "happy-cat" },
      { kind: "text", text: "下次见" },
    ]);
  });

  it("leaves user text and plain assistant text untouched", () => {
    assert.equal(renderAssistantHistoryForModel("在的，怎么啦"), "在的，怎么啦");
    assert.equal(renderAssistantHistoryForModel(""), "");
  });
});

describe("hasStickerTextToken", () => {
  it("detects every spelling the renderer or the model can produce", () => {
    for (const s of [
      "[表情:happy-cat]",
      "［表情：happy-cat］",
      "看这个 [sticker:wave] 呀",
      "[emoji: wave ]",
    ]) {
      assert.ok(hasStickerTextToken(s), s);
    }
  });

  it("is stateless across calls", () => {
    assert.ok(hasStickerTextToken("[表情:wave]"));
    assert.ok(hasStickerTextToken("[表情:wave]"));
  });

  it("does not fire on ordinary text", () => {
    assert.equal(hasStickerTextToken("[公告] 明天见"), false);
    assert.equal(hasStickerTextToken("表情包好可爱"), false);
    assert.equal(hasStickerTextToken(""), false);
  });
});
