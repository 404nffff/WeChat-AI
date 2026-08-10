/** Sticker image helpers (decode / mime). Blobs are stored in Redis, not disk. */

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function normalizeMime(mime: string): string | null {
  let m = (mime || "").trim().toLowerCase();
  if (m === "image/jpg") m = "image/jpeg";
  if (!ALLOWED_MIME.has(m)) return null;
  return m;
}

export function isAllowedStickerMime(mime: string): boolean {
  return normalizeMime(mime) !== null;
}

export function extForMime(mime: string): string {
  const n = normalizeMime(mime) || "image/png";
  return MIME_EXT[n] || ".bin";
}

/** Decode data URL or raw base64 into a Buffer. */
export function decodeBase64Image(dataBase64: string): Buffer {
  let raw = (dataBase64 || "").trim();
  const dataUrl = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrl) {
    raw = dataUrl[2]!;
  }
  raw = raw.replace(/\s+/g, "");
  return Buffer.from(raw, "base64");
}

export function sniffMimeFromBuffer(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function makeStickerFileName(id: string, mime: string): string {
  return `${id}${extForMime(mime)}`;
}
