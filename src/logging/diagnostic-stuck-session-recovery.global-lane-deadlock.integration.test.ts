// T3790: stuck-session recovery must not keep_lane forever on global_lane_wait
// when the "waiting" operation already holds the global slot. Real command
// queue lanes, the real embedded lane controller (global-lane admission, slot
// grant, session placement admission) and a real reply operation. Only the
// model provider and the placement transport are scripted. Nothing in this
// file marks the slot grant itself: that has to come from lane-controller.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { createEmbeddedRunLaneController } from "../agents/embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const GLOBAL_LANE = "main";
const NO_WARN = { warnAfterMs: Number.MAX_SAFE_INTEGER };
const STALE_AGE_MS = 2_100_000; // the incident: age over 2,000 s

type ScriptedProvider = {
  readonly calls: number;
  call(signal: AbortSignal): Promise<void>;
};

/**
 * Provider that answers the first call with a 429 and then stalls until the
 * run is aborted, as a real transport does on cancel. `stall: false` makes the
 * retry succeed instead, for the healthy-path test.
 */
function scriptedRateLimitThenStallProvider(options: { stall?: boolean } = {}): ScriptedProvider {
  const stall = options.stall ?? true;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async call(signal: AbortSignal): Promise<void> {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("429 This request would exceed your account's rate limit"), {
          status: 429,
        });
      }
      if (!stall) {
        return;
      }
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("Provider call aborted", { cause: signal.reason }));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new Error("Provider call aborted", { cause: signal.reason })),
          { once: true },
        );
      });
    },
  };
}

/**
 * Starts a turn through the production embedded lane controller
 * (enqueueSession -> enqueueGlobal). The controller marks the reply as waiting
 * for global capacity, records the slot grant when the global lane admits the
 * task (lane-controller.ts), and enters session placement admission. The
 * scripted placement transport calls the provider there: 429, then a stall, so
 * the turn holds the slot without reaching the placement callback that clears
 * the waiting phase.
 */
function startTurn(params: {
  sessionKey: string;
  sessionId: string;
  runId: string;
  provider: ScriptedProvider;
}) {
  const operation = createReplyOperation({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    resetTriggered: false,
  });
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  let runParams = {
    admittedRunContext: createTestAdmittedRunContext(params.runId),
    lifecycleGeneration,
    prompt: "global lane deadlock turn",
    replyOperation: operation,
    runId: params.runId,
    sessionFile: "/tmp/global-lane-deadlock.jsonl",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    timeoutMs: 86_400_000,
  } as RunEmbeddedAgentParams & { sessionFile: string };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => runParams,
    globalLane: GLOBAL_LANE,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: resolveEmbeddedSessionLane(params.sessionKey),
    setLifecycleGeneration: (updated) => {
      lifecycleGeneration = updated;
    },
    setParams: (updated) => {
      runParams = updated as typeof runParams;
    },
  });
  operation.setPhase("running");
  const cancel = vi.fn(() => {
    controller.laneTaskReleaseController.abort(new Error("stuck session recovery abort"));
    queueMicrotask(() => operation.complete());
  });
  operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
  // Observed inside the admitted attempt, i.e. after placement admission.
  const attemptObservations: Array<{ phase: string; slot: string | undefined }> = [];
  const runLocal = async (): Promise<EmbeddedAgentRunResult> => {
    attemptObservations.push({ phase: operation.phase, slot: operation.globalLaneSlotHeld });
    return { meta: { durationMs: 1 } };
  };
  const run = controller.enqueueSession(() => controller.enqueueGlobal(runLocal));
  run.catch(() => {});
  return { operation, controller, cancel, run, attemptObservations };
}

describe("stuck session recovery: global lane wait deadlock (T3790)", () => {
  let provider: ScriptedProvider;
  let currentSignal: () => AbortSignal;
  let uninstallPlacement: (() => void) | undefined;

  const installPlacement = () => {
    const throughProvider = async <T>(runLocal: () => Promise<T>): Promise<T> => {
      try {
        await provider.call(currentSignal());
      } catch (error) {
        if (currentSignal().aborted) {
          throw error;
        }
        // The 429 ended the first attempt; the retry runs before placement.
      }
      await provider.call(currentSignal());
      return await runLocal();
    };
    uninstallPlacement = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: () => {
        throw new Error("unexpected compaction successor in deadlock test");
      },
      executeLocalTurn: async (_claim, runLocal) => await throughProvider(runLocal),
      executeTurn: async (_claim, _params, runLocal) => await throughProvider(runLocal),
    });
  };

  beforeEach(() => {
    resetAgentEventsForTest();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(GLOBAL_LANE, 1);
  });

  afterEach(() => {
    uninstallPlacement?.();
    uninstallPlacement = undefined;
    vi.useRealTimers();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetAgentEventsForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  it("releases a global slot held by a stale waiting_for_global_lane turn so queued dispatch runs", async () => {
    provider = scriptedRateLimitThenStallProvider();
    const sessionKey = "agent:builder:mission-control-forge-wedged";
    const sessionId = "wedged-429-session";
    const turn = startTurn({ sessionKey, sessionId, runId: "wedged-run", provider });
    currentSignal = () => turn.controller.abortSignal;
    installPlacement();

    await vi.waitFor(() => expect(provider.calls).toBe(2));
    expect(turn.operation.phase).toBe("waiting_for_global_lane");
    // Recorded by the lane controller's admitted global task, not by the test.
    expect(turn.operation.globalLaneSlotHeld).toBe(GLOBAL_LANE);

    const next = enqueueCommandInLane(GLOBAL_LANE, async () => "next-dispatch", NO_WARN);
    expect(getCommandLaneSnapshot(GLOBAL_LANE)).toMatchObject({ activeCount: 1, queuedCount: 1 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + STALE_AGE_MS);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: STALE_AGE_MS,
      queueDepth: 0,
      allowActiveAbort: true,
    });

    expect(outcome).not.toMatchObject({ reason: "global_lane_wait" });
    expect(outcome).toMatchObject({ status: "aborted", aborted: true });
    expect(turn.cancel).toHaveBeenCalled();
    await expect(next).resolves.toBe("next-dispatch");
    expect(turn.attemptObservations).toEqual([]);
  });

  it("keeps the lane for a healthy queued waiter that holds no global slot", async () => {
    provider = scriptedRateLimitThenStallProvider();
    // A live turn owns the only global slot.
    void enqueueCommandInLane(GLOBAL_LANE, () => new Promise<never>(() => {}), NO_WARN);
    const sessionKey = "agent:main:queued-waiter";
    const sessionId = "queued-waiter-session";
    const turn = startTurn({ sessionKey, sessionId, runId: "queued-waiter-run", provider });
    currentSignal = () => turn.controller.abortSignal;
    installPlacement();

    await vi.waitFor(() => expect(getCommandLaneSnapshot(GLOBAL_LANE).queuedCount).toBe(1));
    expect(turn.operation.phase).toBe("waiting_for_global_lane");
    expect(turn.operation.globalLaneSlotHeld).toBeUndefined();
    expect(provider.calls).toBe(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + STALE_AGE_MS);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: STALE_AGE_MS,
      queueDepth: 0,
      allowActiveAbort: true,
    });
    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "global_lane_wait",
    });
    expect(turn.cancel).not.toHaveBeenCalled();
  });

  it("keeps the lane while the slot holder still shows fresh reply progress", async () => {
    provider = scriptedRateLimitThenStallProvider();
    const sessionKey = "agent:main:fresh-holder";
    const sessionId = "fresh-holder-session";
    const turn = startTurn({ sessionKey, sessionId, runId: "fresh-holder-run", provider });
    currentSignal = () => turn.controller.abortSignal;
    installPlacement();

    await vi.waitFor(() => expect(provider.calls).toBe(2));
    expect(turn.operation.globalLaneSlotHeld).toBe(GLOBAL_LANE);
    void enqueueCommandInLane(GLOBAL_LANE, async () => "next", NO_WARN);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: STALE_AGE_MS,
      queueDepth: 0,
      allowActiveAbort: true,
    });
    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "global_lane_wait",
    });
    expect(turn.cancel).not.toHaveBeenCalled();
  });

  it("clears the slot flag and the waiting phase at placement admission, before the attempt runs", async () => {
    provider = scriptedRateLimitThenStallProvider({ stall: false });
    const turn = startTurn({
      sessionKey: "agent:main:recovers-after-429",
      sessionId: "recovers-after-429-session",
      runId: "recovers-after-429-run",
      provider,
    });
    currentSignal = () => turn.controller.abortSignal;
    installPlacement();

    await expect(turn.run).resolves.toMatchObject({ meta: { durationMs: 1 } });
    expect(provider.calls).toBe(2);
    // Provider retries inside the attempt run after the waiting phase ended,
    // so the stale-slot carve-out cannot reach them.
    expect(turn.attemptObservations).toHaveLength(1);
    expect(turn.attemptObservations[0]?.phase).not.toBe("waiting_for_global_lane");
    expect(turn.attemptObservations[0]?.slot).toBeUndefined();
    expect(turn.operation.globalLaneSlotHeld).toBeUndefined();
  });
});
