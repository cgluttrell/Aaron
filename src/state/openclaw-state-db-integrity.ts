import {
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export async function confirmOpenClawStateDatabaseIntegrity(
  pathname: string,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  await closeOpenClawStateDatabaseByPathAsync(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}
