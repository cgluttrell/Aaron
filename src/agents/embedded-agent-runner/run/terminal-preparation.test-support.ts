import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import type { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

export async function prepareAttempt(input: {
  attempt: EmbeddedRunAttemptWithReceiptEvidence;
  admittedRunContext?: ReturnType<typeof createTestAdmittedRunContext>;
  currentAttemptCompletedAssistant?: AssistantMessage;
  sourceReplyDeliveryMode?: "message_tool_only";
  heartbeat?: { continuesConversation: boolean };
  replyDeliveryState?: Parameters<typeof prepareEmbeddedRunTerminal>[0]["replyDeliveryState"];
  terminalState: EmbeddedRunTerminalState;
}) {
  const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
  return prepareEmbeddedRunTerminal({
    runParams: {
      admittedRunContext: input.admittedRunContext ?? createTestAdmittedRunContext("run-focused"),
      sessionId: "session-focused",
      runId: "run-focused",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "hi",
      trigger: input.heartbeat ? "heartbeat" : "user",
      ...(input.heartbeat?.continuesConversation ? { continuesConversation: true } : {}),
      timeoutMs: 60_000,
      ...(input.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: input.sourceReplyDeliveryMode }
        : {}),
    },
    attempt: input.attempt,
    currentAttemptCompletedAssistant: input.currentAttemptCompletedAssistant,
    provider: "openai",
    model: "gpt-5.4",
    activeErrorContext: { provider: "openai", model: "gpt-5.4" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: input.attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: input.terminalState,
    replyDeliveryState: input.replyDeliveryState,
  });
}
