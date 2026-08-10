import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboundMediaRef } from "@wechat-ai/ilink";
import { planInboundMedia, unreadableMediaReply } from "./inbound-media.js";

function ref(
  kind: InboundMediaRef["kind"],
  extra: Partial<InboundMediaRef> = {},
): InboundMediaRef {
  return {
    kind,
    index: 0,
    encryptQueryParam: "eqp",
    aesKey: "a".repeat(32),
    ...extra,
  };
}

const visionOn = { visionEnabled: true, maxImages: 2 };
const visionOff = { visionEnabled: false, maxImages: 2 };

describe("planInboundMedia", () => {
  it("downloads an image when vision is on", () => {
    const plan = planInboundMedia([ref("image")], visionOn);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.download, true);
  });

  it("never downloads when vision is off", () => {
    const plan = planInboundMedia([ref("image")], visionOff);
    assert.equal(plan.length, 1);
    assert.equal(
      plan[0]!.download,
      false,
      "an image must stay notice-only so the persona says it cannot see it",
    );
  });

  it("never downloads non-image media, even with vision on", () => {
    // WeChat voice is SILK/AMR and no chat completions endpoint accepts it;
    // video/file bytes are equally unusable. Fetching them is pure bandwidth.
    for (const kind of ["voice", "video", "file"] as const) {
      const plan = planInboundMedia([ref(kind)], visionOn);
      assert.equal(plan.length, 1, kind);
      assert.equal(plan[0]!.download, false, kind);
    }
  });

  it("drops a voice note that iLink already transcribed", () => {
    // extractText folded the transcript into the message text, so listing the
    // attachment would claim the model cannot hear what it is about to read.
    assert.deepEqual(
      planInboundMedia([ref("voice", { transcript: "语音转写" })], visionOn),
      [],
    );
  });

  it("keeps a transcribed voice note when transcripts are disabled", () => {
    // With VOICE_TRANSCRIPT_ENABLED=false the text never contained the
    // transcript, so the ref must survive to produce the "didn't catch that"
    // reply — dropping it would leave the message with nothing at all.
    const plan = planInboundMedia([ref("voice", { transcript: "语音转写" })], {
      ...visionOn,
      voiceTranscriptEnabled: false,
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.download, false);
  });

  it("keeps a voice note with a blank transcript as notice-only", () => {
    const plan = planInboundMedia([ref("voice", { transcript: "   " })], visionOn);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.download, false);
  });

  it("caps how many images one message may cost", () => {
    const plan = planInboundMedia(
      [ref("image"), ref("image"), ref("image"), ref("image")],
      { visionEnabled: true, maxImages: 2 },
    );
    assert.equal(plan.length, 4, "every attachment is still reported");
    assert.deepEqual(
      plan.map((p) => p.download),
      [true, true, false, false],
      "images past the cap become notice-only rather than disappearing",
    );
  });

  it("counts only images against the cap", () => {
    const plan = planInboundMedia(
      [ref("video"), ref("image"), ref("file"), ref("image")],
      { visionEnabled: true, maxImages: 2 },
    );
    assert.deepEqual(
      plan.map((p) => [p.ref.kind, p.download]),
      [
        ["video", false],
        ["image", true],
        ["file", false],
        ["image", true],
      ],
    );
  });

  it("clamps a nonsensical cap to at least one", () => {
    for (const maxImages of [0, -3, 0.4]) {
      const plan = planInboundMedia([ref("image"), ref("image")], {
        visionEnabled: true,
        maxImages,
      });
      assert.equal(
        plan.filter((p) => p.download).length,
        1,
        `maxImages=${maxImages}`,
      );
    }
  });

  it("preserves order and the original refs", () => {
    const a = ref("image", { index: 1, encryptQueryParam: "a" });
    const b = ref("file", { index: 2, fileName: "x.pdf" });
    const plan = planInboundMedia([a, b], visionOn);
    assert.equal(plan[0]!.ref, a);
    assert.equal(plan[1]!.ref, b);
  });

  it("handles an empty list", () => {
    assert.deepEqual(planInboundMedia([], visionOn), []);
  });
});

describe("unreadableMediaReply", () => {
  it("names the kind that actually arrived", () => {
    assert.match(unreadableMediaReply([ref("image")]), /看不了图片/);
    assert.match(unreadableMediaReply([ref("voice")]), /语音/);
    assert.match(unreadableMediaReply([ref("video")]), /视频/);
    assert.match(unreadableMediaReply([ref("file")]), /文件/);
  });

  it("keeps the original generic line when there is nothing to name", () => {
    assert.equal(
      unreadableMediaReply([]),
      "目前只支持文字消息喵～请发文字聊天。",
    );
  });

  it("leads with the first attachment for a mixed message", () => {
    assert.match(
      unreadableMediaReply([ref("video"), ref("image")]),
      /视频/,
    );
  });
});
