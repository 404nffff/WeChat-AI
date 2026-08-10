import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  previewText,
  redactRedisKey,
  ActivityBus,
} from "./activity-stream.js";

describe("previewText", () => {
  it("keeps short text", () => {
    const r = previewText("hello", 48);
    assert.equal(r.preview, "hello");
    assert.equal(r.len, 5);
    assert.equal(r.truncated, false);
  });

  it("truncates long text", () => {
    const s = "a".repeat(100);
    const r = previewText(s, 48);
    assert.equal(r.len, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.preview.endsWith("…"));
    assert.equal(r.preview.length, 49);
  });
});

describe("redactRedisKey", () => {
  it("redacts creds keys", () => {
    assert.equal(
      redactRedisKey("wa:bot:abc:creds"),
      "wa:bot:abc:*",
    );
  });

  it("passes normal keys", () => {
    assert.equal(redactRedisKey("wa:msgs:b1:p1"), "wa:msgs:b1:p1");
  });
});

describe("ActivityBus", () => {
  it("rings and rate-limits", () => {
    const fakeDb = {
      redis: {
        duplicate: () => ({
          on() {},
          subscribe: async () => {},
          unsubscribe: async () => {},
          disconnect() {},
        }),
        pipeline: () => ({
          lpush() {
            return this;
          },
          ltrim() {
            return this;
          },
          publish() {
            return this;
          },
          exec: async () => [],
        }),
        publish: async () => 0,
        lrange: async () => [],
      },
    } as any;

    const bus = new ActivityBus({
      db: fakeDb,
      source: "test",
      enabled: true,
      maxEps: 5,
      ringSize: 10,
      redisSample: 0,
    });

    const got: string[] = [];
    bus.subscribe((ev) => got.push(ev.type));

    for (let i = 0; i < 10; i++) {
      bus.emit({ type: "worker.job", summary: `n=${i}` }, { fleet: false, persist: false });
    }
    const jobs = got.filter((t) => t === "worker.job");
    assert.equal(jobs.length, 5);
    // optional stream.dropped summary when over cap
    assert.ok(got.length >= 5 && got.length <= 6);
    assert.equal(
      bus.recentLocal(20).filter((e) => e.type === "worker.job").length,
      5,
    );

    // redis samples stay local path
    bus.noteRedisCmd({ op: "get", key: "wa:user:1", ms: 2, ok: true });
    // sample may or may not fire (random); just ensure no throw
  });
});
