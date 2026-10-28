import { releaseCompletionCustody } from "./native-subagent-admission-custody.js";
import type { NativeSubagentAssignment } from "./native-subagent-assignment.js";
import type {
  KnownChild,
  NativeTurnObservation,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { matchesNativeAssignmentLifecycle } from "./native-subagent-pending-assignments.js";

/** Parent registrations that share the source requester's session lifecycle. */
export function selectRequesterParentStates(
  states: Iterable<ParentState>,
  source: ParentState,
): ParentState[] {
  return [...states].filter(
    (state) =>
      state === source ||
      Boolean(
        source.requesterSessionKey &&
        state.requesterSessionKey === source.requesterSessionKey &&
        state.agentId === source.agentId &&
        source.historyOwner &&
        state.historyOwner &&
        matchesNativeAssignmentLifecycle(source.historyOwner, state.historyOwner),
      ),
  );
}

/**
 * Rebuilds a restored child's pending and observed native turns. Pending turns that still hold
 * a model source keep their completion custody; every other superseded pending turn releases it.
 */
export function restoreKnownChildTurns(
  assignment: NativeSubagentAssignment,
  observedTurns: readonly NativeTurnObservation[],
  previous: KnownChild | undefined,
): Pick<KnownChild, "pendingTurns" | "observedTurns"> {
  const currentIndex = observedTurns.findIndex((turn) => turn.turnId === assignment.nativeTurnId);
  const pendingTurns: KnownChild["pendingTurns"] = observedTurns
    .filter((turn, index) => index > currentIndex && turn.turnId !== assignment.nativeTurnId)
    .map((turn, index, turns) => ({
      turnId: turn.turnId,
      state: turn.state === "active" && index < turns.length - 1 ? undefined : turn.state,
    }));
  const retainedPending = previous?.pendingTurns.filter((pending) => pending.modelSource) ?? [];
  for (const retained of retainedPending) {
    const recovered = pendingTurns.find((pending) => pending.turnId === retained.turnId);
    if (recovered) {
      recovered.modelSource = retained.modelSource;
      recovered.completionCustody = retained.completionCustody;
      retained.completionCustody = undefined;
    } else {
      pendingTurns.push(retained);
    }
  }
  for (const pending of previous?.pendingTurns ?? []) {
    if (!pendingTurns.includes(pending)) {
      releaseCompletionCustody(pending);
    }
  }
  const turnIds = new Set(
    [assignment.nativeTurnId, ...observedTurns.map((turn) => turn.turnId)].filter(
      (id): id is string => Boolean(id),
    ),
  );
  return {
    pendingTurns,
    observedTurns: new Map(
      [...turnIds].map((turnId) => [
        turnId,
        pendingTurns.some((turn) => turn.turnId === turnId) ? { awaitingInteraction: true } : {},
      ]),
    ),
  };
}
