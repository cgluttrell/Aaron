/**
 * Test: before_agent_reply claiming-hook default timeout.
 *
 * Without a default budget this hook runs fully unbounded (the claiming-hook
 * runner shares DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK via
 * getClaimingHookTimeoutMs). In production, a memory-core dreaming pass
 * triggered from this hook awaited an internal narrative-generation lock with
 * no bound of its own; with the hook itself unbudgeted, a wedged lock froze
 * the entire interactive turn indefinitely. These tests assert a
 * never-settling handler is bounded by the default rather than hanging, and
 * that a fast handler still resolves normally.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

// The defensive default applied to before_agent_reply in
// DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK. Kept in sync with hooks.ts.
const DEFAULT_BEFORE_AGENT_REPLY_TIMEOUT_MS = 75_000;

const EVENT = { cleanedBody: "hello world" };

describe("before_agent_reply hook default timeout", () => {
  it("bounds a never-settling handler with the default timeout instead of hanging the turn", async () => {
    const registry: PluginRegistry = createEmptyPluginRegistry();
    vi.useFakeTimers();
    try {
      const handler = vi.fn(() => new Promise<never>(() => {}));
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_agent_reply",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      // No modifyingHookTimeoutMsByHook override — relies on the built-in default.
      const runner = createHookRunner(registry, { logger });
      const run = runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(DEFAULT_BEFORE_AGENT_REPLY_TIMEOUT_MS);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] before_agent_reply handler from plugin-a failed: timed out after ${DEFAULT_BEFORE_AGENT_REPLY_TIMEOUT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a fast handler claim the reply without timing out", async () => {
    const registry: PluginRegistry = createEmptyPluginRegistry();
    vi.useFakeTimers();
    try {
      const handler = vi.fn(
        async () =>
          await new Promise<{ handled: true; reply: { text: string } }>((resolve) => {
            setTimeout(() => resolve({ handled: true, reply: { text: "intercepted" } }), 20);
          }),
      );
      addTestHook({
        registry,
        pluginId: "plugin-a",
        hookName: "before_agent_reply",
        handler: handler as PluginHookRegistration["handler"],
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const runner = createHookRunner(registry, { logger });
      const run = runner.runBeforeAgentReply(EVENT, TEST_PLUGIN_AGENT_CTX);

      await vi.advanceTimersByTimeAsync(20);

      await expect(run).resolves.toEqual({ handled: true, reply: { text: "intercepted" } });
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
