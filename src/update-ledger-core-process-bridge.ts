// Explicit source composition only. The factory owns the fixed bootstrap and fd4 authority.
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { CoreHelperBridge } from "./update-ledger-core-observer.js";

export interface CoreHelperLaunch {
  readonly phase: "core_begin" | "core_result";
  // Pass this exact string to --core-control-json and bind its UTF8 SHA/bytes.
  readonly controlJson: string;
  readonly replyFd: 3;
  readonly authorityFd: 4;
  readonly timeoutMs: 2500;
}
export interface FixedCoreHelperBootstrap {
  // Fixed adopted factory entry, activation and original authority endpoint are
  // held by this port, never selected from control, environment or product data.
  // Return the direct child before asynchronous stream/process events occur.
  start(invocation: CoreHelperLaunch): ChildProcess;
}
const MAX_CONTROL = 16384, MAX_REPLY = 16384, MAX_FRAME = 65536;
const readable = (value: unknown): value is Readable => !!value && typeof value === "object"
  && "on" in value && typeof value.on === "function" && "readableEnded" in value;

/** Own the byte/pipe boundary, without authenticating or issuing authority. No default launcher. */
export function createCoreProcessBridge(bootstrap: FixedCoreHelperBootstrap, options: {
  scheduleTimeout?: (milliseconds: number, expired: () => void) => () => void;
} = {}): CoreHelperBridge {
  const start = bootstrap.start.bind(bootstrap);
  const schedule = options.scheduleTimeout ?? ((milliseconds: number, expired: () => void) => {
    const timer = setTimeout(expired, milliseconds);
    return () => clearTimeout(timer);
  });
  return Object.freeze<CoreHelperBridge>({
    async exchange(phase, control, frame): Promise<unknown> {
      // Snapshot before any external bootstrap callback; the product does not reserialize a frame.
      const body = frame === null ? Buffer.alloc(0) : Buffer.from(frame);
      const controlJson = JSON.stringify(control);
      if (!controlJson || Buffer.byteLength(controlJson, "utf8") > MAX_CONTROL || body.length > MAX_FRAME
        || (phase !== "core_begin" && phase !== "core_result") || (phase === "core_begin" && frame !== null))
        throw new Error("core_helper_input_invalid");
      const invocation: CoreHelperLaunch = Object.freeze({ phase, controlJson, replyFd: 3, authorityFd: 4, timeoutMs: 2500 });
      return new Promise<unknown>((resolve, reject) => {
        let child: ChildProcess | undefined, done = false, exited = false, inputFinished = false;
        let replyEnded = false, replyBytes = 0, cancelTimeout = () => {};
        const chunks: Buffer[] = [];
        const failure = (reason: string) => {
          if (done) return;
          done = true;
          try { cancelTimeout(); } catch { /* Failure remains unknown. */ }
          let killed = true;
          if (child && !exited) {
            try { killed = child.kill("SIGKILL"); } catch { killed = false; }
          }
          // Never include private stdout/stderr/control bytes in an exception.
          reject(new Error(killed ? reason : "core_helper_cleanup_unconfirmed"));
        };
        try {
          cancelTimeout = schedule(2500, () => failure("core_helper_timeout"));
          if (done) { cancelTimeout(); return; }
          child = start(invocation);
          child.on("error", () => failure("core_helper_process_failed"));
          // A synchronous injected timeout during start must still retire the returned child.
          if (done) {
            for (const stream of child.stdio) stream?.on("error", () => {});
            try { child.kill("SIGKILL"); } catch { /* Already unknown. */ }
            return;
          }
          child.on("exit", () => { exited = true; });
          const input = child.stdin, output = child.stdout, errors = child.stderr, reply = child.stdio[3];
          // Keep late pipe errors observed even when a malformed launch is retired.
          for (const stream of child.stdio) stream?.on("error", () => failure("core_helper_output_unconfirmed"));
          if (!input || !readable(output) || !readable(errors) || !readable(reply)) {
            failure("core_helper_pipes_missing"); return;
          }
          input.on("error", () => failure("core_helper_input_unconfirmed"));
          output.on("error", () => failure("core_helper_output_unconfirmed"));
          errors.on("error", () => failure("core_helper_output_unconfirmed"));
          reply.on("error", () => failure("core_helper_reply_unconfirmed"));
          output.on("data", (chunk: Buffer) => { if (chunk.length) failure("core_helper_stdout_unexpected"); });
          // Drain stderr; private diagnostics never enter the public result or error.
          errors.on("data", () => {});
          reply.on("data", (chunk: Buffer) => {
            if (done) return;
            replyBytes += chunk.length;
            if (replyBytes > MAX_REPLY) { failure("core_helper_reply_too_large"); return; }
            chunks.push(Buffer.from(chunk));
          });
          reply.on("end", () => { replyEnded = true; });
          child.on("close", (code, signal) => {
            exited = true;
            if (done) return;
            if (code !== 0 || signal !== null || !inputFinished || !replyEnded) {
              failure("core_helper_completion_unconfirmed"); return;
            }
            try {
              const bytes = Buffer.concat(chunks);
              if (!bytes.length || bytes[bytes.length - 1] !== 10) throw new Error();
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              const value: unknown = JSON.parse(text);
              if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
              cancelTimeout(); done = true; resolve(value);
            } catch { failure("core_helper_reply_invalid"); }
          });
          input.end(body, () => { inputFinished = true; });
        } catch { failure("core_helper_start_failed"); }
      });
    },
  });
}
