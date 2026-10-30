import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertPublishedOpenClawStateDatabaseLifecycle } from "./openclaw-state-db-cache.js";
import { createSharedStateWorkerOwner } from "./openclaw-state-worker-owner.js";

export function getOpenClawStateWorkerOwner() {
  // A retired generation must neither install its owner nor drive the current one.
  assertPublishedOpenClawStateDatabaseLifecycle();
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sharedStateWorkerOwner"),
    createSharedStateWorkerOwner,
    (sharedOwner) => sharedOwner.close(),
  );
}
