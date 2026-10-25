// Unwired value codec for quolu/OL-RemoteWindow e3c7acd local v1. No IPC or authorization.
import { z } from "zod";

export class LocalHandoffCodecError extends Error {
  constructor() { super("HANDOFF_INVALID"); this.name = "LocalHandoffCodecError"; }
}
const invalid = (): never => { throw new LocalHandoffCodecError(); };
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uint32 = integer.max(4_294_967_295);
const hwnd = z.string().regex(/^[1-9]\d{0,19}$/u)
  .refine(value => BigInt(value) <= 18_446_744_073_709_551_615n);
const registration = z.string().regex(/^[a-f0-9]{32}$/u);
const opaque = z.string().min(1).max(128);
// Validate calendar/FILETIME range without rounding or replacing the original string.
const createdAt = z.string().refine(value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/u.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, fraction] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1601 || month < 1 || month > 12 || day < 1 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return value.slice(0, 19) > "1601-01-01T00:00:00" || /[1-9]/u.test(fraction ?? "");
});
const identity = z.object({ pid: uint32, createdAt, ownerSid: z.string().max(256).regex(/^S-[0-9]+(?:-[0-9]+)+$/u),
  sessionId: uint32, hwnd }).strict();
const watch = z.object({ watchId: opaque, hostRegistrationId: registration, expiresAt: integer, identity }).strict();
const binding = z.object({ identity, observedAt: integer, targetId: opaque, browserWindowId: integer }).strict();
const reference = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("watch"), watch }).strict(),
  z.object({ mode: z.literal("begin"), beginCallId: integer, hostRegistrationId: registration }).strict(),
]);
const header = { version: z.literal(1), callId: integer };
const requestSchema = z.discriminatedUnion("kind", [
  z.object({ ...header, kind: z.literal("begin_watch"), hint: hwnd, deadline: integer, hostRegistrationId: registration }).strict(),
  z.object({ ...header, kind: z.literal("assert_current"), watch, deadline: integer }).strict(),
  z.object({ ...header, kind: z.literal("bind_target"), watch, binding, deadline: integer }).strict(),
  z.object({ ...header, kind: z.literal("cancel_watch"), reference }).strict(),
]);
const replySchema = z.discriminatedUnion("outcome", [
  z.object({ ...header, outcome: z.literal("armed"), watch }).strict(),
  z.object({ ...header, outcome: z.literal("current"), watch }).strict(),
  z.object({ ...header, outcome: z.literal("bound"), watch }).strict(),
  z.object({ ...header, outcome: z.literal("cancelled"), reference }).strict(),
  z.object({ ...header, outcome: z.literal("error"), code: z.enum([
    "HOST_OFFLINE", "HANDOFF_INVALID", "HANDOFF_EXPIRED", "HANDOFF_BINDING_INVALID",
    "HANDOFF_UNSUPPORTED", "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED",
  ]), effect: z.enum(["none", "unknown"]) }).strict(),
]);
export type LocalWatchTuple = z.infer<typeof watch>;
export type LocalCancelReference = z.infer<typeof reference>;
export type LocalRequest = z.infer<typeof requestSchema>;
export type LocalReply = z.infer<typeof replySchema>;
// Shared value validation for the frame/control codec; no synthetic reserialization.
export const localWatchTupleSchema = watch;

// JSON.parse loses duplicate keys and number spelling. Parse this object/string/integer
// subset first, rejecting those wire ambiguities before schema validation.
function parseWire(input: string | Uint8Array): unknown {
  let source: string;
  try {
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > 4096 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) invalid();
      source = input;
    } else {
      if (input.byteLength > 4096) invalid();
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    }
    let cursor = 0;
    const space = () => { while (/[\x20\t\n\r]/u.test(source[cursor] ?? "x")) cursor++; };
    const string = (): string => {
      const start = cursor++;
      while (cursor < source.length) {
        const char = source[cursor++];
        if (char === "\\") { cursor++; continue; }
        if (char === '"') {
          const value: unknown = JSON.parse(source.slice(start, cursor));
          if (typeof value !== "string") return invalid();
          if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return invalid();
          return value;
        }
      }
      return invalid();
    };
    const value = (depth: number): unknown => {
      space();
      if (source[cursor] === '"') return string();
      if (source[cursor] === "{") {
        if (depth > 8) invalid();
        cursor++; space();
        const record: Record<string, unknown> = Object.create(null);
        if (source[cursor] === "}") { cursor++; return record; }
        while (cursor < source.length) {
          space(); if (source[cursor] !== '"') invalid();
          const key = string();
          if (Object.hasOwn(record, key)) invalid();
          space(); if (source[cursor++] !== ":") invalid();
          record[key] = value(depth + 1); space();
          const delimiter = source[cursor++];
          if (delimiter === "}") return record;
          if (delimiter !== ",") invalid();
        }
        return invalid();
      }
      const match = /^[1-9][0-9]*/u.exec(source.slice(cursor));
      if (!match) return invalid();
      cursor += match[0].length;
      const number = Number(match[0]);
      if (!Number.isSafeInteger(number)) invalid();
      return number;
    };
    const parsed = value(1); space();
    if (cursor !== source.length) invalid();
    return parsed;
  } catch { return invalid(); }
}
export const decodeLocalJsonValue = (input: string | Uint8Array): unknown => parseWire(input);
function decode<T>(schema: z.ZodType<T>, input: string | Uint8Array): T {
  const parsed = schema.safeParse(parseWire(input));
  return parsed.success ? parsed.data : invalid();
}
function encode<T>(schema: z.ZodType<T>, value: unknown): string {
  try {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return invalid();
    // Also enforce size and lexical restrictions on output, not only on input.
    const bytes = JSON.stringify(parsed.data);
    decode(schema, bytes);
    return bytes;
  } catch { return invalid(); }
}
export const decodeLocalRequest = (input: string | Uint8Array): LocalRequest => decode(requestSchema, input);
export const decodeLocalReply = (input: string | Uint8Array): LocalReply => decode(replySchema, input);
export const encodeLocalRequest = (value: unknown): string => encode(requestSchema, value);
export const encodeLocalReply = (value: unknown): string => encode(replySchema, value);
