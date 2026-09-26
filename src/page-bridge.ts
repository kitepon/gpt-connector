import { createHash } from "node:crypto";
import { modelResolutionMatches } from "./model-catalog.js";

export const bridgeGlobalName = "__gptConnectorBridgeV1";

const bridgeBootstrapSource = String.raw`async function(runtimeUrl, expectedBuildId) {
  const globalName = "__gptConnectorBridgeV1";
  const selectionMatches = ${modelResolutionMatches.toString()};
  if (globalThis[globalName]?.version === 1 && globalThis[globalName]?.buildId === expectedBuildId) {
    return globalThis[globalName].summary();
  }

  const runtime = (await import(runtimeUrl)).__webpack_require__;
  if (!runtime || typeof runtime !== "function" || !runtime.c || !runtime.m) {
    throw new Error("RUNTIME_DRIFT:rspack_runtime");
  }
  const exports = Object.values(runtime.c).flatMap((module) => Object.entries(module.exports ?? {}));
  const functionSource = (value) => Function.prototype.toString.call(value);
  const unique = (role, candidates) => {
    const values = [...new Set(candidates.map(([, value]) => value))];
    if (values.length !== 1) throw new Error("RUNTIME_DRIFT:" + role + ":" + values.length);
    return values[0];
  };
  const bySource = (role, predicate) => unique(role, exports.filter(([, value]) =>
    typeof value === "function" && predicate(functionSource(value), value)
  ));
  const sender = unique("sender", exports.filter(([key, value]) =>
    key === "submitChatGPTCompletion" && typeof value === "function" &&
    value.length === 2 && functionSource(value).includes("onServerThreadIdChange")
  ));
  const uploadClient = bySource("uploader", (source, value) =>
    value.length === 3 && source.startsWith("async function") &&
    source.includes("process_upload_stream") && source.includes("libraryPersistenceMode") &&
    source.includes("uploadPurpose") && source.includes("storeInLibrary")
  );
  const scopeToken = unique("appScope", exports.filter(([, value]) =>
    value?.__scopeBrand === "AppScope" && value.parent == null
  ));
  const scopeWrapper = bySource("scopeWrapper", (source, value) =>
    value.length === 6 && source.includes("getOwnValue") &&
    source.includes("queryClient") && source.includes("watch=s")
  );
  const atomModule = unique("atomModule", Object.entries(runtime.c).filter(([, module]) =>
    Object.values(module.exports ?? {}).some((value) =>
      typeof value === "function" && functionSource(value).includes("n={toString:()=>r}")
    ) && Object.values(module.exports ?? {}).some((value) =>
      typeof value === "function" && functionSource(value).includes("return n?n()")
    )
  ).map(([key, module]) => [key, module.exports]));
  const atom = unique("atom", Object.entries(atomModule).filter(([, value]) =>
    typeof value === "function" && functionSource(value).includes("n={toString:()=>r}")
  ));
  const createStore = unique("createStore", Object.entries(atomModule).filter(([, value]) =>
    typeof value === "function" && functionSource(value).includes("return n?n()")
  ));
  const Scheduler = unique("scheduler", exports.filter(([, value]) =>
    typeof value === "function" && typeof value.prototype?.schedule === "function" &&
    typeof value.prototype?.cancel === "function"
  ));
  const QueryClient = unique("queryClient", exports.filter(([, value]) =>
    typeof value === "function" && typeof value.prototype?.getQueryCache === "function" &&
    typeof value.prototype?.getMutationCache === "function"
  ));
  const node = {
    cachedBindings: new WeakMap(), contextVersionAtom: atom(0), debugEntries: new Set(),
    familyBindings: new Map(), familyKeysByOwner: new Map(), disposalLifecycles: new Set(),
    autoDisposeScheduler: new Scheduler(), imperativeReadAtoms: new WeakSet(),
    imperativeReadDepth: 0, key: "{}", parent: undefined, queryClient: new QueryClient(),
    retainedScopeEntries: new Map(), signalBindings: new WeakMap(), store: createStore(),
    token: scopeToken, value: {}
  };
  const scope = scopeWrapper(scopeToken, new Map([[scopeToken.id, node]]), node);

  const apiClientCandidates = exports.filter(([key, value]) =>
    key === "Request" &&
    value && typeof value === "object" &&
    typeof value.safeGet === "function" && typeof value.safePost === "function" &&
    typeof value.safePatch === "function" && typeof value.safeDelete === "function"
  );
  const apiClientProbeResults = await Promise.all(apiClientCandidates.map(async ([, value]) => {
    try {
      const catalog = await value.safeGet("/models", {
        parameters: { query: { supports_model_picker_upgrade_presets: true } }
      });
      if (!Array.isArray(catalog?.models) || typeof catalog?.default_model_slug !== "string") return false;
      return true;
    } catch {
      return false;
    }
  }));
  const apiClient = unique("apiClient", apiClientCandidates.filter((_, index) => apiClientProbeResults[index]));


  const sessions = new Map();
  const operations = new Map();
  const uploads = new Map();
  const downloads = new Map();
  const terminal = new Set(["succeeded", "failed"]);

  const knownErrorCodes = new Set([
    "AUTH_REQUIRED",
    "RUNTIME_DRIFT",
    "MODEL_NOT_AVAILABLE",
    "EFFORT_NOT_SUPPORTED",
    "MODEL_RESOLUTION_MISMATCH",
    "FILE_TYPE_NOT_SUPPORTED",
    "FILE_EMPTY",
    "FILE_LIMIT_EXCEEDED",
    "UPLOAD_FAILED",
    "UPLOAD_TIMEOUT",
    "ATTACHMENT_READBACK_FAILED",
    "IMAGE_NOT_GENERATED",
    "IMAGE_READBACK_FAILED",
    "IMAGE_DOWNLOAD_FAILED",
    "IMAGE_CLEANUP_FAILED",
    "CHAT_FAILED",
    "STREAM_INCOMPLETE",
    "SESSION_NOT_FOUND",
    "SESSION_BUSY",
    "ARCHIVE_FAILED"
  ]);

  const errorCode = (error, fallbackCode) => {
    const message = String(error?.message ?? error ?? "");
    const prefix = message.split(":", 1)[0];
    if (knownErrorCodes.has(prefix)) return prefix;
    const status = error?.status ?? error?.response?.status;
    if (status === 401 || status === 403) return "AUTH_REQUIRED";
    return fallbackCode;
  };

  const safeError = (error, fallbackCode) => ({
    code: errorCode(error, fallbackCode),
    message: String(error?.message ?? error ?? "unknown error")
      .slice(0, 240)
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
  });

  const clearChunks = (upload) => {
    for (const chunk of upload?.chunks ?? []) chunk.fill(0);
    if (upload) upload.chunks = [];
  };

  const clearDownload = (handle) => {
    const download = downloads.get(handle);
    download?.content?.fill(0);
    return downloads.delete(handle);
  };

  const serverIdOf = (conversation) => conversation?.serverId ?? null;

  const getCatalog = async () => {
    const raw = await apiClient.safeGet("/models", {
      parameters: { query: { supports_model_picker_upgrade_presets: true } }
    });
    const models = (raw.models ?? [])
      .filter((model) => model?.is_work_mode_model !== true && typeof model?.slug === "string")
      .map((model) => ({
        id: model.slug,
        title: typeof model.title === "string" ? model.title : model.slug,
        reasoningType: typeof model.reasoning_type === "string" ? model.reasoning_type : null,
        efforts: Array.isArray(model.thinking_efforts)
          ? model.thinking_efforts.map((item) => item?.thinking_effort).filter((item) => typeof item === "string")
          : [],
        configurableEffort: model.configurable_thinking_effort === true,
        maxTokens: typeof model.max_tokens === "number" ? model.max_tokens : null
      }));
    return {
      defaultModel: models.some((model) => model.id === raw.default_model_slug)
        ? raw.default_model_slug
        : null,
      models,
      versions: raw.versions
    };
  };

  const validateSelection = async (modelId, effort) => {
    const catalog = await getCatalog();
    if (modelId == null) {
      if (effort != null) throw new Error("EFFORT_NOT_SUPPORTED:model_required");
      return;
    }
    const model = catalog.models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("MODEL_NOT_AVAILABLE");
    if (effort != null && !model.efforts.includes(effort)) {
      throw new Error("EFFORT_NOT_SUPPORTED");
    }
  };

  const normalizeUploadedAttachment = (upload, uploaded) => {
    if (typeof uploaded?.id !== "string" || uploaded.id.length === 0 ||
        uploaded.name !== upload.name || uploaded.size !== upload.size ||
        typeof uploaded.mimeType !== "string" || uploaded.mimeType.length === 0) {
      throw new Error("RUNTIME_DRIFT:upload_metadata");
    }
    return {
      id: uploaded.id, size: uploaded.size, name: uploaded.name,
      mime_type: uploaded.mimeType, library_file_id: uploaded.libraryFileId
    };
  };

  const readBackAttachments = async (conversation, expected) => {
    if (expected.length === 0) {
      return {
        count: 0,
        names: [],
        mimeTypes: [],
        readBack: "confirmed",
        retention: "unknown",
        cleanup: "not_supported"
      };
    }
    const serverId = serverIdOf(conversation);
    if (!serverId) throw new Error("ATTACHMENT_READBACK_FAILED:no_server_id");
    const data = await apiClient.safeGet("/conversation/{conversation_id}", {
      parameters: { path: { conversation_id: serverId } }
    });
    const attachmentSets = Object.values(data?.mapping ?? {})
      .map((node) => node?.message)
      .filter((message) => message?.author?.role === "user")
      .map((message) => Array.isArray(message?.metadata?.attachments)
        ? message.metadata.attachments
        : []);
    const matches = attachmentSets.filter((actual) =>
      actual.length === expected.length && actual.every((item, index) => {
        const wanted = expected[index];
        return item?.id === wanted?.id &&
          item?.name === wanted?.name &&
          item?.mime_type === wanted?.mime_type;
      })
    );
    if (matches.length !== 1) {
      throw new Error("ATTACHMENT_READBACK_FAILED:attachment_set_mismatch");
    }
    return {
      count: expected.length,
      names: expected.map((attachment) => attachment.name),
      mimeTypes: expected.map((attachment) => attachment.mime_type ?? null),
      readBack: "confirmed",
      retention: "unknown",
      cleanup: "not_supported"
    };
  };

  const readBackGeneratedImages = async (conversation) => {
    const serverId = serverIdOf(conversation);
    if (!serverId) throw new Error("IMAGE_READBACK_FAILED:no_server_id");
    const terminal = conversation.lastMessage;
    const turnExchangeId = terminal?.metadata?.turn_exchange_id ?? null;
    const workingTurnId = terminal?.metadata?.working_turn_id ?? null;
    if (
      terminal?.author?.role !== "assistant" ||
      terminal?.status !== "finished_successfully" ||
      terminal?.end_turn !== true ||
      typeof turnExchangeId !== "string" ||
      typeof workingTurnId !== "string"
    ) throw new Error("IMAGE_READBACK_FAILED:terminal_turn_mismatch");

    let data = conversation.lastData;
    let mapping = data?.mapping ?? {};
    let turnMessages = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      turnMessages = Object.values(mapping)
        .map((node) => node?.message)
        .filter((message) =>
          message?.metadata?.turn_exchange_id === turnExchangeId &&
          message?.metadata?.working_turn_id === workingTurnId &&
          typeof message?.id === "string"
        );
      const hasImageToolMessage = turnMessages.some((message) =>
        message?.author?.role === "tool" &&
        (Array.isArray(message?.content?.parts) ? message.content.parts : [])
          .some((part) => part?.content_type === "image_asset_pointer")
      );
      if (hasImageToolMessage) break;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
      data = await apiClient.safeGet("/conversation/{conversation_id}", {
        parameters: { path: { conversation_id: serverId } }
      });
      mapping = data?.mapping ?? {};
    }
    const turnMessageIds = turnMessages.map((message) => message.id);
    if (turnMessageIds.length === 0) throw new Error("IMAGE_READBACK_FAILED:turn_message_set_empty");
    const turnMessageIdSet = new Set(turnMessageIds);

    let matches = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const library = await apiClient.safeGet("/files/library/nodes", {
        parameters: { query: { include_hidden_files: true } }
      });
      matches = (library?.items ?? []).filter((item) =>
        item?.origination_thread_id === serverId &&
        turnMessageIdSet.has(item?.origination_message_id) &&
        typeof item?.id === "string" &&
        typeof item?.file_id === "string" &&
        typeof item?.mime_type === "string" &&
        item.mime_type.startsWith("image/") &&
        Number.isSafeInteger(item?.file_size_bytes) &&
        item.file_size_bytes > 0
      );
      if (matches.length > 0) break;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    if (matches.length === 0) throw new Error("IMAGE_NOT_GENERATED:no_correlated_library_image");

    // 画像toolのサブターンは別model名義になる。one-shot画像会話の指定modelは会話全体に記録される。
    const promptResolvedModel = typeof data?.default_model_slug === "string"
      ? data.default_model_slug
      : null;

    matches.sort((left, right) =>
      turnMessageIds.indexOf(right.origination_message_id) -
      turnMessageIds.indexOf(left.origination_message_id)
    );
    const results = [];
    try {
      for (const item of matches) {
        const origin = Object.values(mapping)
          .map((node) => node?.message)
          .find((message) => message?.id === item.origination_message_id);
        const imageParts = (Array.isArray(origin?.content?.parts) ? origin.content.parts : [])
          .filter((part) => part?.content_type === "image_asset_pointer");
        const part = imageParts.find((candidate) =>
          candidate?.mime_type === item.mime_type &&
          candidate?.size_bytes === item.file_size_bytes &&
          typeof candidate?.asset_pointer === "string" &&
          candidate.asset_pointer.includes(item.file_id)
        );
        if (origin?.author?.role !== "tool" || !part) {
          throw new Error("IMAGE_READBACK_FAILED:origin_message_mismatch");
        }

        const resolved = await apiClient.safeGet("/files/library/files/{library_file_id}/content_url", {
          parameters: { path: { library_file_id: item.id } }
        });
        if (typeof resolved?.content_url !== "string") {
          throw new Error("IMAGE_DOWNLOAD_FAILED:content_url_missing");
        }
        const response = await fetch(resolved.content_url);
        if (!response.ok) throw new Error("IMAGE_DOWNLOAD_FAILED:content_fetch_failed");
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? item.mime_type;
        if (mimeType !== item.mime_type) throw new Error("IMAGE_DOWNLOAD_FAILED:mime_mismatch");
        const content = new Uint8Array(await response.arrayBuffer());
        if (content.byteLength !== item.file_size_bytes) {
          content.fill(0);
          throw new Error("IMAGE_DOWNLOAD_FAILED:size_mismatch");
        }
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        const downloadHandle = crypto.randomUUID();
        downloads.set(downloadHandle, {
          content,
          libraryFileId: item.id,
          fileId: item.file_id,
          parentDirectoryId: item.parent_directory_id,
          fileName: typeof item.name === "string" && item.name.length > 0 ? item.name : null
        });
        results.push({
          downloadHandle,
          mimeType,
          bytes: content.byteLength,
          sha256,
          width: Number.isSafeInteger(part.width) && part.width > 0 ? part.width : null,
          height: Number.isSafeInteger(part.height) && part.height > 0 ? part.height : null
        });
      }
      return { images: results, promptResolvedModel };
    } catch (error) {
      for (const result of results) clearDownload(result.downloadHandle);
      throw error;
    }
  };

  const waitForTerminalTurn = async (conversation, completionStatus, senderFailure, imageMode) => {
    for (let attempt = 0; attempt < 660; attempt += 1) {
      if (senderFailure()) throw senderFailure();
      const status = completionStatus();
      if (status != null && status !== "completed") {
        throw new Error("STREAM_INCOMPLETE:sender_" + status);
      }
      if (conversation.serverId && status === "completed") {
        if (imageMode) await new Promise((resolve) => setTimeout(resolve, 30000));
        for (let read = 0; read < (imageMode ? 10 : 6); read += 1) {
          const data = await apiClient.safeGet("/conversation/{conversation_id}", {
            parameters: { path: { conversation_id: conversation.serverId } }
          });
          const messages = Object.values(data?.mapping ?? {})
            .map((entry) => entry?.message)
            .filter((message) => message?.author?.role === "assistant" &&
              typeof message?.create_time === "number" &&
              message.id !== conversation.parentMessageId &&
              message.create_time > (conversation.lastMessage?.create_time ?? -Infinity))
            .sort((left, right) => left.create_time - right.create_time);
          const message = messages.filter((item) =>
            item.status === "finished_successfully" && item.end_turn === true).at(-1);
          if (message) {
            conversation.lastMessage = message;
            conversation.lastData = data;
            conversation.parentMessageId = message.id;
            return;
          }
          if (messages.some((item) => item.status === "failed")) {
            throw new Error("CHAT_FAILED:assistant_message_failed");
          }
          if (read === (imageMode ? 9 : 5)) break;
          await new Promise((resolve) => setTimeout(resolve, imageMode ? 30000 : 2000));
        }
        throw new Error("STREAM_INCOMPLETE:terminal_readback");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("STREAM_INCOMPLETE:terminal_turn_not_observed");
  };

  const extractResult = (conversation, allowEmptyText = false) => {
    const message = conversation.lastMessage;
    const text = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((part) => typeof part === "string").join("")
      : "";
    if (!message || message.status !== "finished_successfully" || message.end_turn !== true || (!allowEmptyText && text.length === 0)) {
      throw new Error("STREAM_INCOMPLETE");
    }
    const metadata = message.metadata ?? {};
    return {
      text,
      status: message.status,
      endTurn: true,
      resolvedModel: typeof metadata.resolved_model_slug === "string"
        ? metadata.resolved_model_slug
        : typeof metadata.model_slug === "string" ? metadata.model_slug : null,
      resolvedEffort: typeof metadata.thinking_effort === "string"
        ? metadata.thinking_effort
        : null
    };
  };

  const archive = async (conversation) => {
    const serverId = serverIdOf(conversation);
    if (!serverId) throw new Error("ARCHIVE_FAILED:no_server_id");
    try {
      await apiClient.safePatch("/conversation/{conversation_id}", {
        parameters: { path: { conversation_id: serverId } },
        requestBody: { is_archived: true }
      });
      const data = await apiClient.safeGet("/conversation/{conversation_id}", {
        parameters: { path: { conversation_id: serverId } }
      });
      if (data?.is_archived !== true) throw new Error("ARCHIVE_FAILED:not_confirmed");
    } catch (error) {
      const code = errorCode(error, "ARCHIVE_FAILED");
      const status = error?.status ?? error?.response?.status;
      throw new Error(code + ":会話のarchive処理に失敗しました。" +
        (Number.isInteger(status) ? "HTTP " + status + " " : "") + String(error?.message ?? error));
    }
  };

  const startOperation = (kind) => {
    const id = crypto.randomUUID();
    operations.set(id, { kind, state: "pending", result: null, error: null });
    return id;
  };

  const finishFailure = (operation, error, fallbackCode) => {
    operation.state = "failed";
    operation.error = safeError(error, fallbackCode);
  };

  const bridge = {
    version: 1,
    buildId: expectedBuildId,
    summary: () => ({ version: 1, buildId: expectedBuildId, ready: true }),
    diagnostics: () => ({
      sessionCount: sessions.size,
      operationCount: operations.size,
      uploadCount: uploads.size,
      bufferedUploadBytes: [...uploads.values()]
        .reduce((total, upload) => total + (upload.state === "receiving" ? upload.receivedBytes : 0), 0),
      downloadCount: downloads.size,
      bufferedDownloadBytes: [...downloads.values()]
        .reduce((total, download) => total + download.content.byteLength, 0)
    }),
    createUpload: (input) => {
      if (
        !input ||
        typeof input.name !== "string" ||
        input.name.length === 0 ||
        typeof input.mimeType !== "string" ||
        input.mimeType.length === 0 ||
        !Number.isSafeInteger(input.size) ||
        input.size <= 0 ||
        typeof input.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.sha256)
      ) {
        throw new Error("UPLOAD_FAILED:invalid_upload_input");
      }
      const uploadHandle = crypto.randomUUID();
      uploads.set(uploadHandle, {
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        sha256: input.sha256,
        state: "receiving",
        chunks: [],
        receivedBytes: 0,
        attachment: null
      });
      return { uploadHandle };
    },
    appendUploadChunk: (uploadHandle, base64Chunk) => {
      const upload = uploads.get(uploadHandle);
      if (!upload || upload.state !== "receiving") {
        throw new Error("UPLOAD_FAILED:upload_handle_not_receiving");
      }
      if (typeof base64Chunk !== "string" || base64Chunk.length === 0 || base64Chunk.length > 2_000_000) {
        throw new Error("UPLOAD_FAILED:invalid_upload_chunk");
      }
      let binary;
      try {
        binary = atob(base64Chunk);
      } catch {
        throw new Error("UPLOAD_FAILED:invalid_upload_chunk");
      }
      if (upload.receivedBytes + binary.length > upload.size) {
        throw new Error("UPLOAD_FAILED:upload_size_exceeded");
      }
      const chunk = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        chunk[index] = binary.charCodeAt(index);
      }
      upload.chunks.push(chunk);
      upload.receivedBytes += chunk.byteLength;
      return { receivedBytes: upload.receivedBytes };
    },
    startUpload: (input) => {
      const operationId = startOperation("upload");
      const operation = operations.get(operationId);
      const upload = uploads.get(input?.uploadHandle);
      if (!upload || upload.state !== "receiving") {
        finishFailure(operation, new Error("UPLOAD_FAILED:upload_handle_not_receiving"), "UPLOAD_FAILED");
        return { operationId };
      }
      if (upload.receivedBytes !== upload.size) {
        finishFailure(operation, new Error("UPLOAD_FAILED:upload_size_mismatch"), "UPLOAD_FAILED");
        return { operationId };
      }
      upload.state = "uploading";
      void (async () => {
        let timeoutId = null;
        try {
          const file = new File(upload.chunks, upload.name, {
            type: upload.mimeType,
            lastModified: 0
          });
          clearChunks(upload);
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
          if (digest !== upload.sha256) {
            throw new Error("UPLOAD_FAILED:upload_digest_mismatch");
          }

          const timeoutMs = Number.isSafeInteger(input?.timeoutMs)
            ? Math.min(Math.max(input.timeoutMs, 1_000), 180_000)
            : 120_000;
          const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("UPLOAD_TIMEOUT:official_upload_timeout")), timeoutMs
            );
          });
          const uploaded = await Promise.race([
            uploadClient(scope, file, {
              model: { slug: (await getCatalog()).defaultModel },
              storeInLibrary: false,
              uploadPurpose: "composer"
            }),
            timeout
          ]);
          if (timeoutId !== null) clearTimeout(timeoutId);
          upload.attachment = uploaded;
          upload.metadata = normalizeUploadedAttachment(upload, uploaded);
          upload.state = "ready";
          operation.state = "succeeded";
          operation.result = {
            uploadHandle: input.uploadHandle,
            name: upload.name,
            size: upload.size,
            mimeType: upload.metadata.mime_type
          };
        } catch (error) {
          if (timeoutId !== null) clearTimeout(timeoutId);
          clearChunks(upload);
          uploads.delete(input.uploadHandle);
          finishFailure(operation, error, "UPLOAD_FAILED");
        }
      })();
      return { operationId };
    },
    discardUpload: (uploadHandle) => {
      const upload = uploads.get(uploadHandle);
      clearChunks(upload);
      const discarded = uploads.delete(uploadHandle);
      return { discarded };
    },
    readDownloadChunk: (downloadHandle, offset, length) => {
      const download = downloads.get(downloadHandle);
      if (
        !download ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > 256 * 1024 ||
        offset + length > download.content.byteLength
      ) {
        throw new Error("IMAGE_DOWNLOAD_FAILED:invalid_chunk_request");
      }
      const bytes = download.content.subarray(offset, offset + length);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
      }
      return {
        base64Chunk: btoa(binary),
        offset,
        bytes: bytes.byteLength,
        totalBytes: download.content.byteLength
      };
    },
    discardDownload: (downloadHandle) => ({ discarded: clearDownload(downloadHandle) }),
    softDeleteDownloadSource: async (downloadHandle) => {
      const download = downloads.get(downloadHandle);
      if (!download) throw new Error("IMAGE_CLEANUP_FAILED:download_handle_not_found");
      await apiClient.safeDelete("/files/library/files/{library_file_id}", {
        parameters: {
          path: { library_file_id: download.libraryFileId },
          query: {
            file_id: download.fileId,
            ...(download.parentDirectoryId == null
              ? {}
              : { parent_directory_id: download.parentDirectoryId }),
            ...(download.fileName == null ? {} : { file_name: download.fileName }),
            soft_delete: true
          }
        }
      });
      const library = await apiClient.safeGet("/files/library/nodes", {
        parameters: { query: { include_hidden_files: true } }
      });
      if ((library?.items ?? []).some((item) => item?.id === download.libraryFileId)) {
        throw new Error("IMAGE_CLEANUP_FAILED:active_library_item_remains");
      }
      return { softDeleted: true };
    },
    startModels: () => {
      const operationId = startOperation("models");
      const operation = operations.get(operationId);
      void getCatalog().then((catalog) => {
        operation.state = "succeeded";
        operation.result = catalog;
      }, (error) => finishFailure(operation, error, "CHAT_FAILED"));
      return { operationId };
    },
    sessionInfo: (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? { sessionId, busy: session.busy } : null;
    },
    startChat: (input) => {
      const operationId = startOperation("chat");
      const operation = operations.get(operationId);
      const sessionId = input.sessionId ?? crypto.randomUUID();
      let session = sessions.get(sessionId);
      const createdSession = input.sessionId == null;
      if (input.sessionId != null && !session) {
        finishFailure(operation, new Error("SESSION_NOT_FOUND"), "SESSION_NOT_FOUND");
        return { operationId };
      }
      if (session?.busy) {
        finishFailure(operation, new Error("SESSION_BUSY"), "SESSION_BUSY");
        return { operationId };
      }
      const attachmentHandles = input.attachmentHandles ?? [];
      if (
        !Array.isArray(attachmentHandles) ||
        attachmentHandles.some((handle) => typeof handle !== "string") ||
        new Set(attachmentHandles).size !== attachmentHandles.length
      ) {
        finishFailure(operation, new Error("UPLOAD_FAILED:invalid_attachment_handles"), "UPLOAD_FAILED");
        return { operationId };
      }
      const turnUploads = attachmentHandles.map((handle) => uploads.get(handle));
      if (turnUploads.some((upload) => !upload || upload.state !== "ready" || !upload.attachment)) {
        finishFailure(operation, new Error("UPLOAD_FAILED:attachment_not_ready"), "UPLOAD_FAILED");
        return { operationId };
      }
      for (const upload of turnUploads) upload.state = "reserved";
      if (!session) {
        // 受付IDを返す前に予約し、初回の準備中も同じ会話への重複送信を拒否する。
        session = { conversation: null, busy: true };
        sessions.set(sessionId, session);
      } else session.busy = true;

      void (async () => {
        let generatedImages = [];
        try {
          await validateSelection(input.model, input.effort);
          const attachments = turnUploads.map((upload) => upload.attachment);
          for (const handle of attachmentHandles) uploads.delete(handle);
          if (!session.conversation) {
            session.conversation = {
              id: null, serverId: null, parentMessageId: null, lastMessage: null
            };
          }
          const conversation = session.conversation;
          let completionStatus = null;
          let senderError = null;
          const senderPromise = sender(scope, {
            prompt: String(input.prompt),
            model: input.model,
            thinkingEffort: input.effort,
            conversationMode: "primary_assistant",
            conversationId: conversation.id ?? undefined,
            parentMessageId: conversation.parentMessageId ?? undefined,
            attachments,
            onServerThreadIdChange: (...args) => {
              const id = args.find((item) => typeof item === "string");
              if (id) conversation.serverId = id;
            },
            onCompletion: (status) => { completionStatus = status; }
          });
          if (input.imageMode === true) {
            // 画像の内部送信Promiseは生成後もpendingのことがある。失敗だけ監視する。
            void senderPromise.then((dispatch) => {
              if (typeof dispatch?.conversationId === "string") conversation.id = dispatch.conversationId;
              if (dispatch?.serverConversationId) conversation.serverId = dispatch.serverConversationId;
            }, (error) => { senderError = error; });
          } else {
            const dispatch = await senderPromise;
            if (!dispatch || typeof dispatch.conversationId !== "string") {
              throw new Error("RUNTIME_DRIFT:sender_result");
            }
            conversation.id = dispatch.conversationId;
            conversation.serverId = dispatch.serverConversationId ?? conversation.serverId;
          }
          await waitForTerminalTurn(conversation, () => completionStatus, () => senderError,
            input.imageMode === true);
          let promptResolvedModel = null;
          if (input.imageMode === true) {
            const readBack = await readBackGeneratedImages(conversation);
            generatedImages = readBack.images;
            promptResolvedModel = readBack.promptResolvedModel;
          }
          const result = extractResult(session.conversation, generatedImages.length > 0);
          // 画像turnの終端assistantはtoolサブターン名義。会話全体のmodel記録で照合する。
          if (input.imageMode === true) result.resolvedModel = promptResolvedModel;
          if (input.imageMode !== true && !selectionMatches(
            input.model, input.effort, result.resolvedModel, result.resolvedEffort
          )) {
            throw new Error("MODEL_RESOLUTION_MISMATCH:通常Chatの実行model/effortが指定と一致しません。");
          }
          const attachmentSummary = await readBackAttachments(
            session.conversation,
            turnUploads.map((upload) => upload.metadata)
          );
          if (input.keepOpen === true) {
            operation.result = { ...result, attachments: attachmentSummary, images: generatedImages, sessionId };
          } else {
            await archive(session.conversation);
            sessions.delete(sessionId);
            operation.result = { ...result, attachments: attachmentSummary, images: generatedImages };
          }
          operation.state = "succeeded";
        } catch (error) {
          for (const image of generatedImages) clearDownload(image.downloadHandle);
          let cleanupError = null;
          if (session && (createdSession || input.keepOpen !== true)) {
            if (serverIdOf(session.conversation) && !String(error?.message ?? error).startsWith("ARCHIVE_FAILED")) {
              try {
                await archive(session.conversation);
              } catch (archiveError) {
                cleanupError = archiveError;
              }
            }
            sessions.delete(sessionId);
          }
          if (cleanupError) {
            const original = safeError(error, "CHAT_FAILED");
            finishFailure(operation, new Error("ARCHIVE_FAILED:cleanup_after_" + original.code + ":" +
              original.message + "; " + String(cleanupError?.message ?? cleanupError)), "ARCHIVE_FAILED");
            return;
          }
          const message = String(error?.message ?? error);
          const code = message.startsWith("MODEL_NOT_AVAILABLE") ? "MODEL_NOT_AVAILABLE"
            : message.startsWith("EFFORT_NOT_SUPPORTED") ? "EFFORT_NOT_SUPPORTED"
            : message.startsWith("MODEL_RESOLUTION_MISMATCH") ? "MODEL_RESOLUTION_MISMATCH"
            : message.startsWith("STREAM_INCOMPLETE") ? "STREAM_INCOMPLETE"
            : message.startsWith("ARCHIVE_FAILED") ? "ARCHIVE_FAILED"
            : message.startsWith("ATTACHMENT_READBACK_FAILED") ? "ATTACHMENT_READBACK_FAILED"
            : message.startsWith("IMAGE_NOT_GENERATED") ? "IMAGE_NOT_GENERATED"
            : message.startsWith("IMAGE_READBACK_FAILED") ? "IMAGE_READBACK_FAILED"
            : message.startsWith("IMAGE_DOWNLOAD_FAILED") ? "IMAGE_DOWNLOAD_FAILED"
            : message.startsWith("UPLOAD_FAILED") ? "UPLOAD_FAILED"
            : message.startsWith("RUNTIME_DRIFT") ? "RUNTIME_DRIFT"
            : "CHAT_FAILED";
          finishFailure(operation, error, code);
        } finally {
          for (const handle of attachmentHandles) {
            const upload = uploads.get(handle);
            clearChunks(upload);
            uploads.delete(handle);
          }
          const current = sessions.get(sessionId);
          if (current) current.busy = false;
        }
      })();
      return { operationId, sessionId };
    },
    startClose: (input) => {
      const operationId = startOperation("close");
      const operation = operations.get(operationId);
      const session = sessions.get(input.sessionId);
      if (!session) {
        finishFailure(operation, new Error("SESSION_NOT_FOUND"), "SESSION_NOT_FOUND");
        return { operationId };
      }
      if (session.busy) {
        finishFailure(operation, new Error("SESSION_BUSY"), "SESSION_BUSY");
        return { operationId };
      }
      session.busy = true;
      void archive(session.conversation).then(() => {
        sessions.delete(input.sessionId);
        operation.state = "succeeded";
        operation.result = { archived: true };
      }, (error) => {
        session.busy = false;
        finishFailure(operation, error, "ARCHIVE_FAILED");
      });
      return { operationId };
    },
    poll: (operationId, consume) => {
      const operation = operations.get(operationId);
      if (!operation) return { state: "failed", error: { code: "CHAT_FAILED", message: "operation_not_found" } };
      const result = {
        state: operation.state,
        result: operation.result,
        error: operation.error
      };
      if (consume === true && terminal.has(operation.state)) operations.delete(operationId);
      return result;
    }
  };

  globalThis[globalName] = bridge;
  return bridge.summary();
}`;

export const bridgeBuildId = createHash("sha256")
  .update(bridgeBootstrapSource)
  .digest("hex")
  .slice(0, 16);

export function createSingleFlightBootstrapExpression(key: string, callExpression: string): string {
  return `(() => {
    const key = ${JSON.stringify(key)};
    if (globalThis[key]) return globalThis[key];
    const pending = ${callExpression};
    globalThis[key] = pending;
    const clear = () => { if (globalThis[key] === pending) delete globalThis[key]; };
    void pending.then(clear, clear);
    return pending;
  })()`;
}

export function createBridgeBootstrapExpression(
  runtimeUrl: string,
): string {
  const call = `(${bridgeBootstrapSource})(${JSON.stringify(runtimeUrl)}, ${JSON.stringify(bridgeBuildId)})`;
  return createSingleFlightBootstrapExpression("__gptConnectorBootstrapV1", call);
}

export function createBridgeCallExpression(
  method:
    | "createUpload"
    | "appendUploadChunk"
    | "startUpload"
    | "discardUpload"
    | "readDownloadChunk"
    | "discardDownload"
    | "softDeleteDownloadSource"
    | "diagnostics"
    | "startModels"
    | "startChat"
    | "sessionInfo"
    | "startClose"
    | "poll",
  args: readonly unknown[],
): string {
  return `globalThis[${JSON.stringify(bridgeGlobalName)}].${method}(...${JSON.stringify(args)})`;
}
