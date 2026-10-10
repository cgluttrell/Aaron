import fs from "node:fs";
import { isPidAlive } from "../shared/pid-alive.js";
import { parseGatewayLockPayload } from "./gateway-lock-payload.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/**
 * Names the recorded state owner for contention diagnostics. Reads the owner
 * record already in the lock file and never participates in admission,
 * reclaim, or stale recovery.
 */
export function describeStateOwnerHolder(pathname: string): string {
  try {
    const holder = parseGatewayLockPayload(fs.readFileSync(pathname, "utf8"));
    if (
      !holder ||
      isLockOwnerDefinitelyStale({ payload: { pid: holder.pid, starttime: holder.startTime } }) ||
      !isPidAlive(holder.pid)
    ) {
      return "holder=unavailable";
    }
    const createdAt = Date.parse(holder.createdAt);
    return [
      `holder_pid=${holder.pid}`,
      `holder_role=${holder.role ?? "gateway"}`,
      `holder_kind=${holder.stateOwnerKind ?? "process"}`,
      ...(Number.isFinite(createdAt)
        ? [`holder_held_ms=${Math.max(0, Date.now() - createdAt)}`]
        : []),
    ].join(" ");
  } catch {
    return "holder=unavailable";
  }
}
