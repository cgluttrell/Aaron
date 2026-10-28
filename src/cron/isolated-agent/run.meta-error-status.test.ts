import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { expectObjectFields } from "../../test-utils/mock-call-assertions.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState, type DeferredCronNotifications } from "../service/state.js";
import { applyJobResult } from "../service/timer-outcomes.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  callGatewayMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  runWithModelFallbackMock,
  mockRunCronFallbackPassthrough,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const runTurn = (overrides = {}) =>
  runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture(overrides));
const failedRun = { provider: "openai", model: "gpt-5.4", usage: { input: 0, output: 0 } };
function mockAgentRun({
  provider = "anthropic",
  model = "claude-opus-4-8",
  usage = { input: 10, output: 0 },
  meta = {},
  ...result
}: {
  provider?: string;
  model?: string;
  usage?: { input: number; output: number };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
} = {}) {
  runWithModelFallbackMock.mockResolvedValueOnce({
    result: { result: { payloads: [], ...result, meta: { agentMeta: { usage }, ...meta } } },
    provider,
    model,
    attempts: [],
  });
}
function mockChildRun(payloads: unknown[] = [], output = 1) {
  mockAgentRun({
    payloads,
    usage: { input: 10, output },
    acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:default:child" }],
  });
}
function mockAnnounceOutcome(
  payloads: unknown[] = [],
  text?: string,
  overrides: Record<string, unknown> = {},
) {
  resolveCronDeliveryPlanMock.mockReturnValue({
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "test-target",
  });
  resolveCronPayloadOutcomeMock.mockReturnValue({
    summary: text,
    outputText: text,
    synthesizedText: text,
    deliveryPayload: payloads.at(-1),
    deliveryPayloads: payloads,
    deliveryDisposition: { kind: "visible" },
    deliveryPayloadHasStructuredContent: false,
    hasFatalErrorPayload: false,
    hasFatalStructuredErrorPayload: false,
    embeddedRunError: undefined,
    ...overrides,
  });
}
function expectDispatch(expected: Record<string, unknown>) {
  expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(expect.objectContaining(expected));
}
async function useRealOutcome() {
  const { resolveCronPayloadOutcome } =
    await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
  resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
}

describe("runCronIsolatedAgentTurn - meta.error status propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("preserves a run-level error with partial text when delivery is pending", async () => {
    mockAgentRun({
      ...failedRun,
      payloads: [{ text: "Partial success-looking text" }],
      meta: { error: { kind: "retry_limit", message: "retry limit exceeded" } },
    });
    dispatchCronDeliveryMock.mockResolvedValueOnce({
      disposition: { kind: "pending" },
      delivered: false,
      deliveryAttempted: true,
      deliveryError: "delivery failed",
      summary: "Pending child summary",
      outputText: "Pending child output",
      deliveryPayloads: [],
    });
    const result = await runTurn();
    const expectedError = "cron isolated run failed: retry limit exceeded";
    expectObjectFields(result, {
      status: "error",
      error: expectedError,
      outputText: expectedError,
      delivered: undefined,
      deliveryError: undefined,
    });
    expect(result.diagnostics?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "agent-run",
          message: expectedError,
        }),
      ]),
    );
  });

  it("marks an aborted embedded agent run without a run-level error as a cron error", async () => {
    mockAgentRun({ ...failedRun, meta: { aborted: true } });
    const result = await runTurn({
      job: makeIsolatedAgentJobFixture({ deleteAfterRun: true }),
    });
    expectObjectFields(result, { status: "error", error: "cron isolated agent run aborted" });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit silent replies as successful cron completions", async () => {
    await useRealOutcome();
    mockAgentRun({
      usage: { input: 10, output: 1 },
      meta: { finalAssistantRawText: "NO_REPLY", finalAssistantVisibleText: "NO_REPLY" },
    });
    const result = await runTurn();
    expect(dispatchCronDeliveryMock).toHaveBeenCalled();
    expectObjectFields(result, { status: "ok", error: undefined });
  });

  it.each([
    { text: "PARTIAL FAILURE: one source was unavailable", status: "error" },
    { text: "**PARTIAL FAILURE:** Autonomous Nightly Work stopped", status: "error" },
    { text: "__BLOCKED__ approval needed", status: "error" },
    { text: "## __BLOCKED__: approval needed", status: "error" },
    { text: "## BLOCKED: none", status: "ok" },
    { text: "All checks passed\n## **BLOCKED: none**", status: "ok" },
    { text: "Nightly run: **PARTIAL FAILURE:** quoted status", status: "ok" },
    { text: "## BLOCKED — approval needed", status: "error" },
    { text: "CRON_FAILURE: processing stopped", status: "error" },
    { text: "FAILED: processing stopped", status: "error" },
    { text: "Summary\n## FAILED: processing stopped", status: "error" },
    { text: "ok: all sources synchronized", status: "ok" },
    { text: "All checks passed\nPARTIAL FAILURE: quoted status from an earlier run", status: "ok" },
    {
      text: "All checks passed\n## partial failure: quoted status from an earlier run",
      status: "ok",
    },
    { text: "> PARTIAL FAILURE is a quoted example\nAll checks passed", status: "ok" },
    { text: "All checks passed; the phrase PARTIAL FAILURE was quoted", status: "ok" },
  ])("classifies final assistant reply '$text' as $status", async ({ text, status }) => {
    await useRealOutcome();
    mockAgentRun({ payloads: [{ text }], meta: { finalAssistantVisibleText: text } });
    const result = await runTurn();
    expect(result.status).toBe(status);
    expect(result.outputText).toBe(text);
    if (status === "error") {
      expect(result.error).toContain("cron agent reply reported");
    } else {
      expect(result.error).toBeUndefined();
    }
  });

  it("allows replacement and disabling of agent-turn failure markers", async () => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: "PARTIAL FAILURE: ignored by configured list" }],
      meta: { finalAssistantVisibleText: "PARTIAL FAILURE: ignored by configured list" },
    });
    expect(
      (await runTurn({ cfg: { cron: { agentTurnFailureMarkers: ["CUSTOM_FAILURE"] } } })).status,
    ).toBe("ok");
    mockAgentRun({
      payloads: [{ text: "CUSTOM_FAILURE: stopped" }],
      meta: { finalAssistantVisibleText: "CUSTOM_FAILURE: stopped" },
    });
    expect(
      (await runTurn({ cfg: { cron: { agentTurnFailureMarkers: ["CUSTOM_FAILURE"] } } })).status,
    ).toBe("error");
  });

  it("records a PARTIAL FAILURE run as error and queues its failure alert", async () => {
    await useRealOutcome();
    const text = "PARTIAL FAILURE: one source was unavailable";
    mockAgentRun({ payloads: [{ text }], meta: { finalAssistantVisibleText: text } });
    const run = await runTurn();
    const job = makeCronJob({
      id: "marker-alert-job",
      name: "Marker alert job",
      payload: { kind: "agentTurn", message: "report" },
      failureAlert: { after: 1, mode: "webhook", to: "https://example.invalid/cron-alert" },
    });
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "/tmp/cron-marker-alert-test.json",
      nowMs: () => 2_000,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const deferredNotifications: DeferredCronNotifications = [];
    applyJobResult(
      state,
      job,
      { ...run, startedAt: 1_000, endedAt: 2_000 },
      { deferredNotifications },
    );
    expect(job.state.lastStatus).toBe("error");
    expect(deferredNotifications).toEqual([expect.objectContaining({ kind: "failure-alert" })]);
  });

  it("records a real tool error when the terminal assistant reply is silent", async () => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: "⚠️ 🛠️ Bash failed: mount unavailable", isError: true }],
      meta: { finalAssistantVisibleText: "NO_REPLY" },
    });
    const result = await runTurn();
    expect(result.status).toBe("error");
    expect(result.error).toContain("Bash failed");
  });

  it.each([
    {
      // Transient-looking prose must not turn the agent's verdict into a scheduler retry.
      reply: "AUTOMATION_FAILED\nNetwork timeout: no shell tool is available in this run.",
      expected: {
        status: "error",
        error: "Network timeout: no shell tool is available in this run.",
        errorClassification: { kind: "permanent", reportedByAgent: true },
      },
    },
  ])("settles the run from a reported failure line: $expected.status", async (testCase) => {
    await useRealOutcome();
    mockAgentRun({
      payloads: [{ text: testCase.reply }],
      meta: { finalAssistantVisibleText: testCase.reply },
    });
    expectObjectFields(await runTurn(), testCase.expected);
  });

  it("preserves a heartbeat-only accepted child handoff failure as a cron error", async () => {
    const heartbeatPayload = { text: "HEARTBEAT_OK" };
    const error = "cron child-session handoff timed out before producing a final assistant payload";
    mockChildRun([heartbeatPayload]);
    mockAnnounceOutcome([heartbeatPayload], heartbeatPayload.text, {
      deliveryDisposition: { kind: "heartbeat", controlOnly: true },
    });
    dispatchCronDeliveryMock.mockImplementationOnce(() => ({
      disposition: { kind: "error", error },
      delivered: false,
      deliveryAttempted: true,
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayloads: [],
    }));
    const result = await runTurn();
    expectObjectFields(result, { status: "error", error, delivered: false });
    expect(result.summary).not.toBe(heartbeatPayload.text);
    expect(result.outputText).not.toBe(heartbeatPayload.text);
  });

  it("preserves structured-parent delivery failures after accepting a child", async () => {
    const mediaPayload = { mediaUrl: "https://example.invalid/chart.png" };
    const error = "Structured message failed";
    mockChildRun([mediaPayload]);
    mockAnnounceOutcome([mediaPayload], undefined, { deliveryPayloadHasStructuredContent: true });
    dispatchCronDeliveryMock.mockResolvedValueOnce({
      delivered: false,
      deliveryAttempted: true,
      deliveryError: error,
      deliveryState: {
        status: "not-delivered",
        delivered: false,
        error,
        failureNotification: { status: "not-requested" },
      },
      deliveryPayloads: [mediaPayload],
    });
    const result = await runTurn();
    expectDispatch({ spawnOnlyHandoff: false, deliveryPayloadHasStructuredContent: true });
    expectObjectFields(result, { status: "ok", deliveryError: error });
  });

  it("surfaces cron timeout result when the cron-nested lane watchdog fires", async () => {
    const error = new Error('Command lane "cron-nested" task timed out after 330000ms');
    error.name = "CommandLaneTaskTimeoutError";
    runWithModelFallbackMock.mockRejectedValueOnce(error);
    const result = await runTurn();
    expectObjectFields(result, {
      status: "error",
      error: "cron: job execution timed out",
      provider: "openai",
      model: "gpt-5.4",
      sessionId: "test-session-id",
    });
    expect(result.error).not.toContain("CommandLaneTaskTimeoutError");
    expect(result.error).not.toContain("cron-nested");
  });
});

const { buildEmbeddedRunPayloads } =
  await import("../../agents/embedded-agent-runner/run/payloads.js");

describe("delivered report outcome", () => {
  setupRunCronIsolatedAgentTurnSuite();
  it("records a silently completed report as successful after a final read is rate-limited", async () => {
    await useRealOutcome();
    mockRunCronFallbackPassthrough();
    const delivery = { mode: "none" as const, channel: "topicchat", to: "room#42", threadId: 42 };
    resolveCronDeliveryPlanMock.mockReturnValue({ ...delivery, requested: false });
    resolveDeliveryTargetMock.mockResolvedValue({ ...delivery, ok: true });
    const messagingToolSentTargets = [
      {
        tool: "message",
        provider: "topicchat",
        to: "room#42",
        threadId: "42",
        text: "Daily report",
      },
    ];
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: undefined,
      isCronTrigger: true,
      sessionKey: "cron:delivered-report",
      verboseLevel: "off",
      didSendViaMessagingTool: true,
      messagingToolSentTargets,
      lastToolError: {
        toolName: "codex_apps.slack.slack_read_thread",
        error: "429 RATE_LIMITED",
        mutatingAction: false,
      },
    });
    runEmbeddedAgentMock.mockResolvedValue({
      payloads,
      didSendViaMessagingTool: true,
      messagingToolSentTargets,
      meta: {
        agentMeta: { usage: { input: 10, output: 20 } },
        finalAssistantVisibleText: "NO_REPLY",
        finalAssistantRawText: "NO_REPLY",
      },
    });

    const result = await runCronIsolatedAgentTurn({
      deliveryAttemptFence: null,
      cfg: {},
      deps: {} as never,
      job: {
        id: "delivered-report",
        name: "Daily report",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Run the daily report" },
        delivery,
      } as never,
      message: "Run the daily report",
      sessionKey: "cron:delivered-report",
    });

    expect(runEmbeddedAgentMock, JSON.stringify(result)).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.delivered).toBe(true);
    expect(result.replyDisposition).toBe("silent");
  });
});
