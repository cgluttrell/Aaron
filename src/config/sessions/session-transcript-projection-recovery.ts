import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { prepareReconcileParams } from "./session-transcript-reconcile-readiness.js";
import {
  startPreparedSessionTranscriptIndexReconcile,
  waitForPreparedSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

/** Rebuilds a newly admitted session on its prepared physical store, then waits there. */
export async function recoverSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
  abortSignal: AbortSignal,
  assertCurrent: () => void,
): Promise<void> {
  abortSignal.throwIfAborted();
  const resolved = await prepareSqliteTranscriptReadScope(scope, abortSignal);
  assertCurrent();
  abortSignal.throwIfAborted();
  const prepared = prepareReconcileParams({
    ...toDatabaseOptions(resolved),
    preferredSessionId: resolved.sessionId,
  });
  startPreparedSessionTranscriptIndexReconcile(prepared);
  const wait = () =>
    waitForPreparedSessionTranscriptProjection(resolved.sessionId, prepared, abortSignal);
  // Incognito projections settle inside their actor's shared state, like the pre-admission wait.
  await (prepared.incognito ? prepared.incognito.actor.sessions.withSharedState(wait) : wait());
}
