import { splitReplyIntoBubbles } from "./split-reply.js";

/** Injected into system prompt so the model returns multi-bubble JSON. */
export const REPLY_FORMAT_INSTRUCTION = `
## 输出格式（系统强制，对用户不可见，优先级最高）
你必须**只**输出一个 JSON 对象：不要 markdown 代码块（禁止 \`\`\`）、不要前后解释、不要旁白。

{"messages":["给你看～",{"type":"sticker","slug":"示例slug"},"喜欢吗"]}

硬性规则（违反任一条视为失败）：
1. messages 是数组；**每一个元素 = 微信里单独发出的一条消息**（一次 send）
2. **微信不能「图文同条」**：一条消息只能是「纯文字」或「纯图片」，绝不能混在同一条里
3. 元素只能是下面两种之一（互斥）：
   - 字符串 → 只发文字（不能含 sticker JSON 字面量）
   - 对象 {"type":"sticker","slug":"..."} → 只发图片（该元素不能带任何文字、caption、说明）
4. 若要「先说话再发表情」：必须用**相邻的两个数组元素**，例如 "文字" 然后 {"type":"sticker",...}；系统会先后发两条消息
5. **禁止**把 sticker 的 JSON 写进字符串里；**禁止**在 sticker 对象里塞 text/caption；**禁止**编造不在「可用表情包」列表里的 slug
6. 正常闲聊拆成 2～4 条；每条文字尽量 ≤40 字；不要小作文、不要编号列表
7. 表情仅合适时用，每条回复最多 2 个 sticker
8. 除该 JSON 外不要输出任何字符
`.trim();

/** When sticker library is empty, keep simpler instruction (no sticker objects). */
export const REPLY_FORMAT_INSTRUCTION_TEXT_ONLY = `
## 输出格式（系统强制，对用户不可见，优先级最高）
你必须**只**输出一个 JSON 对象：不要 markdown 代码块（禁止 \`\`\`）、不要前后解释、不要旁白。

{"messages":["第一句","第二句","第三句"]}

硬性规则（违反任一条视为失败）：
1. messages 是字符串数组；**每一条数组元素 = 微信里单独发出的一条气泡**
2. **禁止**把整段回复塞进 messages 的唯一一个元素；正常闲聊必须拆成 **2～4 条**（极短附和可用 1 条）
3. 每条尽量 ≤40 字，口语、可情绪递进；不要小作文、不要编号「1. 2.」
4. 内容只能是角色对白；禁止出现系统说明、格式说明、JSON 字样
5. 除该 JSON 外不要输出任何字符
`.trim();

export type ReplyPart =
  | { kind: "text"; text: string }
  | { kind: "sticker"; slug: string };

export interface ParsedBubbles {
  /**
   * Ordered WeChat bubbles including stickers.
   * Prefer this for sending.
   */
  parts: ReplyPart[];
  /**
   * Text-only bubbles (sticker rendered as `[表情:slug]`).
   * Kept for backward compatibility / split heuristics consumers.
   */
  bubbles: string[];
  /** Plain text for history / logs (joined) */
  displayText: string;
  /** Whether parsed from model JSON (vs heuristic split) */
  fromJson: boolean;
}

export interface ParseMultiBubbleOptions {
  maxBubbles?: number;
  /** Soft max chars per bubble; longer content is re-split (default 72) */
  maxChunkChars?: number;
  /** When JSON missing, split plain text (default true) */
  fallbackSplit?: boolean;
  /**
   * Re-split long bubbles even if model returned JSON (default true).
   * Fixes models that put the whole reply in messages[0].
   */
  expandLongBubbles?: boolean;
  /** Cap stickers per reply (default 2) */
  maxStickers?: number;
}

/**
 * Parse model output into multiple chat bubbles (text + optional stickers).
 * Preferred: {"messages":["..."]} or mixed sticker objects
 * Fallback: punctuation/paragraph split of raw text.
 */
export function parseMultiBubbleReply(
  raw: string,
  opts?: ParseMultiBubbleOptions,
): ParsedBubbles {
  const maxBubbles = opts?.maxBubbles ?? 5;
  const maxChunkChars = opts?.maxChunkChars ?? 72;
  const fallbackSplit = opts?.fallbackSplit !== false;
  const expandLong = opts?.expandLongBubbles !== false;
  const maxStickers = opts?.maxStickers ?? 2;
  const text = (raw ?? "").trim();
  if (!text) {
    return { parts: [], bubbles: [], displayText: "", fromJson: false };
  }

  let fromJson = false;
  let parts: ReplyPart[] = [];

  const parsed = tryParseJsonParts(text, maxBubbles, maxStickers);
  if (parsed) {
    fromJson = true;
    parts = parsed;
  } else if (fallbackSplit) {
    const bubbles = splitReplyIntoBubbles(text, {
      maxChunks: maxBubbles,
      maxChunkChars,
      minChunkChars: 6,
    });
    parts = (bubbles.length ? bubbles : [text]).map((t) => ({
      kind: "text" as const,
      text: t,
    }));
  } else {
    parts = [{ kind: "text", text }];
  }

  // Collapse before expand so a model that emitted the same multi-line
  // string twice (messages:["A\nB","A\nB"]) does not expand into A,B,A,B.
  parts = collapseConsecutiveTextDupes(parts);

  if (expandLong) {
    parts = expandLongTextParts(parts, maxBubbles, maxChunkChars);
  }

  // Always re-scan text for inlined sticker JSON (models ignore format rules)
  // and NEVER leave raw {"type":"sticker",...} in user-visible text.
  parts = sanitizePartsStripStickerJson(parts, maxStickers);

  // Cap total parts (preserve stickers — do not drop into text merge)
  if (parts.length > maxBubbles) {
    parts = capParts(parts, maxBubbles);
  }

  parts = finalizeParts(parts);
  // Final pass after cap (cap may merge text)
  parts = sanitizePartsStripStickerJson(parts, maxStickers);
  parts = finalizeParts(parts);
  // Models occasionally emit the same string twice in messages[]; collapse
  // so the worker never ships two identical WeChat bubbles back-to-back.
  // Run after expandLong so "foo\nbar"+"foo\nbar" → (foo,bar,foo,bar) still
  // collapses consecutive equals; also covers the pre-expand shape when
  // expandLong is off.
  parts = collapseConsecutiveTextDupes(parts);

  if (!parts.length) {
    // An envelope that reduced to nothing is a no-op reply. `text` is the JSON
    // wrapper itself here, so there is nothing safe to salvage from it.
    if (fromJson) {
      return { parts: [], bubbles: [], displayText: "", fromJson };
    }
    // Last resort: strip raw sticker JSON from whole reply text
    const cleaned = stripAllStickerJson(text).trim();
    return {
      parts: cleaned ? [{ kind: "text", text: cleaned }] : [],
      bubbles: cleaned ? [cleaned] : [],
      displayText: cleaned,
      fromJson,
    };
  }

  return {
    parts,
    bubbles: partsToLegacyBubbles(parts),
    displayText: partsToDisplayText(parts),
    fromJson,
  };
}

/**
 * Public helper: ensure no sticker JSON leaks into text bubbles.
 * Safe to call again in the worker before send.
 */
export function sanitizePartsStripStickerJson(
  parts: ReplyPart[],
  maxStickers = 2,
): ReplyPart[] {
  const out: ReplyPart[] = [];
  let stickerCount = 0;
  for (const p of parts) {
    if (p.kind === "sticker") {
      if (stickerCount >= maxStickers) continue;
      const slug = p.slug.trim().toLowerCase();
      if (slug) {
        out.push({ kind: "sticker", slug });
        stickerCount++;
      }
      continue;
    }
    const extracted = extractEmbeddedStickersFromText(
      p.text,
      maxStickers - stickerCount,
    );
    for (const e of extracted) {
      if (e.kind === "sticker") {
        if (stickerCount >= maxStickers) continue;
        out.push(e);
        stickerCount++;
      } else {
        const cleaned = stripAllStickerJson(e.text).trim();
        if (cleaned) out.push({ kind: "text", text: cleaned });
      }
    }
  }
  return out;
}

/**
 * `[表情:slug]` — the notation partsToDisplayText writes for history and logs.
 *
 * It has to be readable as *input* too, not just written as output: the stored
 * assistant turn is replayed to the model verbatim (see prompt.ts), so the
 * model reads its own past stickers in this shape and imitates it as plain
 * text. Every other guard here is anchored on `{`, so before this existed such
 * a bubble matched nothing and shipped to WeChat as the literal `[表情:s-…]`.
 *
 * Full-width brackets/colon and the `[sticker:x]` spelling are accepted too —
 * the model is copying by eye, not by grammar.
 */
const STICKER_TOKEN_SOURCE =
  "[\\[［]\\s*(?:表情包|表情|sticker|emoji|emoticon)\\s*[:：]\\s*([a-zA-Z0-9_-]{2,64})\\s*[\\]］]";

/**
 * Looser shape, for scrubbing and detection only.
 *
 * The parse form above is deliberately strict because its capture is looked up
 * as a real slug. Anything merely token-shaped — a truncated or over-long slug,
 * a model that spelled it wrong — can never become a sticker, and so must be
 * deleted rather than handed to WeChat as text.
 */
const STICKER_TOKEN_LOOSE_SOURCE =
  "[\\[［]\\s*(?:表情包|表情|sticker|emoji|emoticon)\\s*[:：][^\\]］\\n]{0,120}[\\]］]";

/** Stateless probe: does this text still carry a sticker token of any shape? */
export function hasStickerTextToken(text: string): boolean {
  return new RegExp(STICKER_TOKEN_LOOSE_SOURCE, "i").test(text ?? "");
}

/**
 * Rewrite stored `[表情:slug]` tokens into the sticker JSON the output format
 * actually mandates, so replayed history never teaches the model a notation it
 * is forbidden to emit. Sticker JSON inlined in a text string is a shape the
 * parser already recovers from (extractEmbeddedStickersFromText); the bracket
 * token was not.
 */
export function renderAssistantHistoryForModel(content: string): string {
  if (!content) return content;
  return content.replace(
    new RegExp(STICKER_TOKEN_SOURCE, "gi"),
    (_full, slug: string) => `{"type":"sticker","slug":"${slug.toLowerCase()}"}`,
  );
}

/** Remove any leftover sticker-shaped JSON fragments from a text bubble. */
export function stripAllStickerJson(text: string): string {
  if (!text) return "";
  let s = text;
  // Full object forms
  s = s.replace(
    /\{\s*["'“”]type["'“”]\s*:\s*["'“”](?:sticker|emoji|image|emoticon)["'“”]\s*,\s*["'“”]slug["'“”]\s*:\s*["'“”][a-zA-Z0-9_-]+["'“”]\s*\}/gi,
    " ",
  );
  s = s.replace(
    /\{\s*["'“”]slug["'“”]\s*:\s*["'“”][a-zA-Z0-9_-]+["'“”]\s*,\s*["'“”]type["'“”]\s*:\s*["'“”](?:sticker|emoji|image|emoticon)["'“”]\s*\}/gi,
    " ",
  );
  s = s.replace(
    /\{\s*["'“”]sticker["'“”]\s*:\s*["'“”][a-zA-Z0-9_-]+["'“”]\s*\}/gi,
    " ",
  );
  // Truncated / broken fragments models sometimes emit mid-sentence
  s = s.replace(
    /\{\s*["'“”]?type["'“”]?\s*:\s*["'“”]?sticker["'“”]?[^}]{0,80}\}/gi,
    " ",
  );
  // Bracket token, last resort only: extractEmbeddedStickersFromText claims
  // well-formed ones as real stickers first, so whatever is still here is
  // malformed or unusable and must not reach WeChat as text.
  s = s.replace(new RegExp(STICKER_TOKEN_LOOSE_SOURCE, "gi"), " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

export function partsToDisplayText(parts: ReplyPart[]): string {
  return parts
    .map((p) =>
      p.kind === "text" ? p.text : `[表情:${p.slug}]`,
    )
    .filter(Boolean)
    .join("\n");
}

export function partsToLegacyBubbles(parts: ReplyPart[]): string[] {
  return parts.map((p) =>
    p.kind === "text" ? p.text : `[表情:${p.slug}]`,
  );
}

function finalizeParts(parts: ReplyPart[]): ReplyPart[] {
  const out: ReplyPart[] = [];
  for (const p of parts) {
    if (p.kind === "sticker") {
      const slug = p.slug.trim().toLowerCase();
      if (slug) out.push({ kind: "sticker", slug });
      continue;
    }
    const t = p.text.trim();
    if (t) out.push({ kind: "text", text: t });
  }
  return out;
}

/**
 * Drop consecutive identical text bubbles.
 *
 * Models sometimes emit the same string twice in `messages` (or the heuristic
 * splitter produces a near-empty duplicate). Shipping both as separate WeChat
 * messages is what the user sees as "流式坏了" — two identical bubbles in a row.
 * Stickers are left alone; only pure-text neighbours are collapsed.
 */
function collapseConsecutiveTextDupes(parts: ReplyPart[]): ReplyPart[] {
  if (parts.length <= 1) return parts;
  const out: ReplyPart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "text" &&
      p.kind === "text" &&
      prev.text === p.text
    ) {
      continue;
    }
    out.push(p);
  }
  return out;
}

function capParts(parts: ReplyPart[], maxBubbles: number): ReplyPart[] {
  if (parts.length <= maxBubbles) return parts;
  // Prefer keeping stickers: take first N parts but if we cut mid-way,
  // append any remaining stickers that still fit by swapping trailing text.
  const kept = parts.slice(0, maxBubbles);
  const rest = parts.slice(maxBubbles);
  const extraStickers = rest.filter(
    (p): p is { kind: "sticker"; slug: string } => p.kind === "sticker",
  );
  if (!extraStickers.length) return kept;

  const out = [...kept];
  for (const st of extraStickers) {
    // Replace last pure-text bubble with sticker if over cap
    if (out.length < maxBubbles) {
      out.push(st);
      continue;
    }
    let replaced = false;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.kind === "text") {
        out[i] = st;
        replaced = true;
        break;
      }
    }
    if (!replaced) break;
  }
  // Append remaining text from rest into last text if any room conceptually
  const textTail = rest
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("");
  if (textTail.trim()) {
    const lastTextIdx = [...out]
      .map((p, i) => (p.kind === "text" ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    if (lastTextIdx !== undefined) {
      const cur = out[lastTextIdx] as { kind: "text"; text: string };
      out[lastTextIdx] = {
        kind: "text",
        text: (cur.text + textTail).trim(),
      };
    } else if (out.length < maxBubbles) {
      out.push({ kind: "text", text: textTail.trim() });
    }
  }
  return out;
}

/**
 * If the model stuffed everything into one (or few) long string(s),
 * split further so the worker can send multiple WeChat messages.
 * Stickers are left intact.
 */
function expandLongTextParts(
  parts: ReplyPart[],
  maxBubbles: number,
  maxChunkChars: number,
): ReplyPart[] {
  if (!parts.length) return parts;

  const textOnly = parts.every((p) => p.kind === "text");
  if (textOnly && parts.length === 1) {
    const only = (parts[0] as { kind: "text"; text: string }).text;
    if (
      only.length > maxChunkChars ||
      /[。！？!?]/.test(only) ||
      /\n/.test(only)
    ) {
      const split = splitReplyIntoBubbles(only, {
        maxChunks: maxBubbles,
        maxChunkChars,
        minChunkChars: 6,
      });
      if (split.length > 1) {
        return split.map((t) => ({ kind: "text" as const, text: t }));
      }
    }
    return parts;
  }

  const out: ReplyPart[] = [];
  for (const p of parts) {
    if (p.kind === "sticker") {
      out.push(p);
      continue;
    }
    if (p.text.length <= maxChunkChars * 1.2) {
      out.push(p);
      continue;
    }
    const split = splitReplyIntoBubbles(p.text, {
      maxChunks: maxBubbles,
      maxChunkChars,
      minChunkChars: 6,
    });
    if (split.length) {
      for (const t of split) out.push({ kind: "text", text: t });
    } else {
      out.push(p);
    }
  }
  if (out.length > maxBubbles) {
    return capParts(out, maxBubbles);
  }
  return out;
}

function tryParseJsonParts(
  text: string,
  maxBubbles: number,
  maxStickers: number,
): ReplyPart[] | null {
  // strip optional ```json ... ```
  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) body = fence[1].trim();

  // Some models wrap with leading chatter — keep from first { or [
  const objStart = body.indexOf("{");
  const arrStart = body.indexOf("[");
  let candidate = body;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    const end = body.lastIndexOf("}");
    if (end > objStart) candidate = body.slice(objStart, end + 1);
  } else if (arrStart >= 0) {
    const end = body.lastIndexOf("]");
    if (end > arrStart) candidate = body.slice(arrStart, end + 1);
  }

  // Normalize common model quirks
  candidate = candidate
    .replace(/[\u201c\u201d]/g, '"') // “ ”
    .replace(/[\u2018\u2019]/g, "'") // ‘ ’
    .replace(/,\s*([}\]])/g, "$1"); // trailing commas

  try {
    const data = JSON.parse(candidate) as unknown;
    // A recognised envelope wins even when it reduces to nothing usable —
    // returning null there would fall through to the raw-text splitter and
    // ship `{"messages":[…]}` to WeChat verbatim.
    return normalizePartList(data, maxBubbles, maxStickers);
  } catch {
    return null;
  }
}

/** null when this is not a bubble envelope at all (vs. an empty one). */
function normalizePartList(
  data: unknown,
  maxBubbles: number,
  maxStickers: number,
): ReplyPart[] | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(data)) {
    arr = data;
  } else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.messages)) arr = o.messages;
    else if (Array.isArray(o.bubbles)) arr = o.bubbles;
    else if (Array.isArray(o.replies)) arr = o.replies;
    else if (typeof o.message === "string") arr = [o.message];
    else if (typeof o.content === "string") arr = [o.content];
    else if (typeof o.text === "string") arr = [o.text];
  }
  if (!arr) return null;

  const parts: ReplyPart[] = [];
  let stickerCount = 0;
  for (const x of arr) {
    if (parts.length >= maxBubbles) break;
    if (typeof x === "string") {
      // Models often embed {"type":"sticker","slug":"..."} inside a text string
      const extracted = extractEmbeddedStickersFromText(x, maxStickers - stickerCount);
      for (const p of extracted) {
        if (parts.length >= maxBubbles) break;
        if (p.kind === "sticker") {
          if (stickerCount >= maxStickers) continue;
          parts.push(p);
          stickerCount++;
        } else if (p.text.trim()) {
          parts.push({ kind: "text", text: p.text.trim() });
        }
      }
      continue;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const stickerSlug = extractStickerSlug(o);
      if (stickerSlug) {
        if (stickerCount >= maxStickers) continue;
        parts.push({ kind: "sticker", slug: stickerSlug });
        stickerCount++;
        continue;
      }
      if (typeof o.text === "string") {
        const extracted = extractEmbeddedStickersFromText(
          o.text,
          maxStickers - stickerCount,
        );
        for (const p of extracted) {
          if (parts.length >= maxBubbles) break;
          if (p.kind === "sticker") {
            if (stickerCount >= maxStickers) continue;
            parts.push(p);
            stickerCount++;
          } else if (p.text.trim()) {
            parts.push({ kind: "text", text: p.text.trim() });
          }
        }
        continue;
      }
      if (typeof o.content === "string") {
        const t = o.content.trim();
        if (t) parts.push({ kind: "text", text: t });
        continue;
      }
    }
  }
  return parts;
}

/**
 * Split a model text bubble that illegally inlined sticker JSON objects.
 * e.g. `(/ω\\) {"type":"sticker","slug":"x"} 好啦` → text + sticker + text
 */
function extractEmbeddedStickersFromText(
  text: string,
  maxStickers: number,
): ReplyPart[] {
  const raw = text ?? "";
  if (!raw.trim()) return [];

  // Flexible quotes: " ' “ ”
  const Q = `["'“”]`;
  const re =
    new RegExp(
      `\\{\\s*${Q}type${Q}\\s*:\\s*${Q}(?:sticker|emoji|image|emoticon)${Q}\\s*,\\s*${Q}slug${Q}\\s*:\\s*${Q}([a-zA-Z0-9_-]+)${Q}\\s*\\}`,
      "gi",
    );
  const reAlt = new RegExp(
    `\\{\\s*${Q}sticker${Q}\\s*:\\s*${Q}([a-zA-Z0-9_-]+)${Q}\\s*\\}`,
    "gi",
  );
  const reSlugFirst = new RegExp(
    `\\{\\s*${Q}slug${Q}\\s*:\\s*${Q}([a-zA-Z0-9_-]+)${Q}\\s*,\\s*${Q}type${Q}\\s*:\\s*${Q}(?:sticker|emoji|image|emoticon)${Q}\\s*\\}`,
    "gi",
  );
  // Loose: type/sticker anywhere then slug nearby inside braces
  const reLoose =
    /\{\s*[^}]{0,40}type[^}]{0,20}sticker[^}]{0,40}slug[^}]{0,10}["'“”]?([a-zA-Z0-9_-]{2,64})["'“”]?[^}]*\}/gi;
  // Bracket token the history renderer emits — see STICKER_TOKEN_SOURCE
  const reToken = new RegExp(STICKER_TOKEN_SOURCE, "gi");

  type Hit = { start: number; end: number; slug: string };
  const hits: Hit[] = [];
  for (const pattern of [re, reAlt, reSlugFirst, reLoose, reToken]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(raw)) !== null) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        slug: m[1]!.toLowerCase(),
      });
    }
  }
  if (!hits.length) {
    // Still strip any garbage so raw JSON never goes to WeChat as text
    const cleaned = stripAllStickerJson(raw);
    return cleaned ? [{ kind: "text", text: cleaned }] : [];
  }
  hits.sort((a, b) => a.start - b.start);
  const uniq: Hit[] = [];
  for (const h of hits) {
    if (uniq.some((u) => !(h.end <= u.start || h.start >= u.end))) continue;
    uniq.push(h);
  }

  const parts: ReplyPart[] = [];
  let cursor = 0;
  let used = 0;
  for (const h of uniq) {
    if (h.start > cursor) {
      const before = stripAllStickerJson(raw.slice(cursor, h.start)).trim();
      if (before) parts.push({ kind: "text", text: before });
    }
    if (used < maxStickers) {
      parts.push({ kind: "sticker", slug: h.slug });
      used++;
    }
    cursor = h.end;
  }
  if (cursor < raw.length) {
    const after = stripAllStickerJson(raw.slice(cursor)).trim();
    if (after) parts.push({ kind: "text", text: after });
  }
  return parts.length ? parts : [];
}

function extractStickerSlug(o: Record<string, unknown>): string | null {
  const type = typeof o.type === "string" ? o.type.toLowerCase() : "";
  if (
    type === "sticker" ||
    type === "emoji" ||
    type === "image" ||
    type === "emoticon"
  ) {
    const slug = o.slug ?? o.id ?? o.name;
    if (typeof slug === "string" && slug.trim()) {
      return slug.trim().toLowerCase();
    }
  }
  if (typeof o.sticker === "string" && o.sticker.trim()) {
    return o.sticker.trim().toLowerCase();
  }
  if (typeof o.emoji === "string" && o.emoji.trim()) {
    return o.emoji.trim().toLowerCase();
  }
  return null;
}
