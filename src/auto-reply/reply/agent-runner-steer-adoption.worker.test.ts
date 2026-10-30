import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { prepareReplyToolAuthorityCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { beginRestartRecoveryTerminalDelivery } from "../../config/sessions/restart-recovery-receipt.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { captureGatewayRootWorkReleaseObserver } from "../../process/gateway-work-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as steeringAuthority from "./agent-runner-fallback-authority.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { enqueueFollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { replyRunRegistry } from "./reply-run-registry.registry.js";
import {
  getReplyOperationSessionReader,
  runAfterReplyOperationClear,
} from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import * as replyToolAuthority from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

it("adopts active steering through prepared policy without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:active-worker-steering";
    const policyKey = "agent:main:active-worker-policy";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    const run = createQueueTestRun({
      prompt: "use the new requirements",
      messageId: "incoming-steer",
      originatingChannel: "webchat",
    });
    Object.assign(run.run, {
      agentId: "main",
      sessionKey: key,
      runtimePolicySessionKey: policyKey,
      senderIsOwner: true,
      config: {
        agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
        tools: { sandbox: { tools: { deny: ["exec"] } } },
      },
    });
    const operation = createTestReplyOperation({ sessionKey: key, sessionId: run.run.sessionId });
    await operation.bindToolAuthoritySnapshotAsync(
      replyToolAuthority.prepareReplyToolAuthority(run),
    );
    const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
    const delivered: string[] = [];
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      toolAuthorityFingerprint: fingerprint,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected awaited steering preparation");
        },
        async queueMessageAsync(text, options, preparation) {
          await preparation.prepareCurrent();
          preparation.assertCurrent();
          delivered.push(text);
          options?.onQueueAccepted?.(true);
        },
      },
    });
    operation.setPhase("running");
    const typing = createMockTypingController();
    const resultState: ReplyOperationRunState = {};
    const followup = vi.fn(async () => {});
    const releaseAdmissionTicket = vi.fn();
    const calls = observeMainThreadSql();
    try {
      await expect(
        runActiveReplySteer({
          followupRun: run,
          opts: { runId: "incoming-steer" },
          providedReplyOperation: operation,
          queueKey: key,
          releaseAdmissionTicket,
          replyOperationRunState: resultState,
          resolvedQueue: { mode: "steer", debounceMs: 0 },
          restartRecoverySourceTurnId: undefined,
          runFollowup: followup,
          sessionCtx: {},
          sessionKey: key,
          // The optional restart-recovery store read is separate from moved tool-policy work.
          touchActiveSessionEntry: async () => {},
          typing,
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
        }),
      ).resolves.toBe("handled");
      expect(delivered).toEqual([run.prompt]);
      expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(followup).not.toHaveBeenCalled();
      expect(releaseAdmissionTicket).toHaveBeenCalledOnce();
      calls.expectIdle();
    } finally {
      calls.restore();
      clearFollowupQueue(key);
      clearFollowupDrainCallback(key);
      operation.complete();
    }
  });
});

it.for(
  (["initial-injection", "native-backend", "native-backend-partial"] as const).flatMap((phase) =>
    (["terminal-pending", "matching-tombstone", "unrelated-tombstone"] as const).map((change) => ({
      phase,
      change,
    })),
  ),
)(
  "keeps terminal-delivery steering fenced across $phase preparation: $change",
  async ({ phase, change }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = `agent:main:terminal-steering-${phase}-${change}`;
      const messageId = `incoming-terminal-steer-${phase}-${change}`;
      const sessionId = "terminal-steering-session";
      const sourceTurnId = "active-source-turn";
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const scope = { agentId: "main", sessionKey: key, storePath };
      const entry = {
        sessionId,
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "active-run",
        restartRecoveryDeliverySourceRunId: sourceTurnId,
      };
      await upsertSessionEntryCore(scope, entry);
      const run = createQueueTestRun({
        prompt: "keep this incoming request visible",
        messageId,
        originatingChannel: "webchat",
      });
      Object.assign(run.run, {
        agentId: "main",
        sessionId,
        sessionKey: key,
        config: { session: { store: storePath }, agents: { entries: { main: {} } } },
      });
      const operation = createTestReplyOperation({ sessionKey: key, sessionId });
      await operation.bindToolAuthoritySnapshotAsync(
        replyToolAuthority.prepareReplyToolAuthority(run),
      );
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      replyRunRegistry.bindSourceTurnId(operation, sourceTurnId);
      const native = createNativeSessionBindingAuthority(
        [
          {
            read: { ...scope, env: state.env },
            sessionId,
            createSupersededError: () => new Error("native session replaced"),
          },
        ],
        () => operation.abortSignal.throwIfAborted(),
      );
      let selectingAuthorityComplete = false;
      let preparingNativeBackend = false;
      let held = false;
      const entered = createDeferred();
      const resume = createDeferred();
      const selectAuthority = steeringAuthority.resolveReplySteeringAuthority;
      vi.spyOn(steeringAuthority, "resolveReplySteeringAuthority").mockImplementation(
        async (...args) => {
          const selected = await selectAuthority(...args);
          selectingAuthorityComplete = true;
          return selected;
        },
      );
      const readFingerprint = replyToolAuthority.resolveFollowupRunToolAuthorityFingerprintAsync;
      vi.spyOn(
        replyToolAuthority,
        "resolveFollowupRunToolAuthorityFingerprintAsync",
      ).mockImplementation(async (...args) => {
        const prepared = await readFingerprint(...args);
        if (phase === "native-backend-partial" && preparingNativeBackend) {
          await prepareReplyToolAuthorityCallerRead({}, undefined, prepared, run.run, () => {});
        }
        if (
          selectingAuthorityComplete &&
          !held &&
          preparingNativeBackend === (phase !== "initial-injection")
        ) {
          held = true;
          entered.resolve();
          await withinTest(resume.promise, signal);
        }
        return prepared;
      });
      const delivered: string[] = [];
      operation.attachBackend({
        kind: "embedded",
        runId: "active-run",
        cancel() {},
        toolAuthorityFingerprint: fingerprint,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          async queueMessage() {
            throw new Error("Expected prepared native steering");
          },
          async queueMessageAsync(text, options, preparation) {
            preparingNativeBackend = true;
            await native.withPreparedCurrent!(() => {
              delivered.push(text);
              options?.onQueueAccepted?.(true);
            }, [preparation]);
          },
        },
      });
      operation.setPhase("running");
      const typing = createMockTypingController();
      const resultState: ReplyOperationRunState = {};
      const followupDelivered = createDeferred<FollowupRun>();
      const followup = vi.fn(async (queued: FollowupRun) => {
        followupDelivered.resolve(queued);
      });
      const pendingFollowups: Promise<void>[] = [];
      const runFollowup = (queued: FollowupRun) => {
        const pending = (async () => {
          const admission = await admitReplyTurn({
            agentId: queued.run.agentId,
            sessionId: queued.run.sessionId,
            sessionKey: key,
            kind: "queued_followup",
            resetTriggered: false,
          });
          expect(admission.status).toBe("owned");
          if (admission.status === "owned") {
            try {
              await followup(queued);
            } finally {
              admission.operation.complete();
            }
          }
        })();
        pendingFollowups.push(pending);
        return pending;
      };
      const outcome = runActiveReplySteer({
        followupRun: run,
        opts: { runId: messageId },
        providedReplyOperation: operation,
        queueKey: key,
        releaseAdmissionTicket() {},
        replyOperationRunState: resultState,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        restartRecoverySourceTurnId: undefined,
        runFollowup,
        sessionCtx: {},
        sessionKey: key,
        sessionEntry: entry,
        storePath,
        touchActiveSessionEntry: async () => {},
        typing,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      });
      const settlement = outcome.then(
        () => {},
        () => {},
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            outcome,
            "Steering preparation did not reach its hold",
          ),
          signal,
        );
        if (change === "terminal-pending") {
          await expect(
            beginRestartRecoveryTerminalDelivery({
              sessionId,
              sessionKey: key,
              sourceTurnId,
              storePath,
              toolCallId: "terminal-delivery-tool",
            }),
          ).resolves.toBe("started");
        } else {
          await upsertSessionEntryCore(scope, {
            restartRecoveryTerminalRunIds: [
              change === "matching-tombstone" ? sourceTurnId : "prior-source-turn",
            ],
            updatedAt: 2,
          });
        }
        expect(operation.phase).toBe("running");
        expect(operation.abortSignal.aborted).toBe(false);
        resume.resolve();
        await expect(outcome).resolves.toBe("handled");
        expect(operation.phase).toBe("running");
        expect(followup).not.toHaveBeenCalled();
        const queue = getExistingFollowupQueue(key);
        const retained = new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]);
        if (change === "unrelated-tombstone") {
          expect(delivered).toEqual([run.prompt]);
          expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
          expect([...retained]).toEqual([]);
        } else {
          expect(delivered).toEqual([]);
          expect(resultState.admission).toEqual({ status: "accepted", mode: "followup" });
          expect([...retained]).toEqual([run]);
          expect(run.steerPending).toBeUndefined();
          operation.complete();
          expect(await withinTest(followupDelivered.promise, signal)).toBe(run);
          expect(followup).toHaveBeenCalledOnce();
        }
      } finally {
        resume.resolve();
        await settlement;
        clearFollowupQueue(key);
        clearFollowupDrainCallback(key);
        operation.complete();
        await Promise.allSettled(pendingFollowups);
      }
    });
  },
);

it.for(["current", "released", "aborted", "released-overflow"] as const)(
  "settles negative backend acceptance according to %s slash-source ownership",
  async (sourceState, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const revoked = sourceState !== "current";
      const overflow = sourceState === "released-overflow";
      const key = `agent:main:negative-steer-${sourceState}`;
      const sourceKey = `agent:main:discord:slash:negative-steer-${sourceState}`;
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      await upsertSessionEntryCore(
        { agentId: "main", storePath, sessionKey: sourceKey },
        { sessionId: "slash-source", updatedAt: 1 },
      );
      const sourceAdmission = await admitReplyTurn({
        agentId: "main",
        storePath,
        sessionKey: sourceKey,
        sessionId: "slash-source",
        kind: "visible",
        resetTriggered: false,
      });
      expect(sourceAdmission.status).toBe("owned");
      if (sourceAdmission.status !== "owned") {
        throw new Error("Source admission was not owned");
      }
      const source = sourceAdmission.operation;
      const reader = getReplyOperationSessionReader(source);
      expect(reader).toBeDefined();
      if (!reader) {
        throw new Error("Source admission has no SQLite cohort reader");
      }
      const run = createQueueTestRun({
        prompt: "retain only a current rejected input",
        messageId: `negative-steer-${sourceState}`,
        originatingChannel: "webchat",
      });
      Object.assign(run.run, {
        agentId: "main",
        sessionKey: key,
        config: { session: { store: storePath }, agents: { entries: { main: {} } } },
      });
      run.abortSignal = source.abortSignal;
      const operation = createTestReplyOperation({ sessionKey: key, sessionId: run.run.sessionId });
      await operation.bindToolAuthoritySnapshotAsync(
        replyToolAuthority.prepareReplyToolAuthority(run),
      );
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      const entered = createDeferred();
      const resume = createDeferred();
      const negativeAcceptance = vi.fn();
      const backendSettled = createDeferred();
      operation.attachBackend({
        kind: "embedded",
        cancel() {},
        toolAuthorityFingerprint: fingerprint,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          async queueMessage() {
            throw new Error("Expected prepared steering");
          },
          async queueMessageAsync(_text, options, preparation) {
            try {
              await preparation.prepareCurrent();
              entered.resolve();
              await withinTest(resume.promise, signal);
              expect(options?.onQueueAccepted).toBeTypeOf("function");
              options?.onQueueAccepted?.(false);
              negativeAcceptance();
              preparation.assertCurrent();
              throw new Error("Backend refused the current input before writing");
            } finally {
              backendSettled.resolve();
            }
          },
        },
      });
      operation.setPhase("running");
      const typing = createMockTypingController();
      const drainSettled = createDeferred();
      const modelEffect = vi.fn();
      let drainObserved = false;
      const followup = vi.fn(async (queued: FollowupRun) => {
        drainObserved = true;
        const observeRelease = captureGatewayRootWorkReleaseObserver();
        expect(observeRelease).not.toBeNull();
        observeRelease?.(() => drainSettled.resolve());
        // The actual followup runner also waits for the existing target's slot.
        expect(await withinTest(replyRunRegistry.waitForIdle(key, null, { signal }), signal)).toBe(
          true,
        );
        modelEffect(queued);
      });
      const sibling = createQueueTestRun({
        prompt: "keep the later valid input",
        messageId: `sibling-${sourceState}`,
        originatingChannel: "webchat",
      });
      sibling.run = { ...run.run };
      const resultState: ReplyOperationRunState = {};
      const outcome = runActiveReplySteer({
        followupRun: run,
        opts: { runId: `negative-steer-${sourceState}`, abortSignal: source.abortSignal },
        providedReplyOperation: operation,
        assertSourceCurrent: () => {
          source.abortSignal.throwIfAborted();
          reader.assertCurrent();
        },
        queueKey: key,
        releaseAdmissionTicket() {},
        replyOperationRunState: resultState,
        resolvedQueue: {
          mode: "steer",
          debounceMs: 0,
          ...(overflow ? { cap: 1, dropPolicy: "summarize" as const } : {}),
        },
        restartRecoverySourceTurnId: undefined,
        runFollowup: followup,
        sessionCtx: {},
        sessionKey: key,
        touchActiveSessionEntry: async () => {},
        typing,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      });
      const settlement = outcome.then(
        () => {},
        () => {},
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            outcome,
            "Backend preparation did not reach its hold",
          ),
          signal,
        );
        if (overflow) {
          expect(
            enqueueFollowupRun(key, sibling, {
              mode: "steer",
              debounceMs: 0,
              cap: 1,
              dropPolicy: "summarize",
            }),
          ).toBe(true);
          expect(getExistingFollowupQueue(key)?.items).toEqual([run, sibling]);
        }
        if (sourceState === "aborted") {
          expect(source.abortByUser()).toBe(true);
        } else if (revoked) {
          source.complete();
          expect(source.abortSignal.aborted).toBe(false);
          expect(() => reader.assertCurrent()).toThrow();
        }
        resume.resolve();
        if (revoked) {
          await expect(outcome).rejects.toBeInstanceOf(Error);
          expect(resultState.admission).not.toEqual({ status: "accepted", mode: "followup" });
          const queue = getExistingFollowupQueue(key);
          expect([...new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])])]).toEqual(
            overflow ? [sibling] : [],
          );
          expect(queue?.summarySources ?? []).toEqual([]);
          expect(queue?.summaryElisions ?? []).toEqual([]);
        } else {
          await expect(outcome).resolves.toBe("handled");
          expect(resultState.admission).toEqual({ status: "accepted", mode: "followup" });
          const queue = getExistingFollowupQueue(key);
          expect([...new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])])]).toEqual([
            run,
          ]);
        }
        await withinTest(backendSettled.promise, signal);
        expect(negativeAcceptance).toHaveBeenCalledOnce();
        expect(modelEffect).not.toHaveBeenCalled();
        expect(replyRunRegistry.get(key)).toBe(operation);
        expect(operation.abortSignal.aborted).toBe(false);
        const ownerCleared = createDeferred();
        runAfterReplyOperationClear(operation, () => ownerCleared.resolve());
        operation.complete();
        await withinTest(ownerCleared.promise, signal);
        if (sourceState === "current" || overflow) {
          await withinTest(drainSettled.promise, signal);
        }
        expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
        expect(getExistingFollowupQueue(key)?.inFlight.size ?? 0).toBe(0);
        expect(getExistingFollowupQueue(key)?.draining ?? false).toBe(false);
        expect(getExistingFollowupQueue(key)?.summarySources ?? []).toEqual([]);
        expect(getExistingFollowupQueue(key)?.summaryElisions ?? []).toEqual([]);
        if (sourceState === "current" || overflow) {
          expect(modelEffect).toHaveBeenCalledExactlyOnceWith(overflow ? sibling : run);
        } else {
          expect(followup).not.toHaveBeenCalled();
          expect(modelEffect).not.toHaveBeenCalled();
        }
      } finally {
        resume.resolve();
        await settlement;
        source.complete();
        operation.complete();
        if (drainObserved) {
          await withinTest(drainSettled.promise, signal);
        }
        clearFollowupQueue(key);
        clearFollowupDrainCallback(key);
      }
    });
  },
);
