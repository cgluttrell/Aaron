import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { startCatalogRecoveryMcpServer } from "./agent-bundle-mcp-catalog-recovery.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { testing } from "./agent-bundle-mcp-runtime.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-tools.js";
import { isRecordedModelFallbackStop } from "./model-fallback-stop.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

afterEach(() => {
  testing.setBundleMcpDisposeTimeoutMsForTest();
});

it(
  "retains failed HTTP retirement for a later materialized cleanup after eviction",
  { timeout: 15_000 },
  async () => {
    testing.setBundleMcpDisposeTimeoutMsForTest(50);
    const manager = createSessionMcpRuntimeManager();
    const termination = createDeferred();
    const server = await startCatalogRecoveryMcpServer("hanging-delete-server", {
      holdTermination: termination.promise,
    });

    try {
      const runtime = await manager.getOrCreate({
        sessionId: "session-streamable-http-dispose",
        sessionKey: "agent:test:session-streamable-http-dispose",
        workspaceDir: "/workspace",
        cfg: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              hangingDelete: {
                url: server.url,
                transport: "streamable-http",
              },
            },
          },
        },
      });

      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const start = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);
      expect(server.terminationCount()).toBe(1);
      await manager.disposeSession(runtime.sessionId);
      expect(manager.listRuntimeKeys()).toEqual([]);
      const cleanupScope = createAgentCleanupScope();
      await cleanupScope.run(async () => {
        const failure: unknown = await materialized.dispose().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        // Unconfirmed cleanup is a local runtime fault; model fallback must not retry it.
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
      });
      expect(cleanupScope.outcome).toBe("uncertain");
    } finally {
      termination.resolve();
      await manager.disposeAll();
      await server.close();
    }
  },
);
