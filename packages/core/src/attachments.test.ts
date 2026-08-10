import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenChatContent } from "@wechat-ai/llm";
import type { ChatContentPart } from "@wechat-ai/llm";
import {
  buildAttachmentBlock,
  buildChatMessages,
  buildImageCaptionMessages,
  buildUserContent,
  describeAttachments,
  type PromptAttachment,
} from "./prompt.js";

/** Caption mode output: described in words, bytes deliberately not forwarded. */
const CAPTIONED: PromptAttachment = {
  kind: "image",
  mime: "image/png",
  caption: "一只橘猫躺在键盘上",
};

const IMG: PromptAttachment = {
  kind: "image",
  mime: "image/png",
  dataUri: "data:image/png;base64,AAAA",
};
const BLIND_IMG: PromptAttachment = { kind: "image", mime: "image/png" };
const VOICE: PromptAttachment = { kind: "voice", mime: "audio/silk" };
const VIDEO: PromptAttachment = { kind: "video", mime: "video/mp4" };

describe("buildAttachmentBlock", () => {
  it("is empty without attachments", () => {
    assert.equal(buildAttachmentBlock(undefined), "");
    assert.equal(buildAttachmentBlock([]), "");
  });

  it("tells the model a readable image was actually sent", () => {
    const block = buildAttachmentBlock([IMG]);
    assert.match(block, /图片 ×1/);
    assert.match(block, /已随本条消息发给你/);
    assert.match(block, /据实描述/);
  });

  it("forbids inventing contents it cannot perceive", () => {
    const block = buildAttachmentBlock([VIDEO]);
    assert.match(block, /视频 ×1/);
    assert.match(block, /无法查看/);
    assert.match(block, /不要猜测或编造/);
    assert.doesNotMatch(block, /已随本条消息发给你/);
  });

  it("reports readable and unreadable counts of the same kind", () => {
    const block = buildAttachmentBlock([IMG, BLIND_IMG, IMG]);
    assert.match(block, /图片 ×3/);
    assert.match(block, /其中 2 个已随本条消息发给你/);
  });

  it("groups mixed kinds in a stable order", () => {
    const block = buildAttachmentBlock([VIDEO, VOICE, IMG]);
    const order = ["图片", "语音", "视频"].map((k) => block.indexOf(k));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      "kinds should be listed image → voice → video → file",
    );
  });
});

describe("caption mode", () => {
  it("tells the model to treat the description as what it saw", () => {
    const block = buildAttachmentBlock([CAPTIONED]);
    assert.match(block, /已由识图模型转成文字描述/);
    assert.match(block, /当作你亲眼所见/);
    assert.match(block, /不要往外扩写细节/);
    // Must NOT claim the bytes were attached, and must NOT tell it to refuse.
    assert.doesNotMatch(block, /已随本条消息发给你/);
    assert.doesNotMatch(block, /无法查看/);
  });

  it("puts the caption in history so later turns keep the content", () => {
    // The whole payoff: three turns later the model can still discuss the cat.
    assert.equal(
      describeAttachments("看这个", [CAPTIONED]),
      "看这个\n[图片：一只橘猫躺在键盘上]",
    );
    assert.equal(
      describeAttachments("", [CAPTIONED]),
      "[图片：一只橘猫躺在键盘上]",
    );
  });

  it("keeps the user turn plain text — the roleplay model gets no bytes", () => {
    const content = buildUserContent("这是什么", [CAPTIONED]);
    assert.equal(typeof content, "string");
    assert.match(String(content), /一只橘猫躺在键盘上/);
  });

  it("mixes captioned and blind attachments correctly", () => {
    const block = buildAttachmentBlock([CAPTIONED, VIDEO]);
    assert.match(block, /已由识图模型转成文字描述/);
    assert.match(block, /视频 ×1[^\n]*无法查看/);
  });

  it("falls back to a bare tag when captioning produced nothing", () => {
    const failed: PromptAttachment = { kind: "image", mime: "image/png" };
    assert.equal(describeAttachments("", [failed]), "[图片]");
    assert.match(buildAttachmentBlock([failed]), /无法查看/);
  });

  it("counts several captions separately rather than collapsing them", () => {
    const second: PromptAttachment = { ...CAPTIONED, caption: "一杯咖啡" };
    assert.equal(
      describeAttachments("", [CAPTIONED, second]),
      "[图片：一只橘猫躺在键盘上][图片：一杯咖啡]",
    );
  });
});

describe("buildImageCaptionMessages", () => {
  it("asks for an objective description, not roleplay", () => {
    const msgs = buildImageCaptionMessages({
      dataUri: "data:image/png;base64,AAAA",
    });
    assert.equal(msgs.length, 2);
    const system = String(msgs[0]!.content);
    assert.match(system, /图像描述器/);
    assert.match(system, /不要扮演角色/);
    assert.match(system, /不要猜测或编造/);
  });

  it("attaches the image to the user turn", () => {
    const msgs = buildImageCaptionMessages({
      dataUri: "data:image/png;base64,AAAA",
    });
    const parts = msgs[1]!.content as ChatContentPart[];
    assert.equal(Array.isArray(parts), true);
    assert.equal(parts[1]!.type, "image_url");
    assert.equal(
      (parts[1] as { image_url: { url: string } }).image_url.url,
      "data:image/png;base64,AAAA",
    );
  });

  it("folds in the user's own caption to focus the description", () => {
    const msgs = buildImageCaptionMessages({
      dataUri: "data:image/png;base64,AAAA",
      userText: "这是我家猫",
    });
    const parts = msgs[1]!.content as ChatContentPart[];
    assert.match((parts[0] as { text: string }).text, /这是我家猫/);
  });

  it("truncates an overlong user caption", () => {
    const msgs = buildImageCaptionMessages({
      dataUri: "data:image/png;base64,AAAA",
      userText: "猫".repeat(500),
    });
    const text = (msgs[1]!.content as ChatContentPart[])[0] as { text: string };
    assert.ok(text.text.length < 400, `got ${text.text.length} chars`);
  });
});

describe("describeAttachments", () => {
  it("returns bare text when nothing is attached", () => {
    assert.equal(describeAttachments("  你好  ", []), "你好");
  });

  it("appends a tag so later turns still see the image happened", () => {
    assert.equal(describeAttachments("看这个", [IMG]), "看这个\n[图片]");
  });

  it("is never empty for a media-only message", () => {
    assert.equal(describeAttachments("", [IMG]), "[图片]");
    assert.equal(describeAttachments("   ", [VOICE]), "[语音]");
  });

  it("counts repeats", () => {
    assert.equal(describeAttachments("", [IMG, IMG, VOICE]), "[图片×2][语音]");
  });
});

describe("buildUserContent", () => {
  it("stays a plain string when nothing is readable", () => {
    assert.equal(buildUserContent("你好", []), "你好");
    // The kind tag is kept so this turn matches what history will show later.
    assert.equal(buildUserContent("你好", [VIDEO]), "你好\n[视频]");
  });

  it("falls back to the placeholder for an unreadable media-only message", () => {
    assert.equal(buildUserContent("", [VOICE]), "[语音]");
  });

  it("emits content parts when an image is readable", () => {
    const content = buildUserContent("这是什么", [IMG]);
    assert.ok(Array.isArray(content));
    const parts = content as ChatContentPart[];
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], { type: "text", text: "这是什么" });
    assert.deepEqual(parts[1], {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("still leads with a text part when the user sent no caption", () => {
    const parts = buildUserContent("", [IMG]) as ChatContentPart[];
    // Some providers reject a user turn that is images only.
    assert.equal(parts[0]!.type, "text");
    assert.equal((parts[0] as { text: string }).text, "[图片]");
  });

  it("includes only readable attachments as image parts", () => {
    const parts = buildUserContent("看", [IMG, VIDEO, IMG]) as ChatContentPart[];
    assert.equal(parts.filter((p) => p.type === "image_url").length, 2);
  });
});

describe("buildChatMessages with attachments", () => {
  const base = {
    systemPrompt: "你是猫娘。",
    memories: [],
    history: [],
    botName: "小铃",
    multiBubbleJson: false,
  };

  it("injects the attachment block into the system prompt", () => {
    const msgs = buildChatMessages({
      ...base,
      userText: "这是什么",
      attachments: [IMG],
    });
    assert.match(flattenChatContent(msgs[0]!.content), /本条消息的附件/);
  });

  it("omits the block entirely for a plain text turn", () => {
    const msgs = buildChatMessages({ ...base, userText: "你好" });
    assert.doesNotMatch(flattenChatContent(msgs[0]!.content), /本条消息的附件/);
    assert.equal(msgs[msgs.length - 1]!.content, "你好");
  });

  it("makes the final user turn multimodal", () => {
    const msgs = buildChatMessages({
      ...base,
      userText: "这是什么",
      attachments: [IMG],
    });
    const last = msgs[msgs.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(Array.isArray(last.content));
  });

  it("keeps the final user turn a string when nothing is readable", () => {
    const msgs = buildChatMessages({
      ...base,
      userText: "看看",
      attachments: [VIDEO],
    });
    assert.equal(msgs[msgs.length - 1]!.content, "看看\n[视频]");
  });

  it("tags an unsent attachment even when another one is sent", () => {
    const parts = buildUserContent("看看", [IMG, VIDEO]) as ChatContentPart[];
    // The image is right there; the video needs to be named or it vanishes.
    assert.equal((parts[0] as { text: string }).text, "看看\n[视频]");
    assert.equal(parts.filter((p) => p.type === "image_url").length, 1);
  });
});
