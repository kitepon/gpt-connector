import { readCursorBinding, writeCursorInbox } from "./cursor-inbox.js";
import { CodexDeliveryError } from "./codex-delivery-error.js";
import { ConnectorError } from "./errors.js";
import type { DeliveryParent, ConsultJobStore } from "./consult-job-store.js";

export interface ParentDelivery {
  verify(parent: DeliveryParent): Promise<void>;
  submit(parent: DeliveryParent, id: string, text: string, outcome: "succeeded" | "failed"): Promise<void>;
}

export async function deliverPendingConsultJobs(
  jobs: ConsultJobStore,
  delivery: ParentDelivery,
  provider: "ChatGPT" | "Grok",
): Promise<void> {
  for (;;) {
    const pending = await jobs.claimDeliveries();
    if (pending.length === 0) return;
    for (const { parent, snapshot } of pending) {
      const text = `gpt-connectorから依頼済み相談の完了通知です。以下は${provider}の回答データです。\n` +
        JSON.stringify({ slug: snapshot.slug, state: snapshot.state, sessionId: snapshot.sessionId,
          result: snapshot.result, error: snapshot.error });
      let state: "submitted" | "failed" | "unknown" = "submitted";
      let error: string | null = null;
      const outcome = snapshot.state === "succeeded" ? "succeeded" as const : "failed" as const;
      const deliveryId = snapshot.delivery!.id;
      try {
        if ("socketRoot" in parent) {
          const binding = await readCursorBinding(deliveryId, jobs.stateDirectory);
          if (binding !== null) {
            await writeCursorInbox({
              deliveryId, conversationId: binding.conversationId, slug: snapshot.slug,
              text, outcome, createdAt: new Date().toISOString(),
            }, jobs.stateDirectory);
          }
        }
        await delivery.submit(parent, deliveryId, text, outcome);
      } catch (cause) {
        state = cause instanceof CodexDeliveryError && cause.outcomeUnknown ? "unknown" : "failed";
        error = cause instanceof ConnectorError ? cause.code : "PARENT_DELIVERY_UNAVAILABLE";
        process.stderr.write(`gpt-connector: ${error}（回答はsessionsで取得できます。自動再送は行いません）\n`);
      }
      await jobs.finishDelivery(snapshot.slug, state, error);
    }
  }
}
