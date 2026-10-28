import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentAssignmentStore } from "./native-subagent-pending-assignments.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";

export function createNativeSubagentAssignmentStore(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  owner: CodexNativeSubagentHistoryOwner;
  assertLifecycleCurrent?: () => void;
}): CodexNativeSubagentAssignmentStore {
  const { bindingStore, identity, owner } = params;
  const assertCurrent = () => {
    params.assertLifecycleCurrent?.();
    const binding = bindingStore.read(identity);
    if (!binding || !matchesCodexNativeSubagentSubmissionBinding(binding, owner)) {
      throw new Error("Native assignment binding is no longer current.");
    }
  };
  return {
    assertCurrent,
    read: () => {
      assertCurrent();
      return bindingStore.readNativeSubagentAssignments?.(identity, owner) ?? [];
    },
    record: (assignment, assertSourceCurrent) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-assignment", owner, assignment },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
      ),
    consume: async (assignment, assertSourceCurrent, undelivered) => {
      const applied = await bindingStore.mutate(
        identity,
        {
          kind: "consume-native-subagent-assignment",
          owner,
          assignment,
          ...(undelivered ? { undelivered: true } : {}),
        },
        () => {
          assertCurrent();
          assertSourceCurrent();
        },
      );
      if (applied && undelivered) {
        embeddedAgentLog.warn("Native subagent completion retired without delivery", {
          childThreadId: assignment.childThreadId,
          nativeTurnId: assignment.nativeTurnId,
          status: undelivered.status,
          childSessionKey: assignment.runId,
        });
        try {
          if (identity.kind !== "session" || !identity.sessionKey) {
            throw new Error("Native completion has no parent transcript identity.");
          }
          const note = await appendSessionTranscriptMessageByIdentityStrict({
            agentId: identity.agentId,
            sessionId: owner.sessionId,
            sessionKey: identity.sessionKey,
            updateMode: "inline",
            message: {
              role: "custom",
              customType: "openclaw.system-note",
              display: true,
              content:
                `Native subagent ${assignment.childThreadId} finished with status ${undelivered.status}, but its completion could not be delivered. Automatic delivery has stopped. Inspect its native Codex thread history${assignment.nativeTurnId ? ` at turn ${assignment.nativeTurnId}` : ""}; child session key: ${assignment.runId}.`.slice(
                  0,
                  2_048,
                ),
              timestamp: Date.now(),
              idempotencyKey: `codex-undelivered:${owner.lifecycleRevision ?? owner.sessionId}:${assignment.childThreadId}:${assignment.nativeTurnId ?? "initial"}`,
            },
          });
          if (note.kind !== "result") {
            throw new Error(`Native completion note was ${note.kind}.`);
          }
        } catch (error) {
          // A failed notice must never restart the retired completion's delivery.
          embeddedAgentLog.warn("Could not persist native completion retirement note", {
            childSessionKey: assignment.runId,
            error: formatErrorMessage(error),
          });
        }
      }
      return applied;
    },
  };
}
