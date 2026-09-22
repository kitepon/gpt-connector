// Linuxの表示制御。製品専用ChromeのX11 windowだけを対象にし、CDPのwindowStateは正本にしない。
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";

const x11Viewable = 2;

interface Waiter { readonly resolve: (packet: Buffer) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout; }

export function mapStateFromAttributesReply(packet: Buffer): number {
  // xGetWindowAttributesReply は saveUnder の次に mapInstalled を置く。mapState は offset 26。
  if (packet.length < 27 || packet[0] !== 1) throw new Error("X11 window属性の応答が不正です");
  return packet[26] ?? 0;
}

export class LinuxX11 {
  private readonly pending = new Map<number, Waiter>();
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private resource = 0;
  private constructor(private readonly socket: Socket, private readonly root: number, private readonly idBase: number, private readonly idMask: number) {}

  static async connect(env: NodeJS.ProcessEnv = process.env): Promise<LinuxX11> {
    const display = env.DISPLAY ?? "";
    const spec = displaySocket(display);
    const cookie = magicCookie(env.XAUTHORITY || `${env.HOME ?? homedir()}/.Xauthority`, spec.number);
    const socket = connect(spec.path);
    socket.setNoDelay(true);
    const setup = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const fail = (error: Error) => { socket.destroy(); reject(error); };
      const timer = setTimeout(() => fail(new Error("X11接続がtimeoutしました")), 2_000);
      socket.on("error", fail);
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        if (all.length < 8) return;
        const extra = all.readUInt16LE(6) * 4;
        if (all.length < 8 + extra) return;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        if (all[0] !== 1) { socket.destroy(); reject(new Error("X11の接続認証に失敗しました")); return; }
        resolve(all);
      });
      socket.write(connectionRequest(cookie));
    });
    const extra = setup.readUInt16LE(6) * 4;
    const vendorLength = setup.readUInt16LE(24);
    const formats = setup[29] ?? 0;
    const screen = 40 + pad4(vendorLength) + formats * 8;
    const displayClient = new LinuxX11(socket, setup.readUInt32LE(screen), setup.readUInt32LE(12), setup.readUInt32LE(16));
    displayClient.enqueue(setup.subarray(8 + extra));
    socket.on("data", (chunk) => displayClient.enqueue(chunk));
    socket.on("error", (error) => displayClient.rejectAll(error));
    return displayClient;
  }

  private enqueue(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consume();
  }

  async googleChromeWindows(pid: number): Promise<readonly { readonly id: number; readonly viewable: boolean }[]> {
    const listed = await this.matchingWindows(await this.clientList(), pid);
    if (listed.length > 0) return listed;
    return this.matchingWindows(await this.nearbyWindows(), pid);
  }

  private async matchingWindows(candidates: readonly number[], pid: number): Promise<readonly { readonly id: number; readonly viewable: boolean }[]> {
    const atoms = await this.atoms(["_NET_WM_PID", "WM_CLASS"]);
    const windows = [];
    for (const id of candidates) {
      try {
        const owner = await this.propertyCard(id, atoms._NET_WM_PID);
        const klass = wmClass(await this.propertyBytes(id, atoms.WM_CLASS));
        if (owner !== pid || klass !== "Google-chrome") continue;
        windows.push({ id, viewable: await this.viewable(id) });
      } catch { /* 列挙中に消えたwindowは対象外 */ }
    }
    return windows;
  }

  unmap(id: number): Promise<void> { return this.send(simpleRequest(10, id), false).then(() => undefined); }
  map(id: number): Promise<void> { return this.send(simpleRequest(8, id), false).then(() => undefined); }
  async activate(id: number): Promise<void> {
    const active = (await this.atoms(["_NET_ACTIVE_WINDOW"]))._NET_ACTIVE_WINDOW;
    const event = Buffer.alloc(32);
    event[0] = 33; event[1] = 32; event.writeUInt32LE(id, 4); event.writeUInt32LE(active, 8); event.writeUInt32LE(1, 12);
    const request = Buffer.alloc(44);
    request[0] = 25; request.writeUInt16LE(11, 2); request.writeUInt32LE(this.root, 4); request.writeUInt32LE(0x180000, 8); event.copy(request, 12);
    await this.send(request, false);
  }

  async createProbeWindow(pid: number): Promise<number> {
    const id = this.allocate();
    const atoms = await this.atoms(["_NET_WM_PID", "WM_CLASS", "CARDINAL", "STRING"]);
    await this.send(createWindow(id, this.root), false);
    await this.send(changeProperty(id, atoms._NET_WM_PID, atoms.CARDINAL, 32, uint32(pid)), false);
    await this.send(changeProperty(id, atoms.WM_CLASS, atoms.STRING, 8, Buffer.from("google-chrome\0Google-chrome\0")), false);
    await this.map(id);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await this.googleChromeWindows(pid)).some((window) => window.id === id && window.viewable)) return id;
      await delay(50);
    }
    throw new Error("X11の確認windowを表示できません");
  }

  destroy(id: number): Promise<void> { return this.send(simpleRequest(4, id), false).then(() => undefined); }

  close(): void {
    this.rejectAll(new Error("X11接続を閉じました"));
    this.socket.end();
    this.socket.destroy();
  }

  private allocate(): number {
    const id = (this.idBase + this.resource) >>> 0;
    this.resource += 1;
    if ((id & ~this.idMask) >>> 0 !== (this.idBase & ~this.idMask) >>> 0) throw new Error("X11 resource IDを確保できません");
    return id;
  }

  private async atoms(names: readonly string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const name of names) result[name] = await this.intern(name);
    return result;
  }

  private async intern(name: string): Promise<number> {
    const bytes = Buffer.from(name);
    const request = Buffer.alloc(8 + pad4(bytes.length));
    request[0] = 16; request.writeUInt16LE(request.length / 4, 2); request.writeUInt16LE(bytes.length, 4); bytes.copy(request, 8);
    return (await this.send(request, true)).readUInt32LE(8);
  }

  private async clientList(): Promise<readonly number[]> {
    const atom = await this.intern("_NET_CLIENT_LIST");
    const data = await this.propertyBytes(this.root, atom);
    const ids = [];
    if (data) for (let offset = 0; offset + 4 <= data.length; offset += 4) ids.push(data.readUInt32LE(offset));
    return ids;
  }

  private async nearbyWindows(): Promise<readonly number[]> {
    const seen = new Set<number>([this.root]);
    const queue = [this.root];
    const found: number[] = [];
    while (queue.length > 0 && seen.size < 200) {
      const window = queue.shift();
      if (window === undefined) break;
      let children: readonly number[] = [];
      try { children = await this.queryTree(window); } catch { continue; }
      for (const child of children) {
        if (seen.has(child)) continue;
        seen.add(child); found.push(child);
        if (seen.size < 200) queue.push(child);
      }
    }
    return found;
  }

  private async queryTree(window: number): Promise<readonly number[]> {
    const reply = await this.send(simpleRequest(15, window), true);
    const count = reply.readUInt16LE(16);
    const children = [];
    for (let index = 0; index < count; index += 1) children.push(reply.readUInt32LE(32 + index * 4));
    return children;
  }

  private async propertyBytes(window: number, atom: number): Promise<Buffer | undefined> {
    const request = Buffer.alloc(24);
    request[0] = 20; request.writeUInt16LE(6, 2); request.writeUInt32LE(window, 4); request.writeUInt32LE(atom, 8);
    request.writeUInt32LE(0, 12); request.writeUInt32LE(0, 16); request.writeUInt32LE(1024, 20);
    const reply = await this.send(request, true);
    if (reply.readUInt32LE(8) === 0) return undefined;
    const format = reply[1] ?? 0;
    const count = reply.readUInt32LE(16);
    const bytes = format === 32 ? count * 4 : format === 16 ? count * 2 : count;
    return reply.subarray(32, 32 + bytes);
  }

  private async propertyCard(window: number, atom: number): Promise<number | undefined> {
    const data = await this.propertyBytes(window, atom);
    return data && data.length >= 4 ? data.readUInt32LE(0) : undefined;
  }

  private async viewable(id: number): Promise<boolean> {
    try { return mapStateFromAttributesReply(await this.send(simpleRequest(3, id), true)) === x11Viewable; }
    catch { return false; }
  }

  private send(packet: Buffer, reply: true): Promise<Buffer>;
  private send(packet: Buffer, reply: false): Promise<Buffer>;
  private send(packet: Buffer, reply: boolean): Promise<Buffer> {
    this.sequence = (this.sequence + 1) & 0xffff;
    const sequence = this.sequence;
    const result = reply ? new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(sequence); reject(new Error("X11応答がtimeoutしました")); }, 2_000);
      this.pending.set(sequence, { resolve, reject, timer });
    }) : Promise.resolve(Buffer.alloc(0));
    this.socket.write(packet);
    return result;
  }

  private consume(): void {
    while (this.buffer.length >= 32) {
      const type = this.buffer[0];
      const size = type === 1 || type === 35 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32;
      if (this.buffer.length < size) return;
      const packet = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      if (type !== 0 && type !== 1) continue;
      const sequence = packet.readUInt16LE(2);
      const waiter = this.pending.get(sequence);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.pending.delete(sequence);
      if (type === 0) waiter.reject(new Error(`X11 error ${packet[1]}`));
      else waiter.resolve(packet);
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
}

function displaySocket(display: string): { readonly path: string; readonly number: string } {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display) ?? /^(?:localhost|127\.0\.0\.1):(\d+)(?:\.\d+)?$/.exec(display);
  if (!match?.[1]) throw new Error("Linuxの専用ChromeはローカルX11のDISPLAYが必要です。");
  return { path: `/tmp/.X11-unix/X${match[1]}`, number: match[1] };
}

function magicCookie(path: string, displayNumber: string): Buffer {
  let file: Buffer;
  try { file = readFileSync(path); } catch (cause) { throw new Error("X11の認証情報を読めませんでした。", { cause }); }
  let offset = 0;
  while (offset + 4 <= file.length) {
    offset += 2;
    const addressLength = file.readUInt16BE(offset); offset += 2 + addressLength;
    const numberLength = file.readUInt16BE(offset); offset += 2;
    const number = file.subarray(offset, offset + numberLength).toString(); offset += numberLength;
    const nameLength = file.readUInt16BE(offset); offset += 2;
    const name = file.subarray(offset, offset + nameLength).toString(); offset += nameLength;
    const dataLength = file.readUInt16BE(offset); offset += 2;
    const data = file.subarray(offset, offset + dataLength); offset += dataLength;
    if (number === displayNumber && name === "MIT-MAGIC-COOKIE-1") return Buffer.from(data);
  }
  throw new Error("X11の認証情報を読めませんでした。");
}

function connectionRequest(cookie: Buffer): Buffer {
  const name = Buffer.from("MIT-MAGIC-COOKIE-1");
  const request = Buffer.alloc(12 + pad4(name.length) + pad4(cookie.length));
  request[0] = 0x6c; request.writeUInt16LE(11, 2); request.writeUInt16LE(name.length, 6); request.writeUInt16LE(cookie.length, 8);
  name.copy(request, 12); cookie.copy(request, 12 + pad4(name.length));
  return request;
}

function simpleRequest(opcode: number, window: number): Buffer {
  const request = Buffer.alloc(8);
  request[0] = opcode; request.writeUInt16LE(2, 2); request.writeUInt32LE(window, 4);
  return request;
}

function createWindow(id: number, parent: number): Buffer {
  const request = Buffer.alloc(32);
  request[0] = 1;
  request.writeUInt16LE(8, 2);
  request.writeUInt32LE(id, 4);
  request.writeUInt32LE(parent, 8);
  request.writeInt16LE(40, 12);
  request.writeInt16LE(40, 14);
  request.writeUInt16LE(320, 16);
  request.writeUInt16LE(200, 18);
  return request;
}

function changeProperty(window: number, property: number, type: number, format: 8 | 32, data: Buffer): Buffer {
  const payload = Buffer.alloc(pad4(data.length));
  data.copy(payload);
  const request = Buffer.alloc(24 + payload.length);
  request[0] = 18; request.writeUInt16LE(request.length / 4, 2); request.writeUInt32LE(window, 4); request.writeUInt32LE(property, 8);
  request.writeUInt32LE(type, 12); request[16] = format; request.writeUInt32LE(format === 32 ? data.length / 4 : data.length, 20); payload.copy(request, 24);
  return request;
}

function uint32(value: number): Buffer { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; }
function wmClass(data: Buffer | undefined): string { return data?.toString("latin1").split("\0").filter((part) => part.length > 0)[1] ?? ""; }
function pad4(size: number): number { return (size + 3) & ~3; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
