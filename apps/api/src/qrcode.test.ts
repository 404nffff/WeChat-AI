import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_VERSION,
  QrError,
  addEccAndInterleave,
  alignmentPatternPositions,
  byteCapacity,
  encodeQr,
  gfMultiply,
  maskPredicate,
  numDataCodewords,
  numEccBlocks,
  numRawDataModules,
  pickVersion,
  qrSvg,
  renderQrSvg,
  rsComputeDivisor,
  rsComputeRemainder,
  type EcLevel,
  type QrCode,
} from "./qrcode.js";

// ── Independent helpers, written against the spec rather than reusing the
// encoder's internals, so a bug in one side does not hide behind the other. ──

/** Bit-polynomial remainder; used to check the BCH-protected fields. */
function polyRemainder(value: number, gen: number, genBits: number): number {
  let v = value;
  for (;;) {
    const bits = 32 - Math.clz32(v);
    if (bits < genBits) return v;
    v ^= gen << (bits - genBits);
  }
}

function gfPow(base: number, exp: number): number {
  let r = 1;
  for (let i = 0; i < exp; i++) r = gfMultiply(r, base);
  return r;
}

/** Evaluate a codeword polynomial (first byte = highest degree) at x. */
function gfEvaluate(codeword: readonly number[], x: number): number {
  let acc = 0;
  for (const c of codeword) acc = gfMultiply(acc, x) ^ c;
  return acc;
}

/**
 * A Reed–Solomon codeword built with generator prod(x - a^i), i<t, must vanish
 * at every a^i. Checking that is independent of how the generator was built.
 */
function assertValidRsCodeword(codeword: readonly number[], t: number): void {
  for (let i = 0; i < t; i++) {
    const syndrome = gfEvaluate(codeword, gfPow(2, i));
    assert.equal(syndrome, 0, `syndrome ${i} should vanish, got ${syndrome}`);
  }
}

const ECC_PER_BLOCK: Record<EcLevel, (v: number) => number> = {
  L: (v) => numRawDataModulesCodewords(v) - numDataCodewords(v, "L"),
  M: (v) => numRawDataModulesCodewords(v) - numDataCodewords(v, "M"),
  Q: (v) => numRawDataModulesCodewords(v) - numDataCodewords(v, "Q"),
  H: (v) => numRawDataModulesCodewords(v) - numDataCodewords(v, "H"),
};

function numRawDataModulesCodewords(v: number): number {
  return Math.floor(numRawDataModules(v) / 8);
}

/** Function-module map derived from the spec, not from the encoder. */
function functionMap(version: number, size: number): boolean[][] {
  const fn = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const box = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) fn[y]![x] = true;
      }
    }
  };
  // Finder + separator + the format strips that hug them
  box(0, 0, 8, 8);
  box(size - 8, 0, size - 1, 8);
  box(0, size - 8, 8, size - 1);
  // Timing patterns
  box(0, 6, size - 1, 6);
  box(6, 0, 6, size - 1);
  // Alignment patterns, minus the three finder corners
  const aligns = alignmentPatternPositions(version);
  const last = aligns.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0);
      if (corner) continue;
      box(aligns[j]! - 2, aligns[i]! - 2, aligns[j]! + 2, aligns[i]! + 2);
    }
  }
  // Version information blocks
  if (version >= 7) {
    box(0, size - 11, 5, size - 9);
    box(size - 11, 0, size - 9, 5);
  }
  return fn;
}

interface Decoded {
  text: string;
  ec: EcLevel;
  mask: number;
  blocks: number[][];
}

/**
 * Read a symbol back: format info → unmask → zigzag → de-interleave → segment.
 * Deliberately re-derives every step instead of calling encoder helpers.
 */
function decodeQr(qr: QrCode): Decoded {
  const { size, version } = qr;

  // Format info copy 1: bits 0..5 down column 8, then the corner, then along row 8
  const c1: boolean[] = [];
  for (let i = 0; i <= 5; i++) c1.push(qr.modules[i]![8]!);
  c1.push(qr.modules[7]![8]!);
  c1.push(qr.modules[8]![8]!);
  c1.push(qr.modules[8]![7]!);
  for (let i = 9; i < 15; i++) c1.push(qr.modules[8]![14 - i]!);

  // Format info copy 2: along row 8 from the right, then up column 8
  const c2: boolean[] = [];
  for (let i = 0; i < 8; i++) c2.push(qr.modules[8]![size - 1 - i]!);
  for (let i = 8; i < 15; i++) c2.push(qr.modules[size - 15 + i]![8]!);

  assert.deepEqual(c1, c2, "the two format-info copies must agree");

  let raw = 0;
  for (let i = 14; i >= 0; i--) raw = (raw << 1) | (c1[i] ? 1 : 0);
  assert.equal(
    polyRemainder(raw ^ 0x5412, 0x537, 11),
    0,
    "format info must satisfy its BCH(15,5) check",
  );
  const unmasked = (raw ^ 0x5412) >>> 10;
  const ecBits = (unmasked >>> 3) & 0b11;
  const mask = unmasked & 0b111;
  const ec = (["M", "L", "H", "Q"] as const)[ecBits]!;

  if (version >= 7) {
    let vRaw = 0;
    for (let i = 17; i >= 0; i--) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      vRaw = (vRaw << 1) | (qr.modules[b]![a] ? 1 : 0);
    }
    assert.equal(
      polyRemainder(vRaw, 0x1f25, 13),
      0,
      "version info must satisfy its BCH(18,6) check",
    );
    assert.equal(vRaw >>> 12, version, "version info must encode the version");
  }

  // Unmask the data region
  const fn = functionMap(version, size);
  const grid = qr.modules.map((row) => row.slice());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y]![x] && maskPredicate(mask, x, y)) grid[y]![x] = !grid[y]![x];
    }
  }

  // Zigzag read
  const total = numRawDataModulesCodewords(version);
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]![x] && bits.length < total * 8) {
          bits.push(grid[y]![x] ? 1 : 0);
        }
      }
    }
  }
  assert.equal(bits.length, total * 8, "zigzag must cover every data module");

  const stream: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]!;
    stream.push(b);
  }

  // De-interleave
  const eccTotal = ECC_PER_BLOCK[ec](version);
  const dataTotal = numDataCodewords(version, ec);
  const numBlocks = countBlocks(version, ec);
  const blockEccLen = eccTotal / numBlocks;
  assert.ok(
    Number.isInteger(blockEccLen),
    "ECC codewords must divide evenly across blocks",
  );
  const numShortBlocks = numBlocks - (total % numBlocks);
  const shortBlockLen = Math.floor(total / numBlocks);

  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let p = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortBlockLen - blockEccLen && j < numShortBlocks) continue;
      blocks[j]!.push(stream[p++]!);
    }
  }
  assert.equal(p, stream.length, "de-interleave must consume the whole stream");

  const data: number[] = [];
  for (let j = 0; j < numBlocks; j++) {
    const dataLen = shortBlockLen - blockEccLen + (j < numShortBlocks ? 0 : 1);
    data.push(...blocks[j]!.slice(0, dataLen));
  }
  assert.equal(data.length, dataTotal, "recovered data codeword count");

  // Parse the byte-mode segment
  const dbits: number[] = [];
  for (const b of data) {
    for (let k = 7; k >= 0; k--) dbits.push((b >>> k) & 1);
  }
  let at = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dbits[at++]!;
    return v;
  };
  assert.equal(take(4), 0b0100, "mode indicator must be byte mode");
  const len = take(version <= 9 ? 8 : 16);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = take(8);

  return { text: out.toString("utf8"), ec, mask, blocks };
}

/**
 * The block count genuinely cannot be inferred from the totals — many
 * (blocks, eccPerBlock) pairs give the same product — so this reader takes the
 * table value. The *split* is still independently validated: if it were wrong,
 * blocks would be sliced at the wrong boundaries and the Reed–Solomon syndrome
 * assertions below could not vanish.
 */
function countBlocks(version: number, ec: EcLevel): number {
  return numEccBlocks(version, ec);
}

// ── Tests ──

describe("GF(256) arithmetic", () => {
  it("has 1 as the multiplicative identity and 0 as annihilator", () => {
    for (let x = 0; x < 256; x++) {
      assert.equal(gfMultiply(x, 1), x);
      assert.equal(gfMultiply(x, 0), 0);
    }
  });

  it("is commutative", () => {
    for (let x = 0; x < 256; x += 7) {
      for (let y = 0; y < 256; y += 11) {
        assert.equal(gfMultiply(x, y), gfMultiply(y, x));
      }
    }
  });

  it("is associative and distributive over XOR", () => {
    for (const [a, b, c] of [
      [2, 3, 5],
      [0x53, 0xca, 0x1f],
      [255, 128, 7],
    ]) {
      assert.equal(
        gfMultiply(gfMultiply(a!, b!), c!),
        gfMultiply(a!, gfMultiply(b!, c!)),
      );
      assert.equal(
        gfMultiply(a!, b! ^ c!),
        gfMultiply(a!, b!) ^ gfMultiply(a!, c!),
      );
    }
  });

  it("2 is primitive: its powers cycle with order 255", () => {
    const seen = new Set<number>();
    let v = 1;
    for (let i = 0; i < 255; i++) {
      assert.equal(seen.has(v), false, `repeat at exponent ${i}`);
      seen.add(v);
      v = gfMultiply(v, 2);
    }
    assert.equal(v, 1, "a^255 must wrap to 1");
    assert.equal(seen.size, 255);
  });
});

describe("Reed-Solomon", () => {
  it("generator polynomial vanishes at a^0..a^(t-1)", () => {
    for (const t of [7, 10, 13, 17, 22, 26, 30]) {
      const divisor = rsComputeDivisor(t);
      // g(x) = x^t + divisor[0]x^(t-1) + ... ; prepend the implicit leading 1.
      const g = [1, ...divisor];
      for (let i = 0; i < t; i++) {
        assert.equal(
          gfEvaluate(g, gfPow(2, i)),
          0,
          `g(a^${i}) should be 0 for t=${t}`,
        );
      }
    }
  });

  it("produces codewords with vanishing syndromes", () => {
    for (const t of [7, 10, 18, 28]) {
      const divisor = rsComputeDivisor(t);
      const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
      const ecc = rsComputeRemainder(data, divisor);
      assert.equal(ecc.length, t);
      assertValidRsCodeword([...data, ...ecc], t);
    }
  });

  it("rejects an out-of-range degree", () => {
    assert.throws(() => rsComputeDivisor(0), QrError);
    assert.throws(() => rsComputeDivisor(256), QrError);
  });
});

describe("capacity tables", () => {
  // Cross-check against the spec's published byte-mode maxima. These numbers
  // are independent of the tables in qrcode.ts, so a transcription slip in
  // ECC_CODEWORDS_PER_BLOCK / NUM_ECC_BLOCKS shows up here.
  it("matches the published version 1 capacities", () => {
    assert.equal(byteCapacity(1, "L"), 17);
    assert.equal(byteCapacity(1, "M"), 14);
    assert.equal(byteCapacity(1, "Q"), 11);
    assert.equal(byteCapacity(1, "H"), 7);
  });

  it("matches the published version 40 capacities", () => {
    assert.equal(byteCapacity(40, "L"), 2953);
    assert.equal(byteCapacity(40, "M"), 2331);
    assert.equal(byteCapacity(40, "Q"), 1663);
    assert.equal(byteCapacity(40, "H"), 1273);
  });

  it("matches published mid-range capacities", () => {
    assert.equal(byteCapacity(2, "M"), 26);
    assert.equal(byteCapacity(3, "M"), 42);
    // v7 is the first version with a 16-bit-free header but multiple blocks:
    // 156 data codewords at L, 124 at M.
    assert.equal(byteCapacity(7, "L"), 154);
    assert.equal(byteCapacity(7, "M"), 122);
    assert.equal(byteCapacity(10, "M"), 213);
    assert.equal(byteCapacity(27, "H"), 625);
  });

  it("raw codewords equal data + ECC for every version and level", () => {
    for (let v = 1; v <= MAX_VERSION; v++) {
      for (const ec of ["L", "M", "Q", "H"] as EcLevel[]) {
        const data = numDataCodewords(v, ec);
        assert.ok(data > 0, `v${v} ${ec} must have data capacity`);
        assert.ok(
          data < numRawDataModulesCodewords(v),
          `v${v} ${ec} must leave room for ECC`,
        );
      }
    }
  });

  it("capacity grows monotonically with version", () => {
    for (const ec of ["L", "M", "Q", "H"] as EcLevel[]) {
      for (let v = 2; v <= MAX_VERSION; v++) {
        assert.ok(
          byteCapacity(v, ec) > byteCapacity(v - 1, ec),
          `v${v} ${ec} should exceed v${v - 1}`,
        );
      }
    }
  });

  it("stronger EC never has more capacity", () => {
    for (let v = 1; v <= MAX_VERSION; v++) {
      assert.ok(byteCapacity(v, "L") >= byteCapacity(v, "M"));
      assert.ok(byteCapacity(v, "M") >= byteCapacity(v, "Q"));
      assert.ok(byteCapacity(v, "Q") >= byteCapacity(v, "H"));
    }
  });
});

describe("alignment patterns", () => {
  it("version 1 has none", () => {
    assert.deepEqual(alignmentPatternPositions(1), []);
  });

  it("known positions", () => {
    assert.deepEqual(alignmentPatternPositions(2), [6, 18]);
    assert.deepEqual(alignmentPatternPositions(7), [6, 22, 38]);
    assert.deepEqual(alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
  });

  it("count and bounds hold for every version", () => {
    for (let v = 2; v <= MAX_VERSION; v++) {
      const pos = alignmentPatternPositions(v);
      const size = v * 4 + 17;
      assert.equal(pos.length, Math.floor(v / 7) + 2, `count for v${v}`);
      assert.equal(pos[0], 6);
      assert.equal(pos[pos.length - 1], size - 7);
      for (let i = 1; i < pos.length; i++) {
        assert.ok(pos[i]! > pos[i - 1]!, `ascending for v${v}`);
      }
    }
  });
});

describe("symbol structure", () => {
  const qr = encodeQr("https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abc");

  it("is square with the right side length", () => {
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size);
    for (const row of qr.modules) assert.equal(row.length, qr.size);
  });

  it("draws all three finder patterns", () => {
    const centres: Array<[number, number]> = [
      [3, 3],
      [qr.size - 4, 3],
      [3, qr.size - 4],
    ];
    for (const [cx, cy] of centres) {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          assert.equal(
            qr.modules[cy + dy]![cx + dx],
            dist !== 2,
            `finder at (${cx},${cy}) offset (${dx},${dy})`,
          );
        }
      }
    }
  });

  it("keeps the separator ring light", () => {
    for (let i = 0; i <= 7; i++) {
      assert.equal(qr.modules[7]![i], false, `top-left separator row at ${i}`);
      assert.equal(qr.modules[i]![7], false, `top-left separator col at ${i}`);
    }
  });

  it("draws alternating timing patterns", () => {
    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(qr.modules[6]![i], i % 2 === 0, `h timing at ${i}`);
      assert.equal(qr.modules[i]![6], i % 2 === 0, `v timing at ${i}`);
    }
  });

  it("sets the always-dark module", () => {
    assert.equal(qr.modules[qr.size - 8]![8], true);
  });

  it("picks a mask in range", () => {
    assert.ok(qr.mask >= 0 && qr.mask <= 7);
  });
});

describe("round trip through an independent decoder", () => {
  const cases: Array<{ name: string; text: string; ec?: EcLevel }> = [
    { name: "short ascii", text: "hi" },
    { name: "single char", text: "a" },
    {
      name: "the real iLink scan link",
      text:
        "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=" +
        "AQAAAO8xZ2s2S2hZbFZ4dGpuTWs5OFRvUXc9PQ%3D%3D&bot_type=3",
    },
    { name: "utf-8 chinese", text: "扫码登录微信机器人：小铃" },
    { name: "mixed", text: "登录 https://a.example/x?y=1&z=2 #frag" },
    { name: "url with padding chars", text: "=".repeat(40) },
    { name: "exactly one codeword short", text: "x".repeat(13) },
    { name: "medium", text: "y".repeat(200) },
    { name: "large", text: "z".repeat(1200) },
    { name: "ec L", text: "level L payload", ec: "L" },
    { name: "ec Q", text: "level Q payload", ec: "Q" },
    { name: "ec H", text: "level H payload", ec: "H" },
  ];

  for (const c of cases) {
    it(`recovers ${c.name}`, () => {
      const qr = encodeQr(c.text, c.ec ? { ec: c.ec } : {});
      const decoded = decodeQr(qr);
      assert.equal(decoded.text, c.text);
      assert.equal(decoded.ec, c.ec ?? "M");
      assert.equal(decoded.mask, qr.mask);
    });
  }

  it("every ECC block is a valid Reed-Solomon codeword", () => {
    for (const [text, ec] of [
      ["hello", "M"],
      ["x".repeat(300), "M"],
      ["x".repeat(300), "L"],
      ["x".repeat(300), "H"],
    ] as Array<[string, EcLevel]>) {
      const qr = encodeQr(text, { ec });
      const { blocks } = decodeQr(qr);
      const t = ECC_PER_BLOCK[ec](qr.version) / blocks.length;
      for (const block of blocks) assertValidRsCodeword(block, t);
    }
  });

  it("survives every version that a forced minVersion can reach", () => {
    // Walk a sample of versions so multi-block, short/long-block, and
    // version-info (>= 7) code paths all get exercised.
    for (const v of [1, 2, 6, 7, 10, 14, 20, 27, 32, 40]) {
      const qr = encodeQr("payload-" + v, { minVersion: v });
      assert.equal(qr.version, v);
      assert.equal(decodeQr(qr).text, "payload-" + v);
    }
  });

  it("bumps the version when the payload does not fit", () => {
    const small = encodeQr("x".repeat(14));
    assert.equal(small.version, 1);
    const bigger = encodeQr("x".repeat(15));
    assert.equal(bigger.version, 2);
    assert.equal(decodeQr(bigger).text, "x".repeat(15));
  });
});

describe("version selection", () => {
  it("picks the smallest version that fits", () => {
    assert.equal(pickVersion(14, "M"), 1);
    assert.equal(pickVersion(15, "M"), 2);
    assert.equal(pickVersion(2953, "L"), 40);
    assert.equal(pickVersion(2954, "L"), null);
  });

  it("honours a minimum version", () => {
    assert.equal(pickVersion(1, "M", 9), 9);
  });

  it("throws on oversized payloads", () => {
    assert.throws(() => encodeQr("x".repeat(2954), { ec: "L" }), QrError);
    assert.throws(() => encodeQr("x".repeat(2332), { ec: "M" }), QrError);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 14 Chinese characters = 42 bytes, well past v1-M's 14-byte capacity.
    const qr = encodeQr("一二三四五六七八九十壹贰叁肆");
    assert.ok(qr.version >= 3, `expected >= v3, got v${qr.version}`);
    assert.equal(decodeQr(qr).text, "一二三四五六七八九十壹贰叁肆");
  });

  it("rejects a bad EC level", () => {
    assert.throws(
      () => encodeQr("x", { ec: "Z" as unknown as EcLevel }),
      QrError,
    );
  });
});

describe("interleaving invariants", () => {
  it("produces exactly the raw codeword count for every version/level", () => {
    for (const v of [1, 3, 5, 7, 13, 21, 33, 40]) {
      for (const ec of ["L", "M", "Q", "H"] as EcLevel[]) {
        const data = new Uint8Array(numDataCodewords(v, ec)).fill(0x42);
        const out = addEccAndInterleave(data, v, ec);
        assert.equal(out.length, numRawDataModulesCodewords(v), `v${v} ${ec}`);
      }
    }
  });

  it("rejects a wrong-sized data block", () => {
    assert.throws(() => addEccAndInterleave(new Uint8Array(3), 5, "M"), QrError);
  });
});

describe("SVG rendering", () => {
  const qr = encodeQr("https://example.test/login?ticket=abc123");

  it("wraps the symbol in a quiet zone", () => {
    const svg = renderQrSvg(qr, { border: 4 });
    const dim = qr.size + 8;
    assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`), svg.slice(0, 120));
  });

  it("honours a custom border", () => {
    const svg = renderQrSvg(qr, { border: 0 });
    assert.ok(svg.includes(`viewBox="0 0 ${qr.size} ${qr.size}"`));
  });

  it("emits a light background and a single dark path", () => {
    const svg = renderQrSvg(qr);
    assert.equal((svg.match(/<path /g) ?? []).length, 1);
    assert.ok(svg.includes('fill="#ffffff"'));
    assert.ok(svg.includes('fill="#000000"'));
  });

  it("merges horizontal runs instead of one shape per module", () => {
    const svg = renderQrSvg(qr);
    const moves = (svg.match(/M\d+ \d+h/g) ?? []).length;
    let darkModules = 0;
    for (const row of qr.modules) {
      for (const m of row) if (m) darkModules++;
    }
    assert.ok(
      moves < darkModules,
      `expected run merging: ${moves} runs vs ${darkModules} modules`,
    );
  });

  it("escapes the title", () => {
    const svg = renderQrSvg(qr, { title: '登录 <a> & "b"' });
    assert.ok(svg.includes("&lt;a&gt;"));
    assert.ok(svg.includes("&amp;"));
    assert.ok(svg.includes("&quot;"));
    assert.ok(!svg.includes("<a>"));
  });

  it("sets explicit pixel dimensions on the svg element only", () => {
    // The background <rect> always carries width/height, so inspect the opening
    // <svg> tag rather than the whole document.
    const openTag = (svg: string): string => svg.slice(0, svg.indexOf(">") + 1);
    assert.ok(
      openTag(renderQrSvg(qr, { pixelSize: 200 })).includes('width="200"'),
    );
    assert.ok(!openTag(renderQrSvg(qr)).includes("width="));
  });

  it("qrSvg is encode + render in one call", () => {
    assert.equal(qrSvg("abc"), renderQrSvg(encodeQr("abc")));
  });

  it("never leaks the payload into the markup", () => {
    // The whole point of local rendering: the ticket must not appear anywhere
    // a proxy or log could read it as text.
    const ticket = "SECRETTICKET123";
    const svg = qrSvg(`https://x.test/q?qrcode=${ticket}`);
    assert.ok(!svg.includes(ticket));
  });
});
