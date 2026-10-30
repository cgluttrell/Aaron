import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { hasNodeErrorCode, isNotFoundPathError } from "@openclaw/fs-safe/path";
import { isMissingPathError } from "./errno.js";

/** Only definite absence, including a non-directory ancestor, permits an absent verdict. */
export function pathMayExistSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

/** Inspect links themselves; callers decide whether a non-directory ancestor counts as absent. */
export async function lstatIfExists(
  filePath: string,
  missingErrors: "ENOENT" | "ENOENT_OR_ENOTDIR" = "ENOENT_OR_ENOTDIR",
): Promise<fs.Stats | undefined> {
  try {
    return await fsPromises.lstat(filePath);
  } catch (error) {
    if (
      missingErrors === "ENOENT" ? hasNodeErrorCode(error, "ENOENT") : isNotFoundPathError(error)
    ) {
      return undefined;
    }
    throw error;
  }
}
