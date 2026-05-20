import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { log } from "./constants.js";

export function saveAuthProfileBookkeepingBestEffort(params: {
  action: string;
  save: () => void;
}): void {
  try {
    params.save();
  } catch (error) {
    log.warn("failed to persist auth profile bookkeeping; continuing request", {
      action: params.action,
      code: extractErrorCode(error),
      error: formatErrorMessage(error),
    });
  }
}
