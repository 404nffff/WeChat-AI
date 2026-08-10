/**
 * Dependency-free QR Code encoder (byte mode) → SVG.
 *
 * Exists so the iLink login QR is rendered locally instead of by a third party.
 * The scan link carries a login ticket, and the previous implementation handed
 * it to `api.qrserver.com` as a query parameter — an outbound copy of a
 * credential to a service that has no business seeing it.
 *
 * Hand-rolled rather than pulled from npm on purpose: this ships through the
 * OTA channel, which packs `.ts` sources and cannot carry node_modules, so a
 * dependency here would force `requiresInstall` on every release.
 *
 * Structure follows ISO/IEC 18004. The version/ECC tables and the raw-module
 * formula are cross-checked in qrcode.test.ts against the spec's published
 * byte-mode capacities (v1: 17/14/11/7, v40: 2953/2331/1663/1273), and the
 * generated ECC blocks are checked against the Reed–Solomon syndrome property
 * rather than against my own generator polynomial.
 */

export type EcLevel = "L" | "M" | "Q" | "H";

/** Format-info value per EC level (spec table, not the L<Q<M<H ordering). */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const EC_LEVELS: EcLevel[] = ["L", "M", "Q", "H"];

/** ECC codewords per block, indexed [ecLevel][version]; index 0 unused. */
const ECC_CODEWORDS_PER_BLOCK: Record<EcLevel, readonly number[]> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30,
    28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
    26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28,
  ],
  Q: [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28,
    26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30,
  ],
  H: [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28,
    26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30,
  ],
};

/** Number of ECC blocks, indexed [ecLevel][version]; index 0 unused. */
const NUM_ECC_BLOCKS: Record<EcLevel, readonly number[]> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10,
    12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17,
    17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23,
    23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77,
    81,
  ],
};

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrError";
  }
}

// ── GF(256) with the QR primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D) ──

/** Carry-less multiply then reduce; no lookup tables to get out of sync. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Coefficients of the RS generator polynomial, minus the leading 1. */
export function rsComputeDivisor(degree: number): Uint8Array {
  if (degree < 1 || degree > 255) {
    throw new QrError(`RS degree out of range: ${degree}`);
  }
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsComputeRemainder(
  data: Uint8Array | readonly number[],
  divisor: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i]! ^= gfMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

// ── Version geometry ──

/** Modules available for data+ECC, in bits, before block splitting. */
export function numRawDataModules(version: number): number {
  assertVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(version: number, ec: EcLevel): number {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ec][version]! * NUM_ECC_BLOCKS[ec][version]!
  );
}

/**
 * Number of ECC blocks the codewords are split across.
 *
 * Exposed because the block count is not derivable from the totals — several
 * (blocks, eccPerBlock) pairs multiply to the same ECC total, so anything
 * reading a symbol back needs the table value.
 */
export function numEccBlocks(version: number, ec: EcLevel): number {
  assertVersion(version);
  return NUM_ECC_BLOCKS[ec][version]!;
}

/** Character-count field width for byte mode. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Max payload bytes for byte mode at this version + EC level. */
export function byteCapacity(version: number, ec: EcLevel): number {
  const bits = numDataCodewords(version, ec) * 8 - 4 - charCountBits(version);
  return Math.max(0, Math.floor(bits / 8));
}

function assertVersion(version: number): void {
  if (
    !Number.isInteger(version) ||
    version < MIN_VERSION ||
    version > MAX_VERSION
  ) {
    throw new QrError(`version out of range: ${version}`);
  }
}

export function alignmentPatternPositions(version: number): number[] {
  assertVersion(version);
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32
      ? 26
      : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/** Smallest version that fits `byteLen` payload bytes, or null if none does. */
export function pickVersion(
  byteLen: number,
  ec: EcLevel,
  minVersion = MIN_VERSION,
): number | null {
  for (
    let v = Math.max(MIN_VERSION, minVersion);
    v <= MAX_VERSION;
    v++
  ) {
    if (byteLen <= byteCapacity(v, ec)) return v;
  }
  return null;
}

// ── Bit buffer ──

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
}

// ── Encoder ──

export interface QrOptions {
  /** Error correction level; M is the usual choice for scanning off a screen. */
  ec?: EcLevel;
  /** Force at least this version (never lowers the auto-picked one). */
  minVersion?: number;
}

export interface QrCode {
  version: number;
  ec: EcLevel;
  mask: number;
  size: number;
  /** Row-major; true = dark */
  modules: boolean[][];
}

export function encodeQr(text: string, opts: QrOptions = {}): QrCode {
  const ec = opts.ec ?? "M";
  if (!EC_LEVELS.includes(ec)) throw new QrError(`bad EC level: ${ec}`);

  const payload = Buffer.from(text, "utf8");
  const version = pickVersion(payload.length, ec, opts.minVersion ?? 1);
  if (version === null) {
    throw new QrError(
      `data too long: ${payload.length} bytes exceeds ${byteCapacity(
        MAX_VERSION,
        ec,
      )} for EC ${ec}`,
    );
  }

  const dataCodewords = buildDataCodewords(payload, version, ec);
  const finalCodewords = addEccAndInterleave(dataCodewords, version, ec);
  return drawSymbol(finalCodewords, version, ec);
}

/** Mode + count + payload + terminator + pad, to exactly dataCodewords bytes. */
function buildDataCodewords(
  payload: Buffer,
  version: number,
  ec: EcLevel,
): Uint8Array {
  const capacityBits = numDataCodewords(version, ec) * 8;
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode
  bb.append(payload.length, charCountBits(version));
  for (const b of payload) bb.append(b, 8);

  if (bb.bits.length > capacityBits) {
    throw new QrError("internal: payload overflowed the chosen version");
  }
  // Terminator: up to 4 zero bits, only as many as fit.
  bb.append(0, Math.min(4, capacityBits - bb.bits.length));
  // Pad to a byte boundary, then alternate the spec's pad bytes.
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);

  const out = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bb.bits.length; i++) {
    if (bb.bits[i]) out[i >>> 3]! |= 0x80 >>> (i & 7);
  }
  for (let i = bb.bits.length / 8, pad = 0xec; i < out.length; i++) {
    out[i] = pad;
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return out;
}

/** Split into blocks, append RS ECC per block, then interleave per the spec. */
export function addEccAndInterleave(
  data: Uint8Array,
  version: number,
  ec: EcLevel,
): Uint8Array {
  const numBlocks = NUM_ECC_BLOCKS[ec][version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ec][version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  if (data.length !== numDataCodewords(version, ec)) {
    throw new QrError("internal: data codeword count mismatch");
  }

  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsComputeDivisor(blockEccLen);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen =
      shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = Array.from(data.subarray(k, k + datLen));
    k += datLen;
    const ecc = rsComputeRemainder(dat, divisor);
    // Short blocks get a placeholder so column indexing lines up below; it is
    // skipped during interleaving and never reaches the symbol.
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]!);
      }
    });
  }
  if (result.length !== rawCodewords) {
    throw new QrError("internal: interleave produced the wrong length");
  }
  return Uint8Array.from(result);
}

// ── Symbol drawing ──

function drawSymbol(
  codewords: Uint8Array,
  version: number,
  ec: EcLevel,
): QrCode {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns + separators, anchored at the three corners
  drawFinder(set, size, 3, 3);
  drawFinder(set, size, size - 4, 3);
  drawFinder(set, size, 3, size - 4);

  // Alignment patterns, skipping the three finder corners
  const aligns = alignmentPatternPositions(version);
  const last = aligns.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      const corner =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(
            aligns[j]! + dx,
            aligns[i]! + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }

  drawVersionInfo(set, size, version);
  // Reserve the format areas now (mask 0); rewritten once the mask is chosen.
  drawFormatBits(set, size, ec, 0);

  drawCodewords(modules, isFunction, size, codewords);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, size, mask);
    drawFormatBits(set, size, ec, mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(modules, isFunction, size, mask); // XOR is its own inverse
  }
  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(set, size, ec, bestMask);

  return { version, ec, mask: bestMask, size, modules };
}

type SetFn = (x: number, y: number, dark: boolean) => void;

/** 7x7 finder centred at (cx, cy) plus its light separator ring. */
function drawFinder(set: SetFn, size: number, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawFormatBits(
  set: SetFn,
  size: number,
  ec: EcLevel,
  mask: number,
): void {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  // Copy 1 — around the top-left finder
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

  // Copy 2 — split across the other two finders
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // always-dark module
}

function drawVersionInfo(set: SetFn, size: number, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = ((version << 12) | rem) & 0x3ffff;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

/** Zigzag fill of the two-column strips, skipping function modules. */
function drawCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  codewords: Uint8Array,
): void {
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern — the strip shifts left past it.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && i < totalBits) {
          modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  if (i !== totalBits) {
    throw new QrError(
      `internal: placed ${i} of ${totalBits} data bits`,
    );
  }
}

export function maskPredicate(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new QrError(`bad mask: ${mask}`);
  }
}

function applyMask(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  mask: number,
): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y]![x] && maskPredicate(mask, x, y)) {
        modules[y]![x] = !modules[y]![x];
      }
    }
  }
}

const FINDER_RUN = [true, false, true, true, true, false, true];

/** Spec penalty rules N1–N4; drives mask selection only, never correctness. */
export function penaltyScore(modules: boolean[][], size: number): number {
  let penalty = 0;

  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]!.slice());
  for (let x = 0; x < size; x++) {
    lines.push(Array.from({ length: size }, (_, y) => modules[y]![x]!));
  }

  for (const line of lines) {
    // N1: runs of 5+
    let runLen = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) {
        runLen++;
        continue;
      }
      if (runLen >= 5) penalty += PENALTY_N1 + (runLen - 5);
      runLen = 1;
    }
    // N3: finder-like 1:1:3:1:1 with 4 light modules on either side
    for (let i = 0; i + 7 <= line.length; i++) {
      let match = true;
      for (let k = 0; k < 7; k++) {
        if (line[i + k] !== FINDER_RUN[k]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const beforeClear =
        i >= 4 && line.slice(i - 4, i).every((v) => !v);
      const afterClear =
        i + 11 <= line.length && line.slice(i + 7, i + 11).every((v) => !v);
      if (beforeClear || afterClear) penalty += PENALTY_N3;
    }
  }

  // N2: 2x2 blocks of one colour
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y]![x];
      if (
        c === modules[y]![x + 1] &&
        c === modules[y + 1]![x] &&
        c === modules[y + 1]![x + 1]
      ) {
        penalty += PENALTY_N2;
      }
    }
  }

  // N4: deviation of dark proportion from 50%, in 5% steps
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y]![x]) dark++;
  }
  const total = size * size;
  const k = Math.floor(Math.abs((dark * 100) / total - 50) / 5);
  penalty += k * PENALTY_N4;

  return penalty;
}

// ── SVG rendering ──

export interface SvgOptions {
  /** Quiet zone in modules; the spec requires 4 and scanners rely on it. */
  border?: number;
  /** Rendered pixel size of the whole square (viewBox stays in modules). */
  pixelSize?: number;
  dark?: string;
  light?: string;
  title?: string;
}

/**
 * Render to SVG. Horizontal runs are merged into one path so the markup stays
 * a few KB instead of one element per module.
 */
export function renderQrSvg(qr: QrCode, opts: SvgOptions = {}): string {
  const border = Math.max(0, Math.floor(opts.border ?? 4));
  const dark = opts.dark ?? "#000000";
  const light = opts.light ?? "#ffffff";
  const dim = qr.size + border * 2;

  const segments: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y]![x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.modules[y]![x + run]) run++;
      segments.push(`M${x + border} ${y + border}h${run}v1h-${run}z`);
      x += run;
    }
  }

  const sizeAttrs =
    opts.pixelSize && opts.pixelSize > 0
      ? ` width="${Math.round(opts.pixelSize)}" height="${Math.round(
          opts.pixelSize,
        )}"`
      : "";
  const titleEl = opts.title
    ? `<title>${escapeXml(opts.title)}</title>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"` +
    `${sizeAttrs} shape-rendering="crispEdges" role="img">` +
    titleEl +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path fill="${dark}" d="${segments.join("")}"/>` +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/** One-shot: text → SVG markup. */
export function qrSvg(
  text: string,
  opts: QrOptions & SvgOptions = {},
): string {
  return renderQrSvg(encodeQr(text, opts), opts);
}
