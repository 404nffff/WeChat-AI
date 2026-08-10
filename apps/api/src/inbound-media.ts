import type { InboundMediaRef } from "@wechat-ai/ilink";

/**
 * Decides what to do with the attachments on an inbound WeChat message.
 *
 * Split out of BotWorkerManager so the gating rules — which attachments are
 * worth pulling off the CDN, how many images one message may cost, and which
 * ones are already covered by the text — are testable without a Redis handle or
 * a live iLink client.
 */

export interface MediaPlanEntry {
  ref: InboundMediaRef;
  /**
   * True when the bytes should be fetched and offered to the model. False means
   * notice-only: the persona is told the attachment exists but that it cannot
   * perceive it, which is what stops it inventing contents.
   */
  download: boolean;
}

export interface MediaPlanOptions {
  /** Global switch; off means no image is ever downloaded */
  visionEnabled: boolean;
  /** Max images from one message that may be sent to the model */
  maxImages: number;
  /**
   * Whether the message text already carries iLink's voice transcript
   * (default true, matching VOICE_TRANSCRIPT_ENABLED).
   *
   * Must agree with what was passed to extractText: when transcripts are in use
   * the voice note is already readable as text, and when they are not it has to
   * stay in the plan so the peer gets the "didn't catch that" line.
   */
  voiceTranscriptEnabled?: boolean;
}

export function planInboundMedia(
  refs: readonly InboundMediaRef[],
  opts: MediaPlanOptions,
): MediaPlanEntry[] {
  const maxImages = Math.max(1, Math.floor(opts.maxImages));
  const useTranscript = opts.voiceTranscriptEnabled !== false;
  const plan: MediaPlanEntry[] = [];
  let images = 0;

  for (const ref of refs) {
    // iLink already transcribed this one and extractText folded it into the
    // message text. Listing it would tell the model it cannot hear something it
    // is about to read. With transcripts disabled there is no such text, so the
    // ref stays and becomes a notice-only attachment.
    if (useTranscript && ref.kind === "voice" && ref.transcript?.trim()) {
      continue;
    }

    // Only images can be handed to an OpenAI-compatible model. Fetching voice /
    // video / file bytes we cannot use would be pure bandwidth, so they are
    // never downloaded — WeChat voice is SILK/AMR, which no chat completions
    // endpoint accepts anyway.
    const wantImage =
      ref.kind === "image" && opts.visionEnabled && images < maxImages;
    if (wantImage) images++;
    plan.push({ ref, download: wantImage });
  }

  return plan;
}

/**
 * Reply for a message that is nothing but media the bot cannot perceive.
 *
 * Replaces a blanket "目前只支持文字消息喵～" with a line that names what
 * actually arrived, so the user knows whether to retype it or that this kind of
 * attachment simply is not supported.
 */
export function unreadableMediaReply(
  refs: readonly InboundMediaRef[],
): string {
  switch (refs[0]?.kind) {
    case "image":
      return "我这边还看不了图片呢～你用文字跟我说说好不好？";
    case "voice":
      return "这段语音我没听清，方便打字告诉我吗？";
    case "video":
      return "视频我还看不了呀，用文字聊好不好～";
    case "file":
      return "文件我打不开呢，重要内容可以贴成文字发我～";
    default:
      return "目前只支持文字消息喵～请发文字聊天。";
  }
}
