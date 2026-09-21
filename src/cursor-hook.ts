import { z } from "zod";

import {
  bindCursorConversation,
  claimCursorInbox,
} from "./cursor-inbox.js";
import { defaultConsultStateDirectory } from "./platform/state.js";

const commonSchema = z.object({
  hook_event_name: z.string().min(1),
  conversation_id: z.string().min(1).optional(),
}).passthrough();

const afterMcpSchema = commonSchema.extend({
  hook_event_name: z.literal("afterMCPExecution"),
  tool_name: z.string(),
  tool_input: z.union([z.string(), z.record(z.string(), z.unknown())]),
  mcp_server_name: z.string().optional(),
  result_json: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

const postToolSchema = commonSchema.extend({
  hook_event_name: z.enum(["postToolUse", "postToolUseFailure"]),
  tool_name: z.string().optional(),
  tool_input: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

function parseJsonValue(value: string | Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractConsultSnapshot(resultJson: unknown): {
  deliveryId: string;
  slug: string;
} | null {
  if (resultJson === null || typeof resultJson !== "object") return null;
  const root = resultJson as Record<string, unknown>;
  let candidate: unknown = root;
  if (Array.isArray(root.content)) {
    const text = root.content.find(
      (entry): entry is { type: string; text: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    );
    if (text) candidate = parseJsonValue(text.text);
  }
  if (candidate === null || typeof candidate !== "object") return null;
  const snap = candidate as Record<string, unknown>;
  const delivery = snap.delivery;
  if (delivery === null || typeof delivery !== "object") return null;
  const deliveryId = (delivery as { id?: unknown }).id;
  const slug = snap.slug;
  if (typeof deliveryId !== "string" || deliveryId.length === 0) return null;
  if (typeof slug !== "string" || slug.length === 0) return null;
  return { deliveryId, slug };
}

function isGptConnectorConsult(serverName: string | undefined, toolName: string): boolean {
  if (toolName !== "consult") return false;
  if (serverName === undefined) return true;
  return serverName === "gpt_connector" || serverName.startsWith("gpt_connector");
}

export async function handleCursorHookInput(
  raw: string,
  stateDirectory = defaultConsultStateDirectory(),
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const common = commonSchema.safeParse(parsed);
  if (!common.success) return {};

  if (common.data.hook_event_name === "afterMCPExecution") {
    const event = afterMcpSchema.safeParse(parsed);
    if (!event.success) return {};
    if (!isGptConnectorConsult(event.data.mcp_server_name, event.data.tool_name)) return {};
    const conversationId = event.data.conversation_id;
    if (conversationId === undefined || conversationId.length === 0) return {};
    const snapshot = extractConsultSnapshot(parseJsonValue(event.data.result_json));
    if (snapshot === null) return {};
    await bindCursorConversation(
      snapshot.deliveryId,
      conversationId,
      snapshot.slug,
      stateDirectory,
    );
    return {};
  }

  if (
    common.data.hook_event_name === "postToolUse" ||
    common.data.hook_event_name === "postToolUseFailure"
  ) {
    const event = postToolSchema.safeParse(parsed);
    if (!event.success) return {};
    const conversationId = event.data.conversation_id;
    if (conversationId === undefined || conversationId.length === 0) return {};
    const messages = await claimCursorInbox(conversationId, "hook", stateDirectory);
    if (messages.length === 0) return {};
    // cursor-receiveのstdoutに本文がある。同じ返りへの二重注入を避ける。
    if (isCursorReceiveShell(event.data.tool_name, event.data.tool_input)) return {};
    const additional_context = messages.map(message => message.text).join("\n\n");
    return { additional_context };
  }

  return {};
}

function isCursorReceiveShell(
  toolName: string | undefined,
  input: string | Record<string, unknown> | undefined,
): boolean {
  if (toolName !== "Shell" && toolName !== "shell") return false;
  let command = "";
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as { command?: unknown };
      command = typeof parsed.command === "string" ? parsed.command : input;
    } catch {
      command = input;
    }
  } else if (input !== null && typeof input === "object") {
    const value = input.command;
    command = typeof value === "string" ? value : "";
  }
  return command.includes("cursor-receive");
}
