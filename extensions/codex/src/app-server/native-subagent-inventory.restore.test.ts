import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { fixture, startAssignment } from "./native-subagent-inventory.test-support.js";
import {
  childTurnCompletedNotification,
  createClient,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("native pending assignment restoration", () => {
  it.each(["observed turn", "canonical locator", "resumed turn", "different turn"])(
    "reconciles a pending assignment's %s during its history read",
    async (change) => {
      const f = await fixture();
      const initial = {
        runId: "codex-thread:child-thread",
        childThreadId: "child-thread",
        ...(change === "observed turn" ? {} : { nativeTurnId: "child-turn" }),
        nativeParentThreadId: "parent-thread",
        owner: f.historyOwner(),
      };
      await f.store.mutate(
        f.identity,
        { kind: "record-native-subagent-assignment", owner: f.historyOwner(), assignment: initial },
        () => {},
      );
      const entered = createDeferred<void>();
      const history = createDeferred<ReturnType<typeof threadRead>>();
      const client = createClient();
      client.setThreadReadFactory("child-thread", () => {
        entered.resolve();
        return history.promise;
      });
      const parent = await f.register(client);
      const recovered = threadRead({
        turnId: change === "resumed turn" ? "resumed-turn" : "child-turn",
        result: "Recovered result",
        resultPhase: "final_answer",
      });
      if (change === "resumed turn") {
        const interrupted = threadRead({ turnId: "child-turn", status: "interrupted" });
        assert(recovered.thread.turns && interrupted.thread.turns);
        recovered.thread.turns.unshift(...interrupted.thread.turns);
      }
      try {
        await entered.promise;
        if (change === "different turn") {
          await f.store.mutate(
            f.identity,
            {
              kind: "consume-native-subagent-assignment",
              owner: f.historyOwner(),
              assignment: initial,
            },
            () => {},
          );
        }
        const surviving = {
          ...initial,
          runId:
            change === "canonical locator"
              ? "codex-thread:child-thread:turn:child-turn"
              : change === "different turn"
                ? "codex-thread:child-thread:turn:other-turn"
                : initial.runId,
          nativeTurnId:
            change === "resumed turn"
              ? "resumed-turn"
              : change === "different turn"
                ? "other-turn"
                : "child-turn",
        };
        await f.store.mutate(
          f.identity,
          {
            kind: "record-native-subagent-assignment",
            owner: f.historyOwner(),
            assignment: surviving,
          },
          () => {},
        );
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        if (change === "different turn") {
          expect(f.deliver).not.toHaveBeenCalled();
          expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
            surviving,
          ]);
        } else {
          expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              childSessionKey: surviving.runId,
              result: "Recovered result",
            }),
          );
          expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
        }
      } finally {
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        client.close();
      }
    },
  );

  it("does not restore an assignment retired while native history was being read", async () => {
    const { f, client, parent } = await startAssignment();
    f.deliver.mockResolvedValue({ delivered: false, path: "none", error: "Unavailable" });
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Result" }],
      }),
    );
    await parent.unregister();
    const entered = createDeferred<void>();
    const history = createDeferred<ReturnType<typeof threadRead>>();
    const replacementClient = createClient();
    replacementClient.setThreadReadFactory("child-thread", () => {
      entered.resolve();
      return history.promise;
    });
    const replacement = await f.register(replacementClient);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    const attempts = f.deliver.mock.calls.length;
    history.resolve(
      threadRead({ turnId: "child-turn", result: "Result", resultPhase: "final_answer" }),
    );
    await replacement.ready;
    await replacement.unregister();
    expect(f.deliver).toHaveBeenCalledTimes(attempts);
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    client.close();
    replacementClient.close();
  });
});
