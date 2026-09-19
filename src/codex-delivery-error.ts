import { ConnectorError } from "./errors.js";

export class CodexDeliveryError extends ConnectorError {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(outcomeUnknown ? "PARENT_DELIVERY_UNKNOWN" : "PARENT_DELIVERY_UNAVAILABLE", message);
  }
}

export class CodexHookError extends CodexDeliveryError {
  constructor(readonly delivery_code: string, message: string, outcomeUnknown = false) {
    super(message, outcomeUnknown);
  }
}
