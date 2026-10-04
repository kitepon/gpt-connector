import { ConnectorError } from "./errors.js";
import type { CdpClient } from "./cdp.js";

interface RuntimeRemoteObject {
  readonly value?: unknown;
  readonly description?: string;
}

interface RuntimeEvaluateResponse {
  readonly result?: RuntimeRemoteObject;
  readonly exceptionDetails?: unknown;
}

function nativeLoggedOut(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  const exception = (details as { exception?: unknown }).exception;
  if (typeof exception !== "object" || exception === null) return false;
  const description = (exception as { description?: unknown }).description;
  // Recognize only our fixed probe tag; raw CDP exceptions may contain user content.
  return typeof description === "string" &&
    /^Error: AUTH_REQUIRED:native_runtime_logged_out(?:\n|$)/u.test(description);
}

export async function evaluateByValue<T>(
  client: CdpClient,
  expression: string,
  awaitPromise = true,
): Promise<T> {
  const response = await client.call<RuntimeEvaluateResponse>("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  });

  if (response.exceptionDetails !== undefined || response.result === undefined) {
    if (nativeLoggedOut(response.exceptionDetails)) {
      throw new ConnectorError("AUTH_REQUIRED", "専用ChromeのChatGPTページがログアウト状態です。ChatGPTへログインして同じsetupを再実行してください。");
    }
    throw new ConnectorError(
      "RUNTIME_DRIFT",
      "ChatGPT page main worldで式を評価できませんでした。",
    );
  }

  return response.result.value as T;
}
