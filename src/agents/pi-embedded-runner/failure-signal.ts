import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isExecLikeToolName, type ToolErrorSummary } from "../tool-error-summary.js";
import type { EmbeddedRunFailureSignal } from "./types.js";

const FAILURE_SIGNAL_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;

function resolveFailureSignalCode(
  value: string | undefined,
): EmbeddedRunFailureSignal["code"] | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  for (const code of FAILURE_SIGNAL_CODES) {
    if (normalized === code) {
      return code;
    }
  }
  return undefined;
}

function resolveUnavailableToolFailureCode(
  message: string | undefined,
): EmbeddedRunFailureSignal["code"] | undefined {
  const normalizedMessage = normalizeOptionalString(message)?.toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }
  if (
    normalizedMessage.includes("tool unavailable") ||
    normalizedMessage.includes("tool is unavailable") ||
    normalizedMessage.includes("unavailable in this environment")
  ) {
    return "INVALID_REQUEST";
  }
  return undefined;
}

export function resolveEmbeddedRunFailureSignal(params: {
  trigger?: string | undefined;
  lastToolError?: ToolErrorSummary | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  const lastToolError = params.lastToolError;
  if (!lastToolError || !isExecLikeToolName(lastToolError.toolName)) {
    return undefined;
  }
  const message = normalizeOptionalString(lastToolError.error);
  const code =
    resolveFailureSignalCode(lastToolError.errorCode) ?? resolveUnavailableToolFailureCode(message);
  if (!code) {
    return undefined;
  }
  return {
    kind: "execution_denied",
    source: "tool",
    ...(lastToolError.toolName ? { toolName: lastToolError.toolName } : {}),
    code,
    message: message ?? code,
    fatalForCron: true,
  };
}
