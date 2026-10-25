// One ordinary serializer. Observer frames reuse its exact text, never a second serialization.
export function serializePublicJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
export interface PublicJsonFrame { readonly text: string }
const frames = new WeakMap<PublicJsonFrame, { text: string; parsed: unknown }>();
export function createPublicJsonFrame(value: unknown): PublicJsonFrame {
  const text = serializePublicJson(value);
  let parsed: unknown;
  // One parse of the original serializer's output. Oversize frames need metadata only.
  if (Buffer.byteLength(text, "utf8") <= 65536) {
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  }
  const frame = Object.freeze({ text });
  frames.set(frame, { text, parsed });
  return frame;
}
export function readPublicJsonFrame(frame: PublicJsonFrame): { text: string; parsed: unknown } {
  const original = frames.get(frame);
  if (!original) throw new Error("core_frame_unowned");
  return { text: original.text, parsed: structuredClone(original.parsed) };
}
