// aiterm-steer-deliveryの配送エラーを、gpt-connectorのエラー（成否不明の区別を含む）へ包み直す。
import { SteerDeliveryError } from "aiterm-steer-delivery";
import { CodexHookError } from "./codex-delivery-error.js";

export function translateSteerError(error: unknown): unknown {
  if (!(error instanceof SteerDeliveryError)) return error;
  const translated = new CodexHookError(error.delivery_code, error.message.replace(/^[A-Z][A-Z0-9_]+: /u, ""), error.outcome_unknown);
  (translated as Error & { cause?: unknown }).cause = error;
  return translated;
}

export function steerCall<T>(action: () => T): T {
  try {
    const result = action();
    if (result instanceof Promise) return result.catch(error => { throw translateSteerError(error); }) as T;
    return result;
  } catch (error) { throw translateSteerError(error); }
}
