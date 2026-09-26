import { describe, expect, it, vi } from "vitest";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const event = { cleanedBody: "hello world" };
describe("before_agent_reply", () => {
  it.each([false, true])("rejects revoked handler authority after handled=%s", async (handled) => {
    let current = true;
    const first = vi.fn(async () => {
      current = false;
      return { handled, reply: { text: "stale result" } };
    });
    const nextEffect = vi.fn();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: first },
        { hookName: "before_agent_reply", handler: nextEffect },
      ]),
    );
    const context = withClaimingHookAdmission(
      { ...TEST_PLUGIN_AGENT_CTX },
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error("root reassigned");
          }
        },
      },
    );

    await expect(runner.runBeforeAgentReply(event, context)).rejects.toThrow("root reassigned");
    expect(first).toHaveBeenCalledOnce();
    expect(nextEffect).not.toHaveBeenCalled();
  });

  it("continues past failures and decliners, then stops at the first claim", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const decliner = vi.fn();
    const claimer = vi.fn(() => ({ handled: true, reply: { text: "first" }, reason: "claim" }));
    const skipped = vi.fn(() => ({ handled: true, reply: { text: "second" } }));
    const runner = createHookRunner(
      createMockPluginRegistry(
        [failing, decliner, claimer, skipped].map((handler) => ({
          hookName: "before_agent_reply",
          handler,
        })),
      ),
      { logger },
    );
    await expect(runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      handled: true,
      reply: { text: "first" },
      reason: "claim",
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed: boom"));
    expect(decliner).toHaveBeenCalledOnce();
    expect(claimer).toHaveBeenCalledExactlyOnceWith(event, TEST_PLUGIN_AGENT_CTX);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("requires an eligible trigger before invoking a scoped hook", async () => {
    const handler = vi.fn(() => ({ handled: true }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler, eligibleTriggers: ["heartbeat", "cron"] },
      ]),
    );
    expect(runner.hasHooks("before_agent_reply")).toBe(true);
    expect(runner.hasHooks("before_agent_reply", { trigger: "user" })).toBe(false);
    expect(runner.hasHooks("before_agent_reply", { trigger: "cron" })).toBe(true);
    await expect(runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX)).resolves.toBeUndefined();
    await expect(runner.runBeforeAgentReply(event, { trigger: "user" })).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    await expect(runner.runBeforeAgentReply(event, { trigger: "cron" })).resolves.toEqual({
      handled: true,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not inherit modifying-hook timeouts", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        return { handled: true };
      });
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_agent_reply", handler }]),
        { modifyingHookTimeoutMsByHook: { before_agent_reply: 10 } },
      );
      const run = runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(100);
      await expect(run).resolves.toEqual({ handled: true });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches errors with catchErrors: true and continues to next handler", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const claimer = vi.fn().mockResolvedValue({ handled: true, reply: { text: "ok" } });
    const registry = createMockPluginRegistry([
      { hookName: "before_agent_reply", handler: failing },
      { hookName: "before_agent_reply", handler: claimer },
    ]);
    const runner = createHookRunner(registry, { logger });

    const result = await runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({ handled: true, reply: { text: "ok" } });
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] before_agent_reply handler from test-plugin failed: boom",
    );
  });

  it("enforces trigger eligibility before invoking handlers", async () => {
    const scheduled = vi.fn().mockResolvedValue({ handled: true, reply: { text: "scheduled" } });
    const unrestricted = vi
      .fn()
      .mockResolvedValue({ handled: true, reply: { text: "unrestricted" } });
    const registry = createMockPluginRegistry([
      {
        hookName: "before_agent_reply",
        handler: scheduled,
        eligibleTriggers: ["heartbeat", "cron"],
      },
      { hookName: "before_agent_reply", handler: unrestricted },
    ]);
    const runner = createHookRunner(registry);

    await expect(
      runner.runBeforeAgentReply(EVENT, { ...TEST_PLUGIN_AGENT_CTX, trigger: "user" }),
    ).resolves.toEqual({ handled: true, reply: { text: "unrestricted" } });
    expect(scheduled).not.toHaveBeenCalled();
    expect(unrestricted).toHaveBeenCalledOnce();

    expect(runner.hasHooks("before_agent_reply", { trigger: "user" })).toBe(true);
    expect(runner.hasHooks("before_agent_reply", { trigger: "heartbeat" })).toBe(true);
  });

  it("keeps context-free checks fail-closed for trigger-scoped hooks", () => {
    const registry = createMockPluginRegistry([
      {
        hookName: "before_agent_reply",
        handler: vi.fn(),
        eligibleTriggers: ["heartbeat", "cron"],
      },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("before_agent_reply")).toBe(true);
    expect(runner.hasHooks("before_agent_reply", { trigger: "user" })).toBe(false);
    expect(runner.hasHooks("before_agent_reply", { trigger: "cron" })).toBe(true);
  });

  it("bounds a hung handler with the 75s default and fails open (fork T1565)", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(() => new Promise<never>(() => {}));
      const registry = createMockPluginRegistry([{ hookName: "before_agent_reply", handler: hung }]);
      const runner = createHookRunner(registry);

      const pending = runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(74_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();
      expect(hung).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
