export const connectorErrorCodes = [
  "INVALID_INPUT",
  "AUTH_REQUIRED",
  "CDP_UNAVAILABLE",
  "RUNTIME_DRIFT",
  "MODEL_NOT_AVAILABLE",
  "EFFORT_NOT_SUPPORTED",
  "MODEL_RESOLUTION_MISMATCH",
  "FILE_NOT_FOUND",
  "FILE_OUTSIDE_ROOT",
  "SENSITIVE_FILE_BLOCKED",
  "FILE_TYPE_NOT_SUPPORTED",
  "FILE_EMPTY",
  "FILE_LIMIT_EXCEEDED",
  "UPLOAD_FAILED",
  "UPLOAD_TIMEOUT",
  "ATTACHMENT_READBACK_FAILED",
  "IMAGE_NOT_GENERATED",
  "IMAGE_READBACK_FAILED",
  "IMAGE_DOWNLOAD_FAILED",
  "IMAGE_OUTPUT_FAILED",
  "IMAGE_CLEANUP_FAILED",
  "CHAT_FAILED",
  "STREAM_INCOMPLETE",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "ARCHIVE_FAILED",
  "JOB_NOT_FOUND",
  "JOB_CONFLICT",
  "JOB_RECOVERY_UNAVAILABLE",
  "PARENT_DELIVERY_UNAVAILABLE",
  "PARENT_DELIVERY_UNKNOWN",
] as const;

export type ConnectorErrorCode = (typeof connectorErrorCodes)[number];

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorError";
    this.code = code;
    this.details = details;
  }
}
