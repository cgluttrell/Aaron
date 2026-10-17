// T3790: stuck-session recovery must not keep_lane forever on global_lane_wait
// when the "waiting" operation already holds the global slot. Real command
// queue lanes and a real reply operation; only the model provider is scripted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
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

/** Provider that answers the first call with a 429 and never answers again. */
function scriptedRateLimitThenStallProvider() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async call(): Promise<never> {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("429 This request would exceed your account's rate limit"), {
          status: 429,
        });
      }
      return new Promise<never>(() => {});
    },
  };
}

/**
 * Mirrors the embedded lane controller: the session lane task marks the reply
 * as waiting for global capacity and enqueues on the global lane; the admitted
 * task records the slot grant and never reaches placement admission (which is
 * what clears the waiting phase). Run cancel aborts the lane release signal,
 * as the controller's laneTaskReleaseController does.
 */
function startWedgedTurn(params: { sessionKey: string; sessionId: string; holdSlot: boolean }) {
  const operation = createReplyOperation({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    resetTriggered: false,
  });
  operation.setPhase("running");
  const release = new AbortController();
  const cancel = vi.fn(() => {
    release.abort();
    queueMicrotask(() => operation.complete());
  });
  operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
  const provider = scriptedRateLimitThenStallProvider();
  void enqueueCommandInLane(
    resolveEmbeddedSessionLane(params.sessionKey),
    async () => {
      operation.markWaitingForGlobalLane();
      return enqueueCommandInLane(
        GLOBAL_LANE,
        async () => {
          if (params.holdSlot) {
            // Optional call keeps this test runnable against pre-fix code,
            // where it reproduces the keep_lane deadlock.
            operation.markGlobalLaneSlotGranted?.(GLOBAL_LANE);
          }
          try {
            await provider.call();
          } catch {
            // 429 ended the attempt; the retry stalls before placement admission.
          }
          await provider.call();
        },
        { ...NO_WARN, taskTimeoutMs: 86_400_000, taskTimeoutReleaseSignal: release.signal },
      );
    },
    NO_WARN,
  ).catch(() => {});
  return { operation, provider, cancel };
}

describe("stuck session recovery: global lane wait deadlock (T3790)", () => {
  afterEach(() => {
    vi.useRealTimers();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  it("releases a global slot held by a stale waiting_for_global_lane turn so queued dispatch runs", async () => {
    setCommandLaneConcurrency(GLOBAL_LANE, 1);
    const sessionKey = "agent:builder:mission-control-forge-wedged";
    const sessionId = "wedged-429-session";
    const { operation, provider, cancel } = startWedgedTurn({
      sessionKey,
      sessionId,
      holdSlot: true,
    });
    await vi.waitFor(() => expect(provider.calls).toBe(2));
    expect(operation.phase).toBe("waiting_for_global_lane");

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
    expect(cancel).toHaveBeenCalled();
    await expect(next).resolves.toBe("next-dispatch");
  });

  it("keeps the lane for a healthy queued waiter that holds no global slot", async () => {
    setCommandLaneConcurrency(GLOBAL_LANE, 1);
    // A live turn owns the only global slot.
    void enqueueCommandInLane(GLOBAL_LANE, () => new Promise<never>(() => {}), NO_WARN);
    const sessionKey = "agent:main:queued-waiter";
    const sessionId = "queued-waiter-session";
    const { operation, cancel } = startWedgedTurn({ sessionKey, sessionId, holdSlot: false });
    await vi.waitFor(() => expect(operation.phase).toBe("waiting_for_global_lane"));
    expect(operation.globalLaneSlotHeld).toBeUndefined();

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
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the lane while the slot holder still shows fresh reply progress", async () => {
    setCommandLaneConcurrency(GLOBAL_LANE, 1);
    const sessionKey = "agent:main:fresh-holder";
    const sessionId = "fresh-holder-session";
    const { operation, provider, cancel } = startWedgedTurn({
      sessionKey,
      sessionId,
      holdSlot: true,
    });
    await vi.waitFor(() => expect(provider.calls).toBe(2));
    expect(operation.globalLaneSlotHeld).toBe(GLOBAL_LANE);
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
    expect(cancel).not.toHaveBeenCalled();
  });
});
