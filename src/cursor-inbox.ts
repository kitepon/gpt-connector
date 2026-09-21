import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chmodPrivateIfPosix, defaultConsultStateDirectory, ensurePrivateDirectory } from "./platform/state.js";

export type CursorInboxMessage = {
  readonly deliveryId: string;
  readonly conversationId: string;
  readonly slug: string;
  readonly text: string;
  readonly outcome: "succeeded" | "failed";
  readonly createdAt: string;
};

export type CursorClaimChannel = "hook" | "socket";

function cursorChatRoot(stateDirectory: string): string {
  return join(stateDirectory, "ch");
}

function bindPath(stateDirectory: string, deliveryId: string): string {
  return join(cursorChatRoot(stateDirectory), "bind", `${deliveryId}.json`);
}

function inboxDir(stateDirectory: string, conversationId: string): string {
  return join(cursorChatRoot(stateDirectory), "inbox", conversationId);
}

function inboxPath(stateDirectory: string, conversationId: string, deliveryId: string): string {
  return join(inboxDir(stateDirectory, conversationId), `${deliveryId}.json`);
}

function claimedPath(stateDirectory: string, deliveryId: string): string {
  return join(cursorChatRoot(stateDirectory), "claimed", `${deliveryId}.json`);
}

async function ensureCursorChatDirs(stateDirectory: string): Promise<void> {
  ensurePrivateDirectory(cursorChatRoot(stateDirectory));
  ensurePrivateDirectory(join(cursorChatRoot(stateDirectory), "bind"));
  ensurePrivateDirectory(join(cursorChatRoot(stateDirectory), "inbox"));
  ensurePrivateDirectory(join(cursorChatRoot(stateDirectory), "claimed"));
}

export async function bindCursorConversation(
  deliveryId: string,
  conversationId: string,
  slug: string,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<void> {
  await ensureCursorChatDirs(stateDirectory);
  const path = bindPath(stateDirectory, deliveryId);
  const body = JSON.stringify({ deliveryId, conversationId, slug, boundAt: new Date().toISOString() });
  await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
  await chmodPrivateIfPosix(path);
}

export async function readCursorBinding(
  deliveryId: string,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<{ conversationId: string; slug: string } | null> {
  try {
    const raw = JSON.parse(await readFile(bindPath(stateDirectory, deliveryId), "utf8")) as {
      conversationId?: unknown;
      slug?: unknown;
    };
    if (typeof raw.conversationId !== "string" || raw.conversationId.length === 0) return null;
    if (typeof raw.slug !== "string" || raw.slug.length === 0) return null;
    return { conversationId: raw.conversationId, slug: raw.slug };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCursorInbox(
  message: CursorInboxMessage,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<void> {
  await ensureCursorChatDirs(stateDirectory);
  const dir = inboxDir(stateDirectory, message.conversationId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = inboxPath(stateDirectory, message.conversationId, message.deliveryId);
  await writeFile(path, JSON.stringify(message), { encoding: "utf8", mode: 0o600 });
  await chmodPrivateIfPosix(path);
}

async function tryClaimPath(
  source: string,
  deliveryId: string,
  channel: CursorClaimChannel,
  stateDirectory: string,
): Promise<CursorInboxMessage | null> {
  const target = claimedPath(stateDirectory, deliveryId);
  try {
    await rename(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return null;
    throw error;
  }
  try {
    const message = JSON.parse(await readFile(target, "utf8")) as CursorInboxMessage;
    await writeFile(
      target,
      JSON.stringify({ ...message, claimedBy: channel, claimedAt: new Date().toISOString() }),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmodPrivateIfPosix(target);
    return message;
  } catch {
    return null;
  }
}

/** 受信箱から原子的に奪う。奪えた側だけが本文をエージェントへ出す。 */
export async function claimCursorInbox(
  conversationId: string,
  channel: CursorClaimChannel,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<CursorInboxMessage[]> {
  await ensureCursorChatDirs(stateDirectory);
  const dir = inboxDir(stateDirectory, conversationId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const claimed: CursorInboxMessage[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const deliveryId = name.slice(0, -".json".length);
    const message = await tryClaimPath(join(dir, name), deliveryId, channel, stateDirectory);
    if (message) claimed.push(message);
  }
  claimed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return claimed;
}

/** socket配送が勝った／負けたときのclaim。負けならnull。 */
export async function claimCursorDelivery(
  deliveryId: string,
  conversationId: string,
  channel: CursorClaimChannel,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<CursorInboxMessage | null> {
  await ensureCursorChatDirs(stateDirectory);
  return tryClaimPath(
    inboxPath(stateDirectory, conversationId, deliveryId),
    deliveryId,
    channel,
    stateDirectory,
  );
}

export async function discardCursorBinding(
  deliveryId: string,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<void> {
  try {
    await unlink(bindPath(stateDirectory, deliveryId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
