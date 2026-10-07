import type { ConnectorError } from "./errors.js";

/** Local observations only. These fields are never added to the BugHub wire. */
export interface FailureAssessment {
  cause: "environment" | "application" | "unknown";
  impact: "unknown" | "operation_failed" | "data_loss" | "duplicate_execution" | "service_stopped";
  handling: "handled" | "defective" | "unknown";
  recovery: "safe" | "status_first" | "unavailable" | "unknown";
  cancelled: boolean;
}
export type RuntimeErrorSeverity = "fatal" | "high" | "warn" | "info";

export function assessRuntimeFailure(error: ConnectorError): FailureAssessment {
  // A failed public call proves an operation failed, but does not prove a defect,
  // an environment root cause, data loss, or safe recovery.
  const assessment: FailureAssessment = {
    cause: "unknown", impact: "operation_failed", handling: "unknown", recovery: "unknown", cancelled: false,
  };
  if (error.code === "AUTH_REQUIRED" || error.details?.unreachable === true || error.details?.targetMissing === true
    || error.details?.beforeSubmission === true) {
    assessment.handling = "handled";
    assessment.recovery = "safe";
  }
  if (error.details?.cancellationConfirmed === true) {
    assessment.cancelled = true;
    assessment.handling = "handled";
    assessment.recovery = "safe";
  }
  return assessment;
}

export function runtimeFailureDecision(assessment: FailureAssessment): { register: boolean; severity: RuntimeErrorSeverity | null } {
  // Harm takes precedence even when the underlying network cause is environmental.
  if (assessment.impact === "service_stopped") return { register: true, severity: "fatal" };
  if (assessment.impact === "data_loss" || assessment.impact === "duplicate_execution") return { register: true, severity: "high" };
  if (assessment.handling === "handled") return { register: false, severity: "info" };
  if (assessment.impact === "unknown") return { register: false, severity: null };
  // Unverified recovery is explicitly kept unknown; it is not assumed safe.
  return { register: true, severity: assessment.recovery === "safe" || assessment.recovery === "status_first" ? "warn" : "high" };
}
