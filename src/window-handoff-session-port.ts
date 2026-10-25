// Unwired TypeScript mapping of quolu/OL-RemoteWindow da359c9 SessionPort declarations.
import type { LocalWatchTuple } from "./window-handoff-local-codec.js";

export type LocalTransportFailure = "offline" | "request_aborted" | "deadline_expired" | "peer_eof"
  | "io_failed" | "protocol_invalid" | "session_closed";
export type LocalWatchLoss = "window_destroyed" | "process_exited" | "anchor_lost" | "monitor_lost"
  | "registration_changed" | "deadline_expired" | "session_closed";
export interface LocalWatchLifetime {
  readonly session: object;
  readonly beginCallId: number;
  readonly originalTuple: LocalWatchTuple;
  readonly invalidated: AbortSignal; // Issued by the native channel; never fabricated by the client.
  readonly loss?: LocalWatchLoss;
}
export type LocalControl =
  | { readonly kind: "watch_lost"; readonly session: object; readonly beginCallId: number;
    readonly originalTuple: LocalWatchTuple; readonly reason: LocalWatchLoss }
  | { readonly kind: "session_ended"; readonly session: object; readonly reason: LocalTransportFailure };
export interface LocalControlSubscription { readonly lost: AbortSignal; dispose(): void }
export type LocalWait =
  | { readonly purpose: "request"; readonly absoluteDeadline: number; readonly maximumWaitMs: number; readonly originalAbort?: AbortSignal }
  | { readonly purpose: "cleanup"; readonly absoluteDeadline: number; readonly maximumWaitMs: number };
export type LocalExchangeResult =
  | { readonly kind: "reply"; readonly session: object; readonly bytes: string | Uint8Array; readonly watchLifetime?: LocalWatchLifetime }
  | { readonly kind: "failure"; readonly reason: LocalTransportFailure; readonly delivery: "not_sent" | "unknown" };
export interface LocalAuthenticatedChannel {
  readonly session: object;
  readonly hostRegistrationId: string;
  readonly closed: AbortSignal;
  // Synchronous prepared subscription before begin write. Original notifications must not be skipped.
  subscribeControl(receive: (control: LocalControl) => void): LocalControlSubscription;
  // Same session/channel only; owns a byte copy on invocation, no reconnect/resend.
  exchange(bytes: string, wait: LocalWait): Promise<LocalExchangeResult>;
  close(): Promise<void>; // Seals session. Completion is not native reclamation ACK.
}
export interface LocalClientClock {
  // Raw Unix UTC only. Never expose a corrected/private epoch as a peer deadline.
  now(): number;
  startRequest(absoluteDeadline: number): LocalWaitBudget;
  startCleanup(maximumWaitMs: number): LocalWaitBudget;
  remaining(budget: LocalWaitBudget): Readonly<{ absoluteDeadline: number; maximumWaitMs: number }>;
  atBudget(budget: LocalWaitBudget, callback: () => void): () => void;
}
declare const budgetBrand: unique symbol;
export interface LocalWaitBudget { readonly [budgetBrand]: true }
