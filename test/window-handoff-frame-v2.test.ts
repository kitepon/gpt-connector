import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FrameV2Decoder, LocalFrameV2 } from "../src/window-handoff-frame-v2.js";
import type { FrameDirection, FrameTag, FrameWait } from "../src/window-handoff-frame-v2.js";
import { decodeLocalReply, encodeLocalReply } from "../src/window-handoff-local-codec.js";
const bytes = readFileSync(new URL("./fixtures/window-handoff-frame-v2-synthetic.json", import.meta.url));
const fixture = JSON.parse(bytes.toString("utf8")) as { frames: { tag: FrameTag; frameBase64: string; originalBodyBase64: string }[]; rollbackCleanupFrameBase64: string };
const domain = {}, point = (rawUtcMs = 1000, monotonicMs = 0) => ({ rawUtcMs, monotonicMs, domain });
const lane = (tag: number): FrameDirection => [1, 3, 16].includes(tag) ? "client_to_host" : "host_to_client";
const frameBytes = (index: number) => new Uint8Array(Buffer.from(fixture.frames[index]!.frameBase64, "base64"));
function decoded(index: number) { return new FrameV2Decoder(lane(fixture.frames[index]!.tag)).feed(frameBytes(index), point())[0]!; }

test("fixed Windows v2 Encode fixture is same bytes and all frames preserve original body/headers", () => {
  assert.equal(bytes.byteLength, 4607); assert.equal(createHash("sha256").update(bytes).digest("hex"), "65f4ba4a40f741a34c890bd0bf5ef5b472441f0435bae2c5454c21952bc74ae3");
  fixture.frames.forEach((f, index) => {
    const result = decoded(index);
    assert.deepEqual(result.encode(), frameBytes(index));
    assert.deepEqual(Buffer.from(result.bodySnapshot()), Buffer.from(f.originalBodyBase64, "base64"));
  });
});

test("every byte split, one-byte feeds, concatenation and original-buffer mutation retain owned snapshots", () => {
  fixture.frames.forEach((f, index) => {
    const original = frameBytes(index), body = Buffer.from(f.originalBodyBase64, "base64");
    for (let split = 0; split <= original.byteLength; split++) {
      const decoder = new FrameV2Decoder(lane(f.tag)), first = original.slice(0, split), second = original.slice(split);
      const out = decoder.feed(first, point()); first.fill(0);
      out.push(...decoder.feed(second, point())); second.fill(0);
      assert.equal(out.length, 1); assert.deepEqual(Buffer.from(out[0]!.bodySnapshot()), body);
      const exposed = out[0]!.bodySnapshot(); exposed.fill(0); assert.deepEqual(Buffer.from(out[0]!.bodySnapshot()), body);
    }
    const decoder = new FrameV2Decoder(lane(f.tag)); let count = 0;
    for (const byte of original) count += decoder.feed(Uint8Array.of(byte), point()).length;
    assert.equal(count, 1);
  });
  for (const direction of ["client_to_host", "host_to_client"] as const) {
    const frames = fixture.frames.filter(f => lane(f.tag) === direction);
    const combined = Buffer.concat(frames.map(f => Buffer.from(f.frameBase64, "base64")));
    assert.deepEqual(new FrameV2Decoder(direction).feed(combined, point()).map(f => f.tag), frames.map(f => f.tag));
  }
});

test("raw RPC whitespace and split multibyte UTF8 are preserved without reserialization", () => {
  const original = decoded(6).bodySnapshot(), reply = decodeLocalReply(original);
  assert.equal(reply.outcome, "armed"); if (reply.outcome !== "armed") return;
  reply.watch.watchId = "月";
  const body = new TextEncoder().encode(` \n${encodeLocalReply(reply)}\t `);
  const source = new LocalFrameV2(17, body, null, "host_to_client").encode();
  const decoder = new FrameV2Decoder("host_to_client");
  let frames: LocalFrameV2[] = [];
  for (const byte of source) frames = frames.concat(decoder.feed(Uint8Array.of(byte), point()));
  assert.equal(frames.length, 1); assert.deepEqual(frames[0]!.bodySnapshot(), body);
});

test("strict tags/direction/header Wait/purpose/length and body-purpose binding reject before reuse", () => {
  const invalidHeaders: ((input: Uint8Array) => void)[] = [
    b => { b[2] = 1; }, b => { b[3] = 99; }, b => { new DataView(b.buffer).setUint32(4, 4097, true); },
    b => { new DataView(b.buffer).setUint32(4, 0, true); }, b => { new DataView(b.buffer).setBigUint64(8, 9007199254740992n, true); },
    b => { new DataView(b.buffer).setUint32(16, 0, true); }, b => { b[20] = 0; }, b => { b[20] = 9; },
    b => { b[20] = 2; new DataView(b.buffer).setUint32(16, 30001, true); },
  ];
  for (const change of invalidHeaders) {
    const bad = frameBytes(4); change(bad); const decoder = new FrameV2Decoder("client_to_host");
    assert.throws(() => decoder.feed(bad.subarray(0, 21), point())); assert.equal(decoder.sealed, true);
    assert.throws(() => decoder.feed(frameBytes(4), point()));
  }
  assert.throws(() => new FrameV2Decoder("host_to_client").feed(frameBytes(4), point()));
  const cancel = frameBytes(5); cancel[20] = 1;
  assert.throws(() => new FrameV2Decoder("client_to_host").feed(cancel, point()));
  const hello = frameBytes(0); hello[20] = 1;
  assert.throws(() => new FrameV2Decoder("client_to_host").feed(hello, point()));
  const requestBody = decoded(4).bodySnapshot();
  assert.throws(() => new LocalFrameV2(16, requestBody, { purpose: "request", absoluteDeadline: 121001, maximumWaitMs: 1 }, "client_to_host"));
});

test("invalid UTF8, duplicate/extra JSON fields and tag-body mismatch seal without returning a valid prefix", () => {
  const hello = decoded(0).bodySnapshot();
  for (const body of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{"version":1,"version":1,"capability":"window_handoff_local_v1"}'),
    new TextEncoder().encode('{"version":1e0,"capability":"window_handoff_local_v1"}'),
    new TextEncoder().encode('{"version":1,"capability":"window_handoff_local_v1","signal":true}')])
    assert.throws(() => new LocalFrameV2(1, body, null, "client_to_host"));
  assert.throws(() => new LocalFrameV2(32, hello, null, "host_to_client"));
  const valid = frameBytes(0), bad = frameBytes(2); bad[2] = 1;
  const decoder = new FrameV2Decoder("client_to_host");
  assert.throws(() => decoder.feed(Buffer.concat([valid, bad]), point())); assert.equal(decoder.sealed, true);
});

test("all partial header observations including empty feeds retain forward expiry/domain/order failure", () => {
  const original = frameBytes(5);
  for (let count = 1; count < 21; count++) {
    const decoder = new FrameV2Decoder("client_to_host"); decoder.feed(original.slice(0, count), point());
    decoder.feed(new Uint8Array(), point(2001, 1));
    assert.throws(() => decoder.feed(original.slice(count), point(1000, 2)), { code: "HANDOFF_EXPIRED" });
    assert.equal(decoder.sealed, true);
  }
  for (const invalid of [{ ...point(), domain: {} }, point(1000, -1), { ...point(), rawUtcMs: NaN }]) {
    const decoder = new FrameV2Decoder("client_to_host"); decoder.feed(original.slice(0, 1), point(1000, 1));
    assert.throws(() => decoder.feed(new Uint8Array(), invalid)); assert.equal(decoder.sealed, true);
  }
});

test("first header byte owns cap elapsed time and dispatch budget cannot revive after expiry", () => {
  const original = frameBytes(5), decoder = new FrameV2Decoder("client_to_host");
  decoder.feed(original.slice(0, 1), point(1000, 0));
  const frame = decoder.feed(original.slice(1), point(900, 100))[0]!;
  assert.equal(frame.remaining(point(900, 100)), 150);
  assert.throws(() => frame.remaining(point(2001, 101)), { code: "HANDOFF_EXPIRED" });
  assert.throws(() => frame.remaining(point(900, 102)), { code: "HANDOFF_EXPIRED" });
  const exhausted = new FrameV2Decoder("client_to_host"); exhausted.feed(original.slice(0, 1), point());
  assert.throws(() => exhausted.feed(original.slice(1, 21), point(900, 250)), { code: "HANDOFF_EXPIRED" });
  const bodyPending = new FrameV2Decoder("client_to_host"); bodyPending.feed(original.slice(0, 22), point());
  assert.throws(() => bodyPending.feed(new Uint8Array(), point(2000, 10)), { code: "HANDOFF_EXPIRED" });
  assert.throws(() => bodyPending.feed(original.slice(22), point(1000, 11)));
  const fractional = new FrameV2Decoder("client_to_host").feed(original, point())[0]!;
  assert.throws(() => fractional.remaining(point(1000, 249.5)), { code: "HANDOFF_EXPIRED" });
});

test("per-frame raw peak resets for a new cleanup; body bound and EOF/version terminal are strict", () => {
  const hello = frameBytes(0), cleanup = new Uint8Array(Buffer.from(fixture.rollbackCleanupFrameBase64, "base64"));
  const decoder = new FrameV2Decoder("client_to_host"); decoder.feed(hello, point(10000, 100));
  const frame = decoder.feed(cleanup, point(5000, 1101))[0]!;
  assert.equal(frame.remaining(point(5000, 1101)), 250);
  const body = new Uint8Array(4096); body.fill(32); body.set(decoded(0).bodySnapshot());
  assert.equal(new LocalFrameV2(1, body, null, "client_to_host").encode().byteLength, 4117);
  assert.throws(() => new LocalFrameV2(1, new Uint8Array(4097), null, "client_to_host"));
  decoder.endOfInput(); assert.equal(decoder.sealed, true); assert.throws(() => decoder.feed(hello, point(5000, 1102)));
  const partial = new FrameV2Decoder("client_to_host"); partial.feed(hello.slice(0, 3), point()); assert.throws(() => partial.endOfInput());
  const wait: FrameWait = { purpose: "cleanup", absoluteDeadline: 2000, maximumWaitMs: 250 };
  const owned = new LocalFrameV2(16, decoded(5).bodySnapshot(), wait, "client_to_host"); Object.assign(wait, { absoluteDeadline: 99999 });
  assert.equal(owned.wait!.absoluteDeadline, 2000);
});
