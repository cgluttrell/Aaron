/** Native task ownership: which input a background task holds, settles, or retires. */
import type { CliBackendToolPermissionResult } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  collect,
  installClaudeCliRuntimeHarness,
  resultDetail,
} from "./cli-runtime.harness.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const { createContext, createLiveSession } = installClaudeCliRuntimeHarness();

describe("Claude native task ownership", () => {
  it.each([
    "background-success",
    "background-agent-subagent-bash-completed",
    "background-agent-subagent-bash-stopped",
    "background-parent-stopped-child-completed",
    "background-parent-stopped-child-stopped",
    "background-agent-foreground-bash",
    "background-agent-foreground-bash-run-ids",
  ])("preserves parent result ownership and warm reuse for %s", async (scenario) => {
    const liveSession = createLiveSession();
    const release = createDeferred<CliBackendToolPermissionResult>();
    const decision = { behavior: "deny" as const, message: "Fixture released." };
    const context = await createContext(scenario, {
      liveSession,
      requestToolPermission: () => release.promise,
    });
    const results: Record<string, unknown>[] = [];
    try {
      for await (const record of executeClaudeCli(context)) {
        if (record.type !== "result") {
          continue;
        }
        results.push(record);
        if (results.length === 1) {
          expect(record).toHaveProperty("openclaw_interim_result", true);
          expect(liveSession.current()?.isIdle()).toBe(false);
          release.resolve(decision);
        }
      }
    } finally {
      release.resolve(decision);
    }
    expect(results).toHaveLength(
      scenario.startsWith("background-parent-stopped")
        ? 4
        : scenario === "background-success" || scenario.startsWith("background-agent-foreground")
          ? 2
          : 3,
    );
    for (const result of results.slice(0, -1)) {
      expect(result).toHaveProperty("openclaw_interim_result", true);
    }
    expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
    const detail = resultDetail(results);
    expect(detail.finalBackgroundAnswer).toBe(true);
    const handle = liveSession.current();
    expect(handle?.isIdle()).toBe(true);
    const next = resultDetail(await collect({ ...context, prompt: "next input", useResume: true }));
    expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
    expect(liveSession.current()).toBe(handle);
  });

  it.each(["local_agent", "local_workflow"])(
    "settles the parent without a nested %s parent-lane receipt",
    async (childType) => {
      const liveSession = createLiveSession();
      const context = await createContext(`nested-child-${childType}`, { liveSession });
      const results: Record<string, unknown>[] = [];
      for await (const record of executeClaudeCli(context)) {
        if (record.type !== "result") {
          continue;
        }
        results.push(record);
        if (results.length === 1) {
          expect(record).toHaveProperty("openclaw_interim_result", true);
        } else {
          // Assert on delivery, not a timeout: the broken owner emits this final
          // answer as interim and then leaves its iterator open indefinitely.
          expect(record).not.toHaveProperty("openclaw_interim_result");
        }
      }
      expect(results).toHaveLength(2);
      const final = resultDetail(results);
      expect(final.answer).toBe("parent final");
      const handle = liveSession.current();
      expect(handle?.isIdle()).toBe(true);
      const next = resultDetail(await collect({ ...context, useResume: true }));
      expect(next).toMatchObject({ answer: "warm input", pid: final.pid });
      expect(liveSession.current()).toBe(handle);
    },
  );

  it.each(["late-child", "late-child-run-ids"])(
    "retires the process when a prior turn's Agent child outlives it for %s",
    async (scenario) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const first = resultDetail(await collect({ ...context, prompt: "first input" }));
      expect(first.childLaunched).toBe(true);
      // The child would resume its Agent during a later input and act with that input's
      // tool and MCP authority, so the process cannot stay warm.
      expect(liveSession.current()).toBeUndefined();
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ childLaunched: true, turn: 1 });
      expect(next.pid).not.toBe(first.pid);
    },
  );

  it.each(["nested-descendant", "nested-descendant-reparented"])(
    "never lends a later warm turn to a descendant that outlived its foreground parent (%s)",
    async (scenario) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const first = resultDetail(await collect(context));
      expect(first.parentFinal).toBe(true);
      // The child could resume its Agent under the next input's tool and MCP authority.
      expect(liveSession.current()).toBeUndefined();
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ parentFinal: true, turn: 1 });
      expect(next.pid).not.toBe(first.pid);
    },
  );

  it.for(["background-bash-captured-stopped", "background-bash-captured-stopped-overlap"])(
    "settles captured 2.1.286 shape for %s with same-process reuse",
    async (scenario, { signal }) => {
      const barrierReached = createDeferred<void>();
      const release = createDeferred<CliBackendToolPermissionResult>();
      const decision = { behavior: "deny" as const, message: "Fixture released." };
      const context = await createContext(scenario, {
        liveSession: createLiveSession(),
        requestToolPermission: async ({ toolCallId, toolInput }) => {
          if (toolCallId !== "captured-release") {
            return { behavior: "allow", updatedInput: toolInput };
          }
          barrierReached.resolve();
          return release.promise;
        },
      });
      let settled = false;
      const running = collect(context).then((records) => {
        settled = true;
        return records;
      });
      void running.catch(() => {});
      try {
        await withinTest(Promise.race([barrierReached.promise, running]), signal);
        expect(settled).toBe(false);
      } finally {
        release.resolve(decision);
      }
      const records = await withinTest(running, signal);
      const results = records.filter((record) => record.type === "result");
      expect(results).toHaveLength(scenario.endsWith("-overlap") ? 2 : 1);
      if (scenario.endsWith("-overlap")) {
        expect(results[0]).toHaveProperty("openclaw_interim_result", true);
      }
      expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
      expect(
        records
          .filter((record) => record.subtype === "task_started")
          .every((record) => record.is_backgrounded === true),
      ).toBe(true);
      expect(records.some((record) => record.type === "user" && record.isReplay === true)).toBe(
        false,
      );
      expect(resultDetail(records).capturedShapeAnswered).toBe(true);
      const detail = resultDetail(records);
      expect(context.liveSession?.current()?.isIdle()).toBe(true);
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
    },
  );

  it.for([
    "background-bash-stopped-final",
    "background-bash-stopped-final-run-ids",
    "background-bash-stopped-final-slow",
    "background-bash-stopped-final-slow-run-ids",
  ])(
    "accepts the final answer after a TaskStopped auto-backgrounded Bash for %s",
    async (scenario, { signal }) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, {
        liveSession,
        requestToolPermission: async ({ toolInput }) => ({
          behavior: "allow",
          updatedInput: toolInput,
        }),
      });
      // Native sends nothing after this result; holding it would wait for the no-output watchdog.
      const records = await withinTest(collect(context), signal);
      const results = records.filter((record) => record.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).not.toHaveProperty("openclaw_interim_result");
      expect(records.at(-2)).toMatchObject({
        type: "assistant",
        message: { stop_reason: "end_turn" },
      });
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ stoppedBashFinal: true, turn: 1 });
      const handle = liveSession.current();
      expect(handle?.isIdle()).toBe(true);
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
      expect(liveSession.current()).toBe(handle);
    },
  );
});
