import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ConsultJobStore } from "../src/consult-job-store.js";
import { ConnectorError } from "../src/errors.js";
import { randomUUID } from "node:crypto";
import { codexHookDirectory, codexInputDirectory, writeHookJson } from "../src/codex-hook-state.js";

const execFileAsync = promisify(execFile);
const secondProcessFixture = fileURLToPath(new URL("./fixtures/consult-job-second-process.ts", import.meta.url));

type JobState = "queued" | "uploading" | "submitted" | "running" | "succeeded" | "failed";

interface AttachmentSummary {
  readonly count: number;
  readonly names: readonly string[];
  readonly mimeTypes: readonly (string | null)[];
  readonly readBack: "confirmed";
  readonly retention: "unknown";
  readonly cleanup: "not_supported" | "failed" | "deleted";
}

interface ConsultSnapshot {
  readonly slug: string;
  readonly state: JobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: null | {
    readonly text: string;
    readonly status: string;
    readonly endTurn: true;
    readonly resolvedModel: string | null;
    readonly resolvedEffort: string | null;
    readonly attachments: AttachmentSummary;
    readonly images?: {
      readonly count: number;
      readonly files: readonly {
        readonly relativePath: string;
        readonly mimeType: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly width: number | null;
        readonly height: number | null;
      }[];
      readonly readBack: "confirmed";
      readonly retention: "library" | "recently_deleted" | "mixed";
      readonly cleanup: "not_supported" | "soft_deleted" | "failed" | "partial";
    };
    readonly archived: boolean;
  };
  readonly error: null | {
    readonly code: string;
    readonly message: string;
    readonly retry: string;
  };
}

interface ConsultJobStoreContract {
  initialize(): Promise<void>;
  close(): void;
  reserve(slug: string, fingerprint: string): Promise<{
    readonly created: boolean;
    readonly snapshot: ConsultSnapshot;
  }>;
  transition(
    slug: string,
    state: JobState,
    update: {
      readonly result?: ConsultSnapshot["result"];
      readonly error?: ConsultSnapshot["error"];
    },
  ): Promise<ConsultSnapshot>;
  get(slug: string): ConsultSnapshot;
}

const slug = "durable-job-001";
const fingerprint = "5de33c50f002c4d54e191a00e1d4f6b8";

test("公式キュー投入後のhook出力失敗を台帳照会でunknownとして返し、本文と旧記録を保持する", async () => {
  await withStateDirectory(async stateDirectory => {
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = stateDirectory;
    process.env.USERPROFILE = stateDirectory;
    const store = new ConsultJobStore({ stateDirectory });
    try {
      await store.initialize();
      const codexHome = join(stateDirectory, "codex-home");
      await mkdir(codexHome);
      const parent = { threadId: randomUUID(), codexHome };
      await store.reserve(slug, fingerprint, parent);
      await store.transition(slug, "submitted");
      await store.transition(slug, "running");
      await store.transition(slug, "succeeded", { result: succeededResult });
      const [delivery] = await store.claimDeliveries();
      assert.deepEqual(delivery!.parent, parent);
      await store.finishDelivery(slug, "submitted", null);
      const original = await readFile(join(stateDirectory, "consult-jobs.json"), "utf8");
      writeHookJson(join(codexInputDirectory(codexHookDirectory(), codexHome, parent.threadId), "claims", store.get(slug).delivery!.id + ".json"), { state: "unknown", text: succeededResult.text });
      assert.equal(store.get(slug).delivery!.state, "unknown");
      assert.equal(store.get(slug).delivery!.error, "PARENT_DELIVERY_UNKNOWN");
      assert.deepEqual(store.get(slug).result, succeededResult);
      assert.equal((await store.reserve(slug, fingerprint, parent)).snapshot.delivery!.state, "unknown");
      const reader = new ConsultJobStore({ stateDirectory, readOnly: true });
      await reader.initialize();
      assert.equal(reader.get(slug).delivery!.state, "unknown");
      assert.equal(await readFile(join(stateDirectory, "consult-jobs.json"), "utf8"), original);
      await rm(codexHome, { recursive: true });
      assert.equal(reader.get(slug).delivery!.state, "unknown");
      assert.deepEqual(reader.get(slug).result, succeededResult);
      reader.close();
    } finally {
      store.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

for (const wasSending of [false, true]) test(`再起動時の配送${wasSending ? "受付不明" : "未送信"}を区別し二重配送しない`, async () => {
  await withStateDirectory(async stateDirectory => {
    const first = new ConsultJobStore({ stateDirectory });
    await first.initialize();
    const parent = { threadId: randomUUID(), socketPath: "/tmp/fixture.sock" };
    await first.reserve(slug, fingerprint, parent);
    await first.transition(slug, "submitted");
    await first.transition(slug, "running");
    await first.transition(slug, "succeeded", { result: succeededResult });
    const other = new ConsultJobStore({ stateDirectory });
    await other.initialize();
    assert.deepEqual(await other.claimDeliveries(), []);
    other.close();
    if (wasSending) assert.equal((await first.claimDeliveries()).length, 1);
    first.close();
    const recovered = new ConsultJobStore({ stateDirectory });
    await recovered.initialize();
    assert.equal(recovered.get(slug).delivery?.state, wasSending ? "unknown" : "waiting");
    const claimed = await recovered.claimDeliveries();
    assert.equal(claimed.length, wasSending ? 0 : 1);
    if (!wasSending) {
      assert.deepEqual(claimed[0]!.parent, parent);
      await recovered.finishDelivery(slug, "submitted", null);
    }
    assert.deepEqual(await recovered.claimDeliveries(), []);
    assert.equal(recovered.get(slug).result?.text, succeededResult.text);
    assert.equal("parent" in recovered.get(slug), false);
    recovered.close();
  });
});

const succeededResult: NonNullable<ConsultSnapshot["result"]> = {
  text: "fixture response",
  status: "finished_successfully",
  endTurn: true,
  resolvedModel: "gpt-fixture",
  resolvedEffort: "extended",
  attachments: {
    count: 1,
    names: ["fixture.md"],
    mimeTypes: ["text/markdown"],
    readBack: "confirmed",
    retention: "unknown",
    cleanup: "not_supported",
  },
  archived: true,
};

async function withStateDirectory(
  run: (stateDirectory: string) => Promise<void>,
): Promise<void> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gpt-connector-consult-jobs-"));
  try {
    await run(stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function createStore(stateDirectory: string, readOnly = false): ConsultJobStoreContract {
  return new ConsultJobStore({ stateDirectory, readOnly });
}

async function persistedJsonPath(stateDirectory: string, expectedText: string): Promise<string> {
  const entries = await readdir(stateDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(stateDirectory, entry.name);
    if ((await readFile(path, "utf8")).includes(expectedText)) return path;
  }
  throw new Error("persisted JSON was not found");
}

test("初回reserveはqueued、同fingerprintは再利用、異fingerprintはJOB_CONFLICTにする", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const store = createStore(stateDirectory);
    await store.initialize();

    const initial = await store.reserve(slug, fingerprint);
    assert.equal(initial.created, true);
    assert.equal(initial.snapshot.slug, slug);
    assert.equal(initial.snapshot.state, "queued");
    assert.equal(initial.snapshot.result, null);
    assert.equal(initial.snapshot.error, null);

    const reused = await store.reserve(slug, fingerprint);
    assert.equal(reused.created, false);
    assert.deepEqual(reused.snapshot, initial.snapshot);
    await assert.rejects(
      store.reserve(slug, "different-fingerprint"),
      (error) => error instanceof ConnectorError && error.code === "JOB_CONFLICT",
    );
    assert.throws(
      () => store.get("missing-job-001"),
      (error) => error instanceof ConnectorError && error.code === "JOB_NOT_FOUND",
    );
    store.close();
  });
});

test("terminal resultをstate transitionと再initialize後にも保持する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const first = createStore(stateDirectory);
    await first.initialize();
    await first.reserve(slug, fingerprint);
    await first.transition(slug, "uploading", {});
    await first.transition(slug, "submitted", {});
    await first.transition(slug, "running", {});
    const terminal = await first.transition(slug, "succeeded", { result: succeededResult });
    assert.equal(terminal.state, "succeeded");
    assert.deepEqual(terminal.result, succeededResult);
    first.close();

    const second = createStore(stateDirectory);
    await second.initialize();
    assert.deepEqual(second.get(slug), terminal);
    second.close();
  });
});

for (const version of [1, 2, 3, 4]) test(`旧台帳v${version}は読取りで変更せず、初回書込みだけ退避して移行する`, async () => {
  await withStateDirectory(async (stateDirectory) => {
    const path = join(stateDirectory, "consult-jobs.json");
    const legacy = JSON.stringify({ version, jobs: [{ fingerprint, snapshot: {
      slug, state: "succeeded", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:01.000Z",
      result: succeededResult, error: null,
    } }] });
    await writeFile(path, legacy, { mode: 0o600 });
    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    assert.deepEqual(reader.get(slug).result, succeededResult);
    assert.equal(await readFile(path, "utf8"), legacy);
    assert.equal((await readdir(stateDirectory)).includes(`consult-jobs.json.v${version}-backup`), false);
    reader.close();

    const writer = new ConsultJobStore({ stateDirectory });
    await writer.initialize();
    await writer.reserve("new-question", "new-fingerprint");
    await writer.transition("new-question", "submitted");
    const sessionId = "c117bb31-51db-4f8e-94d1-32e1d53c6692";
    await writer.transition("new-question", "running", { sessionId });
    await writer.transition("new-question", "failed", {
      error: { code: "CHAT_FAILED", message: "回答生成に失敗しました。", retry: "never" },
    });
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 5);
    assert.equal(await readFile(`${path}.v${version}-backup`, "utf8"), legacy);
    if (process.platform !== "win32") assert.equal((await stat(`${path}.v${version}-backup`)).mode & 0o777, 0o600);
    writer.close();

    const reopened = new ConsultJobStore({ stateDirectory, readOnly: true });
    await reopened.initialize();
    assert.equal(reopened.get("new-question").sessionId, sessionId);
    assert.deepEqual(reopened.get(slug).result, succeededResult);
    reopened.close();
  });
});

test("image jobはuploadingなしでsubmittedへ進み生成画像metadataを保持する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const store = createStore(stateDirectory);
    await store.initialize();
    await store.reserve("image-job-001", "image-fingerprint");
    await store.transition("image-job-001", "submitted", {});
    await store.transition("image-job-001", "running", {});
    const imageResult: NonNullable<ConsultSnapshot["result"]> = {
      ...succeededResult,
      text: "",
      attachments: {
        count: 0,
        names: [],
        mimeTypes: [],
        readBack: "confirmed",
        retention: "unknown",
        cleanup: "not_supported",
      },
      images: {
        count: 1,
        files: [{
          relativePath: "assets/ad.png",
          mimeType: "image/png",
          bytes: 4,
          sha256: "0".repeat(64),
          width: 100,
          height: 200,
        }],
        readBack: "confirmed",
        retention: "recently_deleted",
        cleanup: "soft_deleted",
      },
    };
    const terminal = await store.transition("image-job-001", "succeeded", { result: imageResult });
    assert.deepEqual(terminal.result, imageResult);
    store.close();
  });
});

test("再起動時の非terminal jobをJOB_RECOVERY_UNAVAILABLEでfailedへ固定し自動再送しない", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const first = createStore(stateDirectory);
    await first.initialize();
    await first.reserve(slug, fingerprint);
    await first.transition(slug, "uploading", {});
    first.close();

    const second = createStore(stateDirectory);
    await second.initialize();
    const recovered = second.get(slug);
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.error?.code, "JOB_RECOVERY_UNAVAILABLE");

    const reserved = await second.reserve(slug, fingerprint);
    assert.equal(reserved.created, false);
    assert.deepEqual(reserved.snapshot, recovered);
    second.close();
  });
});

test("不正transitionはRUNTIME_DRIFTで拒否する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const store = createStore(stateDirectory);
    await store.initialize();
    await store.reserve(slug, fingerprint);

    await assert.rejects(
      store.transition(slug, "succeeded", { result: succeededResult }),
      (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT",
    );
    store.close();
  });
});

test("破損JSONはfail-closedし、元ファイルを上書きしない", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const first = createStore(stateDirectory);
    await first.initialize();
    await first.reserve(slug, fingerprint);
    const path = await persistedJsonPath(stateDirectory, fingerprint);
    first.close();
    const corrupt = "{ not valid JSON";
    await writeFile(path, corrupt);

    const second = createStore(stateDirectory);
    await assert.rejects(
      second.initialize(),
      (error) => error instanceof ConnectorError && error.code === "JOB_RECOVERY_UNAVAILABLE",
    );
    assert.equal(await readFile(path, "utf8"), corrupt);
  });
});

test("保存するのはfingerprintとsnapshotだけで、JSONはowner-only modeにする", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const store = createStore(stateDirectory);
    await store.initialize();
    await store.reserve(slug, fingerprint);
    const path = await persistedJsonPath(stateDirectory, fingerprint);
    const persisted = await readFile(path, "utf8");

    assert.match(persisted, new RegExp(fingerprint, "u"));
    assert.doesNotMatch(persisted, /prompt body|\/absolute\/path|file body/u);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    store.close();
  });
});

test("writerのlock中でもreadOnly readerは非terminal snapshotをそのまま読み、台帳を書き換えない", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const writer = createStore(stateDirectory);
    await writer.initialize();
    await writer.reserve(slug, fingerprint);
    await writer.transition(slug, "uploading", {});
    const before = await readFile(await persistedJsonPath(stateDirectory, fingerprint), "utf8");

    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    assert.equal(reader.get(slug).state, "uploading");
    assert.equal(await readFile(await persistedJsonPath(stateDirectory, fingerprint), "utf8"), before);
    reader.close();
    writer.close();

    const recoveredWriter = createStore(stateDirectory);
    await recoveredWriter.initialize();
    const recovered = recoveredWriter.get(slug);
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.error?.code, "JOB_RECOVERY_UNAVAILABLE");
    recoveredWriter.close();
  });
});

test("dead writerの非terminal jobはreadOnly sessionsでも回収結果を巻き戻さない", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const writer = createStore(stateDirectory);
    await writer.initialize();
    await writer.reserve(slug, fingerprint);
    await writer.transition(slug, "submitted", {});
    await writer.transition(slug, "running", {});
    const path = await persistedJsonPath(stateDirectory, fingerprint);
    const before = await readFile(path, "utf8");
    writer.close();

    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    const first = reader.get(slug);
    const second = reader.get(slug);
    assert.equal(first.state, "failed");
    assert.equal(first.error?.code, "JOB_RECOVERY_UNAVAILABLE");
    assert.deepEqual(second, first);
    assert.equal(await readFile(path, "utf8"), before);
    reader.close();
  });
});

test("別writerが実行中でも別slugの相談を受け付け、交互の更新を失わない", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const first = createStore(stateDirectory);
    await first.initialize();
    await first.reserve(slug, fingerprint);
    await first.transition(slug, "uploading", {});

    const second = createStore(stateDirectory);
    await second.initialize();
    assert.equal(second.get(slug).state, "uploading");
    const reused = await second.reserve(slug, fingerprint);
    assert.equal(reused.created, false);
    assert.equal(reused.snapshot.state, "uploading");
    const otherSlug = "another-job-001";
    const accepted = await second.reserve(otherSlug, "another-fingerprint");
    assert.equal(accepted.created, true);
    await Promise.all([
      first.transition(slug, "submitted", {}),
      second.transition(otherSlug, "submitted", {}),
    ]);
    assert.equal(first.get(otherSlug).state, "submitted");
    assert.equal(second.get(slug).state, "submitted");
    await first.transition(slug, "running", {});
    await second.transition(otherSlug, "running", {});
    await first.transition(slug, "succeeded", { result: succeededResult });
    await second.transition(otherSlug, "succeeded", { result: succeededResult });
    assert.equal(first.get(otherSlug).state, "succeeded");
    assert.equal(second.get(slug).state, "succeeded");
    second.close();
    first.close();
  });
});

test("別processの相談を受け付け、終了した実行元のjobだけを回収する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const first = createStore(stateDirectory);
    await first.initialize();
    await first.reserve(slug, fingerprint);
    await first.transition(slug, "uploading", {});

    await execFileAsync(process.execPath, ["--import", "tsx", secondProcessFixture,
      stateDirectory, "other-client-finished", "finish"], { timeout: 10_000 });
    assert.equal(first.get("other-client-finished").state, "failed");
    assert.equal(first.get(slug).state, "uploading");

    await execFileAsync(process.execPath, ["--import", "tsx", secondProcessFixture,
      stateDirectory, "other-client-exited", "exit"], { timeout: 10_000 });
    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    assert.equal(reader.get("other-client-exited").error?.code, "JOB_RECOVERY_UNAVAILABLE");
    assert.equal(reader.get(slug).state, "uploading");
    reader.close();
    first.close();
  });
});

test("status readerはlive writerのterminal更新を台帳から再読込する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const writer = createStore(stateDirectory);
    await writer.initialize();
    await writer.reserve(slug, fingerprint);
    await writer.transition(slug, "uploading", {});

    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    assert.equal(reader.get(slug).state, "uploading");
    const observer = createStore(stateDirectory);
    await observer.initialize();
    assert.equal(observer.get(slug).state, "uploading");

    await writer.transition(slug, "submitted", {});
    await writer.transition(slug, "running", {});
    await writer.transition(slug, "succeeded", { result: succeededResult });
    assert.equal(reader.get(slug).state, "succeeded");
    assert.deepEqual(reader.get(slug).result, succeededResult);
    const reused = await observer.reserve(slug, fingerprint);
    assert.equal(reused.created, false);
    assert.equal(reused.snapshot.state, "succeeded");

    observer.close();
    reader.close();
    writer.close();
  });
});

test("同一writerの複数active jobは個別に完了できる", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const store = createStore(stateDirectory);
    await store.initialize();
    const secondSlug = "durable-job-002";
    const secondFingerprint = "second-fingerprint";
    await store.reserve(slug, fingerprint);
    await store.reserve(secondSlug, secondFingerprint);
    await store.transition(slug, "uploading", {});
    await store.transition(secondSlug, "uploading", {});
    await store.transition(slug, "submitted", {});
    await store.transition(slug, "running", {});
    await store.transition(slug, "succeeded", { result: succeededResult });

    await store.transition(secondSlug, "submitted", {});
    await store.transition(secondSlug, "running", {});
    const secondTerminal = await store.transition(secondSlug, "succeeded", {
      result: succeededResult,
    });
    assert.equal(secondTerminal.state, "succeeded");

    const next = await store.reserve("durable-job-003", "third-fingerprint");
    assert.equal(next.created, true);
    store.close();
  });
});

test("readOnly storeのreserveとtransitionはJOB_RECOVERY_UNAVAILABLEで拒否する", async () => {
  await withStateDirectory(async (stateDirectory) => {
    const writer = createStore(stateDirectory);
    await writer.initialize();
    await writer.reserve(slug, fingerprint);

    const reader = createStore(stateDirectory, true);
    await reader.initialize();
    await assert.rejects(
      reader.reserve("read-only-job-001", fingerprint),
      (error) => error instanceof ConnectorError && error.code === "JOB_RECOVERY_UNAVAILABLE",
    );
    await assert.rejects(
      reader.transition(slug, "uploading", {}),
      (error) => error instanceof ConnectorError && error.code === "JOB_RECOVERY_UNAVAILABLE",
    );
    reader.close();
    writer.close();
  });
});
