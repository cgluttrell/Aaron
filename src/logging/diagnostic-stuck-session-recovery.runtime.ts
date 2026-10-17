import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "../agents/embedded-agent-runner/run-state.js";
import {
  abortAndDrainEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  resolveEmbeddedReplyActivity,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
} from "../agents/embedded-agent-runner/runs.js";
import { recoverTerminalSessionPlacementTurn } from "../agents/session-placement-admission.js";
import { prepareStaleFollowupDrainRetirement } from "../auto-reply/reply/queue/drain.js";
import { loadSessionEntry, markSessionAbortTarget } from "../config/sessions/session-accessor.js";
import {
  getCommandLaneActiveTaskIds,
  getCommandLaneSnapshot,
  resetCommandLane,
} from "../process/command-queue.js";
import { resolveRunStaleThresholdMs } from "./diagnostic-run-activity-snapshot.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";
import { isRepeatedModelRequestStalled } from "./diagnostic-session-attention.js";
import { logWithSessionDiagnosticContext } from "./diagnostic-session-context.js";
import {
  formatRecoveryOutcome,
  resolveStuckSessionRecoveryRef,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { isDiagnosticSessionStateCurrent } from "./diagnostic-session-state.js";

const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
const STUCK_SESSION_PROGRESS_STALE_MS = 5 * 60_000;
// Ownerless lane release shares the no-progress abort floor, then extends for
// compaction because queued compaction owns the session lane without a run handle.
const STALE_ACTIVE_LANE_TASK_RELEASE_MS = STUCK_SESSION_PROGRESS_STALE_MS;
const recoveriesInFlight = new Set<string>();

function resolveStaleActiveProgressAbortMs(params: StuckSessionRecoveryRequest): number {
  const configured = params.staleActiveProgressAbortMs;
  return typeof configured === "number" && configured > 0
    ? configured
    : STUCK_SESSION_PROGRESS_STALE_MS;
}

function resolveStaleActiveLaneTaskReleaseMs(params: StuckSessionRecoveryRequest): number {
  const compactionSafetyTimeoutMs = params.compactionSafetyTimeoutMs;
  const compactionReleaseMs =
    typeof compactionSafetyTimeoutMs === "number" && compactionSafetyTimeoutMs > 0
      ? compactionSafetyTimeoutMs + STUCK_SESSION_ABORT_SETTLE_MS
      : 0;
  return Math.max(STALE_ACTIVE_LANE_TASK_RELEASE_MS, compactionReleaseMs);
}

/**
 * A reply operation whose phase still reads waiting_for_global_lane but whose
 * task already holds a global slot, has made no reply progress for the stale
 * window, and sits on a saturated global lane with queued waiters. Only that
 * combination is a lane-wait deadlock; queued waiters (no slot) and holders
 * with fresh progress stay protected.
 */
function resolveStaleGlobalLaneSlotHolder(params: {
  phase: string | undefined;
  slotLane: string | undefined;
  activeReplyAgeMs: number | undefined;
  staleAbortMs: number;
}): { lane: string; activeCount: number; queuedCount: number } | undefined {
  if (params.phase !== "waiting_for_global_lane" || !params.slotLane) {
    return undefined;
  }
  if (params.activeReplyAgeMs === undefined || params.activeReplyAgeMs < params.staleAbortMs) {
    return undefined;
  }
  const snapshot = getCommandLaneSnapshot(params.slotLane);
  const laneWaiting =
    snapshot.queuedCount > 0 && snapshot.activeCount >= Math.max(1, snapshot.maxConcurrent);
  return laneWaiting
    ? { lane: snapshot.lane, activeCount: snapshot.activeCount, queuedCount: snapshot.queuedCount }
    : undefined;
}

function isActiveRunProgressStale(params: {
  ageMs: number;
  sessionId?: string;
  sessionKey?: string;
  queueDepth?: number;
  staleAbortMs: number;
  allowActiveAbort?: boolean;
  repeatedRequestNoProgressAbortMs?: number;
  /**
   * When false, staleness is evaluated even with a zero queued backlog.
   * Run-handle recovery keeps the gate so an unqueued active run is not
   * disturbed; reply-only ownership has no backlog to protect and must
   * still expire when proven stale (phantom active reply work).
   */
  requireQueueBacklog?: boolean;
}): boolean {
  if (
    !params.allowActiveAbort &&
    (params.queueDepth ?? 0) <= 0 &&
    params.requireQueueBacklog !== false
  ) {
    return false;
  }
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  if (params.repeatedRequestNoProgressAbortMs !== undefined) {
    // Mechanical bytes cannot renew a semantic stall. New output or an owned
    // wait can invalidate the evidence while recovery's runtime is loading.
    return isRepeatedModelRequestStalled(activity, params.repeatedRequestNoProgressAbortMs);
  }
  // A retry can start after recovery was queued. Recheck its current owner and
  // deadline here before an earlier classification is allowed to abort it.
  if (
    activity.activeRetryWaitDeadlineAtMs !== undefined &&
    Date.now() < activity.activeRetryWaitDeadlineAtMs
  ) {
    return false;
  }
  if (params.allowActiveAbort && activity.activeToolDeadlineAtMs === undefined) {
    // Recovery may have queued before a fresh byte arrived. Revalidate the
    // backend allowance here. A tool deadline published during runtime loading
    // must instead pass the current shared threshold below.
    return (
      activity.activeWorkKind === "tool_call" ||
      activity.activeBackendLivenessDeadlineAtMs === undefined ||
      Date.now() >= activity.activeBackendLivenessDeadlineAtMs
    );
  }
  // A missing activity row is the orphan-handle state: classification age is
  // the only progress evidence available, so it owns the stale fallback.
  const evidenceAgeMs = activity.lastProgressAgeMs ?? params.ageMs;
  return evidenceAgeMs >= resolveRunStaleThresholdMs(activity, evidenceAgeMs, params.staleAbortMs);
}

function formatRecoveryContext(
  params: StuckSessionRecoveryRequest,
  extra?: { activeSessionId?: string; lane?: string; activeCount?: number; queuedCount?: number },
): string {
  const fields = [
    `sessionId=${params.sessionId ?? extra?.activeSessionId ?? "unknown"}`,
    `sessionKey=${params.sessionKey ?? "unknown"}`,
    `age=${Math.round(params.ageMs / 1000)}s`,
    `queueDepth=${params.queueDepth ?? 0}`,
  ];
  if (extra?.activeSessionId) {
    fields.push(`activeSessionId=${extra.activeSessionId}`);
  }
  if (extra?.lane) {
    fields.push(`lane=${extra.lane}`);
  }
  if (extra?.activeCount !== undefined) {
    fields.push(`laneActive=${extra.activeCount}`);
  }
  if (extra?.queuedCount !== undefined) {
    fields.push(`laneQueued=${extra.queuedCount}`);
  }
  return fields.join(" ");
}

function reportRecoveryOutcome(outcome: StuckSessionRecoveryOutcome): StuckSessionRecoveryOutcome {
  diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
  return outcome;
}

/**
 * Recovery aborts are aborts: record them through the same abort-target owner
 * the user Stop path uses (markSessionAbortTarget) so sessions.list reports
 * abortedLastRun=true instead of looking like a clean end.
 */
async function markRecoveryAbortedSession(params: {
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  try {
    await markSessionAbortTarget({
      scope: { sessionKey },
      // Only mark the row that still belongs to the aborted run; a reset or
      // replacement session must not inherit the stale abort.
      isCurrent: () => {
        if (!params.sessionId) {
          return true;
        }
        const entry = loadSessionEntry({ sessionKey, clone: false });
        return !entry || entry.sessionId === params.sessionId;
      },
    });
  } catch (err) {
    diag.warn(
      `stuck session recovery: failed to persist abortedLastRun sessionKey=${sessionKey} err=${String(err)}`,
    );
  }
}

export async function recoverStuckDiagnosticSession(
  params: StuckSessionRecoveryRequest,
): Promise<StuckSessionRecoveryOutcome> {
  const key = resolveStuckSessionRecoveryRef(params);
  if (!key || recoveriesInFlight.has(key)) {
    return {
      status: "skipped",
      action: "observe_only",
      reason: key ? "already_in_flight" : "missing_session_ref",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
  }

  recoveriesInFlight.add(key);
  try {
    // Abort only the generation/state that triggered recovery; stale warnings become observe-only.
    if (
      !isDiagnosticSessionStateCurrent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        generation: params.stateGeneration,
        state: params.expectedState ?? "processing",
      })
    ) {
      return {
        status: "skipped",
        action: "observe_only",
        reason: "stale_session_state",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
    }
    const terminalWorkerError = params.sessionId
      ? recoverTerminalSessionPlacementTurn({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        })
      : undefined;
    if (terminalWorkerError !== undefined) {
      // The placement owner already recorded failure and released its cleanup wait.
      // Let ordinary turn completion unwind the reply and lane instead of resetting them.
      return reportRecoveryOutcome({
        status: "failed",
        action: "fail_worker_turn",
        reason: "terminal_worker",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        error: terminalWorkerError,
      });
    }
    const fallbackActiveSessionId =
      params.sessionId && isEmbeddedAgentRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    const fileActiveSessionId = params.sessionFile
      ? resolveActiveEmbeddedRunHandleSessionIdBySessionFile(params.sessionFile)
      : undefined;
    let activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ??
        fileActiveSessionId ??
        fallbackActiveSessionId)
      : (fileActiveSessionId ?? fallbackActiveSessionId);
    const fileActiveWorkSessionId = params.sessionFile
      ? resolveActiveEmbeddedRunSessionIdBySessionFile(params.sessionFile)
      : undefined;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ??
        fileActiveWorkSessionId ??
        params.sessionId)
      : (fileActiveWorkSessionId ?? params.sessionId);
    const retireStaleFollowupDrain = prepareStaleFollowupDrainRetirement(key);
    const sessionLane = resolveEmbeddedSessionLane(key);
    const preAbortActiveTaskIds = new Set(getCommandLaneActiveTaskIds(sessionLane));
    let aborted = false;
    let drained = true;
    let forceCleared = false;
    const staleActiveProgressAbortMs = resolveStaleActiveProgressAbortMs(params);
    const staleActiveLaneTaskReleaseMs = resolveStaleActiveLaneTaskReleaseMs(params);
    const activeReplyActivity = activeWorkSessionId
      ? resolveEmbeddedReplyActivity(activeWorkSessionId)
      : undefined;
    const activeReplyPhase = activeReplyActivity?.phase;
    // Phase changes refresh the reply operation's activity clock. Session
    // attention age may predate maintenance, so it cannot own this timeout.
    const activeReplyAgeMs = activeReplyActivity
      ? Math.max(0, Date.now() - activeReplyActivity.lastActivityAtMs)
      : undefined;
    const maintenancePhase =
      activeReplyPhase === "preflight_compacting" || activeReplyPhase === "memory_flushing";
    const activeMaintenanceProtected =
      maintenancePhase &&
      activeReplyAgeMs !== undefined &&
      activeReplyAgeMs < staleActiveLaneTaskReleaseMs;

    if (activeReplyActivity?.terminalOutcomeCommitted === true) {
      // The turn already produced its reply and only delivery/finalization is
      // left, so the no-progress premise is false. Aborting here discards a
      // completed answer; the finalization lease still bounds this owner.
      return reportRecoveryOutcome({
        status: "skipped",
        action: "keep_lane",
        reason: "terminal_outcome_committed",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        activeSessionId: activeWorkSessionId,
        activeWorkKind: "embedded_run",
      });
    }

    // Invariant: waiting_for_global_lane is only "healthy waiting" while the
    // operation does not hold a global slot. The phase is cleared after
    // placement admission, not at slot grant, so an admitted task that stalls
    // in between holds capacity while still reading as a waiter. When every
    // slot is held that way the lane can never drain and keep_lane deadlocks.
    const globalLaneWaitDeadlock = resolveStaleGlobalLaneSlotHolder({
      phase: activeReplyPhase,
      slotLane: activeReplyActivity?.globalLaneSlotHeld,
      activeReplyAgeMs,
      staleAbortMs: staleActiveProgressAbortMs,
    });
    if (globalLaneWaitDeadlock) {
      diag.warn(
        `stuck session recovery releasing stale global lane slot: ${formatRecoveryContext(params, {
          activeSessionId: activeWorkSessionId,
        })} globalLane=${globalLaneWaitDeadlock.lane} laneActive=${globalLaneWaitDeadlock.activeCount} laneQueued=${globalLaneWaitDeadlock.queuedCount} replyIdleMs=${activeReplyAgeMs}`,
      );
    }
    if (
      (activeReplyPhase === "waiting_for_global_lane" && !globalLaneWaitDeadlock) ||
      activeMaintenanceProtected
    ) {
      // Queued replies and configured maintenance own their lane until their
      // producer finishes or the existing compaction safety window expires.
      return reportRecoveryOutcome({
        status: "skipped",
        action: "keep_lane",
        reason: activeMaintenanceProtected ? "active_reply_work" : "global_lane_wait",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        activeSessionId: activeWorkSessionId,
      });
    }

    if (activeSessionId) {
      const reclaimStaleActiveRun = isActiveRunProgressStale({
        ageMs: params.ageMs,
        sessionId: activeSessionId,
        sessionKey: params.sessionKey,
        queueDepth: params.queueDepth,
        staleAbortMs: staleActiveProgressAbortMs,
        allowActiveAbort: params.allowActiveAbort,
        repeatedRequestNoProgressAbortMs: params.repeatedRequestNoProgressAbortMs,
      });
      if (!reclaimStaleActiveRun) {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "observe_only",
          reason: "active_embedded_run",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId,
          activeWorkKind: "embedded_run",
        };
        diag.warn(
          `stuck session recovery skipped: ${formatRecoveryContext(params, { activeSessionId })}`,
        );
        return reportRecoveryOutcome(outcome);
      }
      if (params.allowActiveAbort !== true) {
        diag.warn(
          `stuck session recovery reclaiming stale active run: ${formatRecoveryContext(params, { activeSessionId })}`,
        );
      }
      // Active embedded runs own their cleanup; registry terminal settle bounds
      // lane release if the owner never drains after this abort.
      const recoveryBlocker = resolveActiveEmbeddedRunRecoveryBlocker(activeSessionId);
      if (recoveryBlocker) {
        return {
          status: "skipped",
          action: "keep_lane",
          reason: recoveryBlocker,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId,
        };
      }
      const result = await abortAndDrainEmbeddedAgentRun({
        sessionId: activeSessionId,
        sessionKey: params.sessionKey,
        settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
        forceClear: true,
        reason: "stuck_recovery",
      });
      aborted = result.aborted;
      drained = result.drained;
      forceCleared = result.forceCleared;
    }

    if (!activeSessionId && activeWorkSessionId && isEmbeddedAgentRunActive(activeWorkSessionId)) {
      if (activeReplyPhase === "waiting_for_deferred_maintenance") {
        return reportRecoveryOutcome({
          status: "skipped",
          action: "keep_lane",
          reason: "deferred_maintenance_wait",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId: activeWorkSessionId,
        });
      }
      const reclaimStaleReplyWork = isActiveRunProgressStale({
        ageMs: params.ageMs,
        sessionId: activeWorkSessionId,
        sessionKey: params.sessionKey,
        queueDepth: params.queueDepth,
        staleAbortMs: staleActiveProgressAbortMs,
        allowActiveAbort: params.allowActiveAbort,
        repeatedRequestNoProgressAbortMs: params.repeatedRequestNoProgressAbortMs,
        // Maintenance retains its backlog gate after the safety window;
        // other abandoned reply ownership must expire even without a queue.
        requireQueueBacklog: maintenancePhase ? undefined : false,
      });
      if (reclaimStaleReplyWork) {
        if (params.allowActiveAbort !== true) {
          diag.warn(
            `stuck session recovery reclaiming stale active reply work: ${formatRecoveryContext(
              params,
              { activeSessionId: activeWorkSessionId },
            )}`,
          );
        }
        const result = await abortAndDrainEmbeddedAgentRun({
          sessionId: activeWorkSessionId,
          sessionKey: params.sessionKey,
          settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
          forceClear: true,
          reason: "stuck_recovery",
        });
        aborted = result.aborted;
        drained = result.drained;
        forceCleared = result.forceCleared;
        activeSessionId = activeWorkSessionId;
      } else {
        return reportRecoveryOutcome({
          status: "skipped",
          action: "keep_lane",
          reason: "active_reply_work",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId: activeWorkSessionId,
          activeWorkKind: "embedded_run",
        });
      }
    }

    // A terminal outcome can commit after the initial snapshot but before the
    // abort owner checks it. Its finalization lease still owns lane release.
    if (
      activeSessionId &&
      resolveEmbeddedReplyActivity(activeSessionId)?.terminalOutcomeCommitted
    ) {
      return reportRecoveryOutcome({
        status: "skipped",
        action: "keep_lane",
        reason: "terminal_outcome_committed",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        activeSessionId,
      });
    }
    if (!activeSessionId) {
      const laneSnapshot = getCommandLaneSnapshot(sessionLane);
      if (laneSnapshot.activeCount > 0) {
        const laneStartedFreshTask = getCommandLaneActiveTaskIds(sessionLane).some(
          (id) => !preAbortActiveTaskIds.has(id),
        );
        // Orphaned active lane tasks have no run handle to abort. Release only
        // after the ownerless-lane window and only if no fresh task appeared.
        if (!laneStartedFreshTask && params.ageMs >= staleActiveLaneTaskReleaseMs) {
          const released = resetCommandLane(sessionLane);
          retireStaleFollowupDrain?.();
          return reportRecoveryOutcome({
            status: "released",
            action: "release_lane",
            reason: "stale_lane_task",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            lane: sessionLane,
            released,
            queuedCount: laneSnapshot.queuedCount,
          });
        }
        return reportRecoveryOutcome({
          status: "skipped",
          action: "keep_lane",
          reason: "active_lane_task",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          lane: sessionLane,
          activeCount: laneSnapshot.activeCount,
          queuedCount: laneSnapshot.queuedCount,
        });
      }
    }

    const queuedCount = getCommandLaneSnapshot(sessionLane).queuedCount;
    // A task id active now but not before the abort means the lane already
    // unwedged and pumped fresh work; resetting it would double-run the lane.
    const laneStartedFreshTask = getCommandLaneActiveTaskIds(sessionLane).some(
      (id) => !preAbortActiveTaskIds.has(id),
    );
    // Queued turns ride the session queue (params.queueDepth), not only the lane
    // queue; without this signal a cleanly aborted wedged lane never resets.
    const hasQueuedSessionWork = (params.queueDepth ?? 0) > 0;
    const released =
      !laneStartedFreshTask &&
      (queuedCount > 0 || hasQueuedSessionWork || !activeSessionId || !aborted || !drained)
        ? resetCommandLane(sessionLane)
        : 0;

    const clearStaleSession = !aborted && released === 0 && !activeSessionId;

    if (aborted || forceCleared || released > 0 || clearStaleSession) {
      retireStaleFollowupDrain?.();
      const action = aborted || forceCleared ? "abort_embedded_run" : "release_lane";
      if (action === "abort_embedded_run") {
        await markRecoveryAbortedSession({
          sessionKey: params.sessionKey,
          sessionId: activeSessionId ?? params.sessionId,
        });
      }
      void logWithSessionDiagnosticContext({
        level: "warn",
        sessionKey: params.sessionKey,
        activeSessionId,
        cronNameLabel: "stopped",
        format: (stoppedFields) =>
          `stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${
            params.sessionKey ?? "unknown"
          } age=${Math.round(params.ageMs / 1000)}s action=${action} aborted=${aborted} drained=${drained} released=${released}${
            stoppedFields ? ` ${stoppedFields}` : ""
          }`,
      });
      return reportRecoveryOutcome(
        aborted || forceCleared
          ? {
              status: "aborted",
              action: "abort_embedded_run",
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              activeSessionId,
              activeWorkKind: "embedded_run",
              aborted,
              drained,
              forceCleared,
              released,
              lane: sessionLane,
              ...(queuedCount > 0 ? { queuedCount } : {}),
            }
          : {
              status: "released",
              action: "release_lane",
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              released,
              lane: sessionLane,
              ...(clearStaleSession ? { reason: "no_active_work" as const } : {}),
            },
      );
    }
    // An active run that neither aborted nor released still owns its work. Reporting
    // recovery here would clear the session's diagnostic state out from under it.
    return reportRecoveryOutcome({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeSessionId,
      activeWorkKind: "embedded_run",
    });
  } catch (err) {
    const outcome: StuckSessionRecoveryOutcome = {
      status: "failed",
      action: "none",
      reason: "exception",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      error: String(err),
    };
    diag.warn(
      `stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
        params.sessionKey ?? "unknown"
      } err=${String(err)}`,
    );
    return outcome;
  } finally {
    recoveriesInFlight.delete(key);
  }
}
