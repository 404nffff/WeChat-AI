import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hourInTimeZone,
  isInQuietHours,
  isProactiveEligible,
  mergeBotProactiveConfig,
  parseQuietHours,
} from "./proactive.js";
import { parseProactiveSkip, buildProactiveInstruction } from "./prompt.js";

describe("parseQuietHours / isInQuietHours", () => {
  it("parses daytime window", () => {
    assert.deepEqual(parseQuietHours("0-8"), { start: 0, end: 8 });
    assert.equal(isInQuietHours(3, { start: 0, end: 8 }), true);
    assert.equal(isInQuietHours(8, { start: 0, end: 8 }), false);
    assert.equal(isInQuietHours(12, { start: 0, end: 8 }), false);
  });

  it("parses overnight window", () => {
    assert.deepEqual(parseQuietHours("22-6"), { start: 22, end: 6 });
    assert.equal(isInQuietHours(23, { start: 22, end: 6 }), true);
    assert.equal(isInQuietHours(3, { start: 22, end: 6 }), true);
    assert.equal(isInQuietHours(10, { start: 22, end: 6 }), false);
  });

  it("treats empty as disabled", () => {
    assert.equal(parseQuietHours(""), null);
    assert.equal(parseQuietHours(null), null);
    assert.equal(parseQuietHours("0-0"), null);
  });
});

describe("isProactiveEligible", () => {
  const fixedNow = new Date("2026-07-20T12:00:00+08:00");
  const base = {
    botStatus: "active",
    botProactiveEnabled: 1,
    peerApproved: 1,
    peerProactiveEnabled: 1,
    hasContextToken: true,
    // 20h idle relative to fixedNow
    lastActivityAt: new Date("2026-07-19T16:00:00+08:00").toISOString(),
    dayCount: 0,
    idleHours: 12,
    minIntervalHours: 24,
    maxPerDay: 1,
    quietHours: "",
    now: fixedNow,
    quietTimeZone: "Asia/Shanghai",
    attemptCooldownHours: 1,
  };

  it("allows idle approved peer", () => {
    const r = isProactiveEligible(base);
    assert.equal(r.ok, true);
    assert.ok((r.idleHoursActual ?? 0) >= 12);
  });

  it("rejects when peer off", () => {
    const r = isProactiveEligible({ ...base, peerProactiveEnabled: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "peer_off");
  });

  it("rejects when not idle", () => {
    const r = isProactiveEligible({
      ...base,
      lastActivityAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      now: new Date(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_idle");
  });

  it("rejects day cap", () => {
    const r = isProactiveEligible({ ...base, dayCount: 1, maxPerDay: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "day_cap");
  });

  it("allows unlimited day when maxPerDay is 0", () => {
    const r = isProactiveEligible({ ...base, dayCount: 99, maxPerDay: 0 });
    assert.equal(r.ok, true);
  });

  it("allows zero min interval", () => {
    const r = isProactiveEligible({
      ...base,
      minIntervalHours: 0,
      lastProactiveAt: new Date(Date.now() - 60 * 1000).toISOString(),
      now: new Date(),
      attemptCooldownHours: 0,
    });
    assert.equal(r.ok, true);
  });

  it("rejects quiet hours", () => {
    // 3am Shanghai
    const r = isProactiveEligible({
      ...base,
      quietHours: "0-8",
      now: new Date("2026-07-20T03:00:00+08:00"),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quiet_hours");
  });

  it("rejects min interval after last proactive", () => {
    const r = isProactiveEligible({
      ...base,
      lastProactiveAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      now: new Date(),
      minIntervalHours: 24,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "min_interval");
  });

  it("rejects no context token", () => {
    const r = isProactiveEligible({ ...base, hasContextToken: false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_context_token");
  });
});

describe("mergeBotProactiveConfig", () => {
  it("falls back to defaults", () => {
    const m = mergeBotProactiveConfig(
      {},
      {
        idleHours: 12,
        minIntervalHours: 24,
        maxPerDay: 1,
        quietHours: "0-8",
      },
    );
    assert.equal(m.enabled, false);
    assert.equal(m.idleHours, 12);
    assert.equal(m.quietHours, "0-8");
  });

  it("uses bot overrides", () => {
    const m = mergeBotProactiveConfig(
      {
        proactive_enabled: 1,
        proactive_idle_hours: 6,
        proactive_quiet_hours: "",
      },
      {
        idleHours: 12,
        minIntervalHours: 24,
        maxPerDay: 1,
        quietHours: "0-8",
      },
    );
    assert.equal(m.enabled, true);
    assert.equal(m.idleHours, 6);
    assert.equal(m.quietHours, "");
  });

  it("null quiet hours means disabled (not default)", () => {
    const m = mergeBotProactiveConfig(
      { proactive_quiet_hours: null },
      {
        idleHours: 12,
        minIntervalHours: 24,
        maxPerDay: 1,
        quietHours: "0-8",
      },
    );
    assert.equal(m.quietHours, "");
  });
});

describe("parseProactiveSkip", () => {
  it("detects skip json", () => {
    const r = parseProactiveSkip('{"skip":true,"reason":"休息"}');
    assert.equal(r.skip, true);
    assert.equal(r.reason, "休息");
  });

  it("does not skip normal messages json", () => {
    const r = parseProactiveSkip('{"messages":["嗨～"]}');
    assert.equal(r.skip, false);
  });
});

describe("buildProactiveInstruction", () => {
  it("includes idle hours", () => {
    const s = buildProactiveInstruction(12.3);
    assert.match(s, /12\.3/);
    assert.match(s, /主动发起对话/);
  });
});

describe("hourInTimeZone", () => {
  it("returns a valid hour", () => {
    const h = hourInTimeZone(new Date("2026-07-20T04:00:00Z"), "UTC");
    assert.equal(h, 4);
  });
});
