import { createHash } from "node:crypto";

export const bridgeGlobalName = "__gptConnectorBridgeV1";

const bridgeBootstrapSource = String.raw`async function(coreUrl, conversationUrl, uploadUrl, expectedBuildId) {
  const globalName = "__gptConnectorBridgeV1";
  if (globalThis[globalName]?.version === 1 && globalThis[globalName]?.buildId === expectedBuildId) {
    return globalThis[globalName].summary();
  }

  const [core, conversationModule, uploadModule] = await Promise.all([
    import(coreUrl),
    import(conversationUrl),
    import(uploadUrl)
  ]);

  const entries = (module) => Object.entries(module);
  const functionSource = (value) => Function.prototype.toString.call(value);
  const unique = (role, candidates) => {
    if (candidates.length !== 1) {
      throw new Error("RUNTIME_DRIFT:" + role + ":" + candidates.length);
    }
    return candidates[0][1];
  };

  const sender = unique("sender", entries(core).filter(([, value]) => {
    if (typeof value !== "function" || value.length !== 1) return false;
    const source = functionSource(value);
    return source.startsWith("async function") &&
      source.includes("prepareState") &&
      source.includes("lastPrepareParentMessageId") &&
      source.includes("lastCompletionFinishedTimestamp") &&
      source.includes("prepareRequestBlocked");
  }));

  const builder = unique("builder", entries(conversationModule).filter(([, value]) => {
    if (typeof value !== "function") return false;
    const source = functionSource(value);
    return source.includes("contentToSend") &&
      source.includes("allSystemHints") &&
      source.includes("selectedSkillIds") &&
      source.includes("build_request_params.prompt_message");
  }));

  const threadStore = unique("threadStore", entries(core).filter(([, value]) =>
    value && typeof value === "object" &&
    typeof value.initThread === "function" &&
    typeof value.setServerIdForNewThread === "function" &&
    typeof value.deleteThread === "function" &&
    typeof value.retainThread === "function"
  ));

  const treeApi = unique("treeApi", entries(core).filter(([, value]) =>
    value && typeof value === "object" &&
    typeof value.getLastAssistantMessage === "function" &&
    typeof value.getCurrentMessage === "function" &&
    typeof value.getConversationTurns === "function"
  ));

  const apiClientCandidates = entries(core).filter(([, value]) =>
    value && typeof value === "object" &&
    typeof value.safeGet === "function" &&
    typeof value.safePost === "function" &&
    typeof value.safePatch === "function" &&
    typeof value.safeDelete === "function"
  );
  const apiClientProbeResults = await Promise.all(apiClientCandidates.map(async ([, value]) => {
    try {
      const catalog = await value.safeGet("/models", {
        parameters: { query: { supports_model_picker_upgrade_presets: true } }
      });
      return Array.isArray(catalog?.models) && typeof catalog?.default_model_slug === "string";
    } catch {
      return false;
    }
  }));
  const apiClient = unique("apiClient", apiClientCandidates.filter((_, index) => apiClientProbeResults[index]));

  const threadGetter = unique("threadGetter", entries(core).filter(([, value]) => {
    if (typeof value !== "function" || value.length !== 1) return false;
    const source = functionSource(value);
    return /return [\w$]+\.threads\[[\w$]+\]\}$/.test(source);
  }));

  const factoryCandidates = entries(core).filter(([, value]) => {
    if (typeof value !== "function") return false;
    const source = functionSource(value);
    return /^function [^(]+\([A-Za-z_$][\w$]*\)\{return [\w$]+\([\w$]+\(\),[\w$]+\(\),[A-Za-z_$][\w$]*\)\}$/.test(source);
  });
  const conversationFactory = unique("conversationFactory", factoryCandidates);

  const uploadClient = unique("uploadClient", entries(uploadModule).filter(([, value]) => {
    if (!value || typeof value !== "object") return false;
    const required = [
      "attachLibraryFile",
      "createFileCompleted",
      "remove",
      "removeUserInitiated",
      "reset",
      "restoreFiles",
      "updateProgress",
      "uploadCompleted",
      "uploadFile"
    ];
    return required.every((key) => key in value) && typeof value.uploadFile === "function";
  }));

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

  const serverIdOf = (conversation) => {
    const signal = conversation?.serverId$;
    if (typeof signal === "function") return signal();
    if (signal && typeof signal.get === "function") return signal.get();
    return null;
  };

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
      models
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
    const spec = uploaded?.fileSpec;
    const mimeType = spec?.mimeType ?? uploaded?.file?.type ?? null;
    if (
      uploaded?.status !== "ready" ||
      !spec ||
      typeof spec.id !== "string" ||
      spec.id.length === 0 ||
      spec.name !== upload.name ||
      spec.size !== upload.size ||
      mimeType !== upload.mimeType
    ) {
      throw new Error("RUNTIME_DRIFT:upload_metadata");
    }
    return {
      id: spec.id,
      size: spec.size,
      name: spec.name,
      context_connector_info: undefined,
      mime_type: mimeType,
      width: spec.width,
      height: spec.height,
      file_token_size: spec.fileTokenSize,
      source: uploaded.source,
      library_file_id: uploaded.libraryFileId,
      library_artifact_type: uploaded.libraryArtifactType,
      library_persistence_result: spec.libraryPersistenceResult,
      library_persistence_reason: spec.libraryPersistenceReason,
      non_library_my_files_injest_upload: spec.nonLibraryMyFilesInjestUpload,
      is_big_paste: spec.isBigPaste ?? false
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
    let terminal = null;
    let turnExchangeId = null;
    let workingTurnId = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const thread = threadGetter(conversation.id);
      terminal = treeApi.getLastAssistantMessage(thread);
      turnExchangeId = terminal?.metadata?.turn_exchange_id ?? null;
      workingTurnId = terminal?.metadata?.working_turn_id ?? null;
      if (
        terminal?.author?.role === "assistant" &&
        terminal?.status === "finished_successfully" &&
        terminal?.end_turn === true &&
        typeof turnExchangeId === "string" &&
        typeof workingTurnId === "string"
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (
      terminal?.author?.role !== "assistant" ||
      terminal?.status !== "finished_successfully" ||
      terminal?.end_turn !== true ||
      typeof turnExchangeId !== "string" ||
      typeof workingTurnId !== "string"
    ) throw new Error("IMAGE_READBACK_FAILED:terminal_turn_mismatch");

    let data = null;
    let mapping = {};
    let turnMessages = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      data = await apiClient.safeGet("/conversation/{conversation_id}", {
        parameters: { path: { conversation_id: serverId } }
      });
      mapping = data?.mapping ?? {};
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const turnMessageIds = turnMessages.map((message) => message.id);
    if (turnMessageIds.length === 0) throw new Error("IMAGE_READBACK_FAILED:turn_message_set_empty");
    const turnMessageIdSet = new Set(turnMessageIds);

    let matches = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (matches.length === 0) throw new Error("IMAGE_NOT_GENERATED:no_correlated_library_image");

    // 画像turnの終端assistantメッセージは画像tool操作サブターン(別model名義, 実測: gpt-5-4-auto-thinking)に
    // 帰属されるため、requested modelの検証にはturnのuserメッセージ側resolved_model_slugを使う。
    const promptMessage = Object.values(mapping)
      .map((node) => node?.message)
      .filter((message) => message?.author?.role === "user" && typeof message?.create_time === "number")
      .sort((left, right) => left.create_time - right.create_time)
      .pop();
    const promptResolvedModel = typeof promptMessage?.metadata?.resolved_model_slug === "string"
      ? promptMessage.metadata.resolved_model_slug
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

  // 画像turnはChatGPT内部のsender promiseが生成完了後もpendingのまま解決しないことがある(実測)。
  // 完了判定はthread側の終端メッセージ観測を正とし、senderは失敗伝搬のためだけに監視する。
  const waitForImageTerminalTurn = async (conversation, senderStatus) => {
    for (let attempt = 0; attempt < 660; attempt += 1) {
      const status = senderStatus();
      if (status.state === "rejected") throw status.error;
      const thread = threadGetter(conversation.id);
      const message = treeApi.getLastAssistantMessage(thread);
      if (
        message?.author?.role === "assistant" &&
        message?.status === "finished_successfully" &&
        message?.end_turn === true
      ) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("STREAM_INCOMPLETE:image_terminal_turn_not_observed");
  };

  const extractResult = (conversation, allowEmptyText = false) => {
    const thread = threadGetter(conversation.id);
    const message = treeApi.getLastAssistantMessage(thread);
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
    await apiClient.safePatch("/conversation/{conversation_id}", {
      parameters: { path: { conversation_id: serverId } },
      requestBody: { is_archived: true }
    });
    const data = await apiClient.safeGet("/conversation/{conversation_id}", {
      parameters: { path: { conversation_id: serverId } }
    });
    if (data?.is_archived !== true) throw new Error("ARCHIVE_FAILED:not_confirmed");
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

          let files = [];
          const files$ = () => files;
          files$.set = (next) => {
            files = typeof next === "function" ? next(files) : next;
          };
          const uploadErrors = [];
          const intl = {
            formatMessage(descriptor, values = {}) {
              let message = descriptor?.defaultMessage ?? descriptor?.id ?? "upload error";
              for (const [key, value] of Object.entries(values)) {
                message = message.replaceAll("{" + key + "}", String(value));
              }
              return message;
            }
          };
          const toaster = { danger() {}, info() {}, toasts$: () => [] };
          const tempId = crypto.randomUUID();
          const timeoutMs = Number.isSafeInteger(input?.timeoutMs)
            ? Math.min(Math.max(input.timeoutMs, 1_000), 180_000)
            : 120_000;
          const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("UPLOAD_TIMEOUT:official_upload_timeout")),
              timeoutMs
            );
          });
          const officialUpload = uploadClient.uploadFile(
            { files$ },
            tempId,
            file,
            3,
            [],
            intl,
            toaster,
            {
              entrySurface: "composer",
              selectionMethod: "file_picker",
              isBigPaste: false,
              isUnauthenticated: false,
              isTemporaryChat: false,
              isProjectThread: false,
              onUploadError(_file, error) {
                uploadErrors.push(error);
              },
              suppressDefaultErrorToast: true
            },
            undefined
          );
          await Promise.race([officialUpload, timeout]);
          if (timeoutId !== null) clearTimeout(timeoutId);
          const uploaded = files.find((item) => item.tempId === tempId) ?? null;
          if (!uploaded || uploaded.status !== "ready") {
            const failure = uploadErrors[0];
            const status = failure?.status ?? failure?.response?.status;
            const serverCode = String(failure?.code ?? "");
            const code = status === 401 || status === 403 ? "AUTH_REQUIRED"
              : serverCode === "file_zero_bytes" || serverCode === "file_empty" ? "FILE_EMPTY"
              : serverCode === "too_many_tokens" ? "FILE_LIMIT_EXCEEDED"
              : serverCode === "unhandled_mime_type" ? "FILE_TYPE_NOT_SUPPORTED"
              : "UPLOAD_FAILED";
            throw new Error(code + ":official_upload_not_ready");
          }
          upload.attachment = normalizeUploadedAttachment(upload, uploaded);
          upload.state = "ready";
          operation.state = "succeeded";
          operation.result = {
            uploadHandle: input.uploadHandle,
            name: upload.name,
            size: upload.size,
            mimeType: upload.mimeType
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
      if (session) session.busy = true;

      void (async () => {
        let generatedImages = [];
        try {
          await validateSelection(input.model, input.effort);
          const attachments = turnUploads.map((upload) => upload.attachment);
          for (const handle of attachmentHandles) uploads.delete(handle);
          if (!session) {
            const conversation = conversationFactory();
            if (!conversation || typeof conversation.id !== "string" || !conversation.id.startsWith("WEB:")) {
              throw new Error("RUNTIME_DRIFT:factory_output");
            }
            threadStore.initThread({
              clientThreadId: conversation.id,
              conversationMode: { kind: "primary_assistant" },
              conversationOrigin: null
            });
            session = { conversation, busy: true };
            sessions.set(sessionId, session);
          }
          const prompt = String(input.prompt);
          const params = await builder({
            conversation: session.conversation,
            attachments,
            content: prompt,
            contentToSend: { content: prompt, metadata: null },
            conversationMode: { kind: "primary_assistant" },
            hasSelectedApps: false,
            desktopOrigin: null,
            shouldCollectSidebarContext: false,
            selectedApps: [],
            selectedSources: undefined,
            selectedMCPConnectors: undefined,
            selectedConnectorIds: undefined,
            searchConnectorIds: undefined,
            startedWithByoMcp: false,
            // 上流builderが sourceEvent.timeStamp を無条件に読むようになったため、
            // undefinedを渡すとTypeErrorで全turnが失敗する。DOM Eventと同じ時間基準
            // (performance.now()由来の高分解能タイムスタンプ)を持つ最小のevent様objectを渡す。
            sourceEvent: { timeStamp: performance.now() },
            allSystemHints: [],
            systemHints: [],
            firstInputTimestampMs: performance.now(),
            isN7jupdActive: false,
            isForceAllowCustomMcpModeEnabled: false,
            selectedSkillIds: [],
            thinkingEffort: input.effort,
            serviceTier: undefined
          });
          const senderPromise = sender({
            ...params,
            conversation: session.conversation,
            requestedModelId: input.model,
            thinkingEffort: input.effort,
            serviceTier: undefined,
            callsiteId: "request_completion.gpt_connector.1",
            eventSource: "url"
          });
          let promptResolvedModel = null;
          if (input.imageMode === true) {
            let senderStatus = { state: "pending", error: null };
            senderPromise.then(
              () => { senderStatus = { state: "resolved", error: null }; },
              (error) => { senderStatus = { state: "rejected", error }; }
            );
            await waitForImageTerminalTurn(session.conversation, () => senderStatus);
            const readBack = await readBackGeneratedImages(session.conversation);
            generatedImages = readBack.images;
            promptResolvedModel = readBack.promptResolvedModel;
          } else {
            await senderPromise;
          }
          const result = extractResult(session.conversation, generatedImages.length > 0);
          // 画像turnの終端assistantメッセージのmodel slugはtool操作サブターン名義。
          // requested modelの照合対象はuserメッセージ側のresolved_model_slugに置き換える(nullなら照合失敗として上位で弾く)。
          if (input.imageMode === true) result.resolvedModel = promptResolvedModel;
          const attachmentSummary = await readBackAttachments(
            session.conversation,
            attachments
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
            if (serverIdOf(session.conversation)) {
              try {
                await archive(session.conversation);
              } catch (archiveError) {
                cleanupError = archiveError;
              }
            }
            sessions.delete(sessionId);
          }
          if (cleanupError) {
            finishFailure(operation, cleanupError, "ARCHIVE_FAILED");
            return;
          }
          const message = String(error?.message ?? error);
          const code = message.startsWith("MODEL_NOT_AVAILABLE") ? "MODEL_NOT_AVAILABLE"
            : message.startsWith("EFFORT_NOT_SUPPORTED") ? "EFFORT_NOT_SUPPORTED"
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
      return { operationId };
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

export function createBridgeBootstrapExpression(
  coreUrl: string,
  conversationUrl: string,
  uploadUrl: string,
): string {
  return `(${bridgeBootstrapSource})(${JSON.stringify(coreUrl)}, ${JSON.stringify(conversationUrl)}, ${JSON.stringify(uploadUrl)}, ${JSON.stringify(bridgeBuildId)})`;
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
    | "startClose"
    | "poll",
  args: readonly unknown[],
): string {
  return `globalThis[${JSON.stringify(bridgeGlobalName)}].${method}(...${JSON.stringify(args)})`;
}
