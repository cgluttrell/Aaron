import http from "node:http";
import { json } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logger from "../logger.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function startMcpLifecycleServer(options: {
  toolName: string;
  onDelete?: (endpoint: string) => Promise<void>;
  onList?: (endpoint: string) => Promise<void>;
  text: (endpoint: string) => string;
}) {
  let initialized = 0;
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const endpoint = request.url ?? "/";
    if (request.method === "DELETE") {
      await options.onDelete?.(endpoint);
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const message = (await json(request)) as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string };
    };
    let result;
    if (message.method === "initialize") {
      response.setHeader("mcp-session-id", String(++initialized));
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "lifecycle-proof", version: "1" },
      };
    } else if (message.method === "tools/list") {
      await options.onList?.(endpoint);
      result = { tools: [{ name: options.toolName, inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: options.text(endpoint) }] };
    }
    if (!result) {
      response.writeHead(202).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  const server = http.createServer((request, response) => {
    void handle(request, response).catch(() => response.writeHead(500).end());
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(portClaim.port, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    await portClaim.release();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${portClaim.port}`,
    close: async () => {
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await portClaim.release();
      }
    },
  };
}

it("reacquires MCP tools after a failed server's DELETE times out beside a healthy server", async () => {
  const deleteStarted = createDeferred();
  const finishDelete = createDeferred();
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => (ms === 5_000 ? deadline.signal : originalTimeout(ms)));
  const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  let failDiscovery = true;
  const server = await startMcpLifecycleServer({
    toolName: "probe",
    onList: async (endpoint) => {
      if (endpoint === "/failed" && failDiscovery) {
        throw new Error("fixture discovery failure");
      }
    },
    onDelete: async (endpoint) => {
      if (endpoint === "/failed" && failDiscovery) {
        deleteStarted.resolve();
        await finishDelete.promise;
      }
    },
    text: (endpoint) => endpoint,
  });
  const scheduler = createTestGatewayScheduler();
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const params = {
    sessionId: "http-cleanup-replacement",
    workspaceDir: tempDirs.make("openclaw-mcp-delete-"),
    manifestRegistry: { plugins: [] },
    cfg: {
      plugins: { enabled: false },
      mcp: {
        servers: {
          healthy: { transport: "streamable-http" as const, url: `${server.url}/healthy` },
          failed: { transport: "streamable-http" as const, url: `${server.url}/failed` },
        },
      },
    },
  };
  try {
    const first = await manager.acquire(params);
    try {
      const catalog = first.runtime.getCatalog();
      await deleteStarted.promise;
      // Inject the HTTP deadline after the server receives DELETE, without a wall-clock wait.
      deadline.abort(new DOMException("fixture DELETE timeout", "TimeoutError"));
      expect((await catalog).tools.map((tool) => tool.serverName)).toEqual(["healthy"]);
    } finally {
      first.releaseLease();
    }
    await first.retireUnusedServers?.(new Set(["healthy"]));
    failDiscovery = false;
    finishDelete.resolve();
    timeout.mockRestore();

    const next = await manager.acquire(params);
    try {
      expect(
        (await next.runtime.getCatalog()).tools.map((tool) => tool.serverName).toSorted(),
      ).toEqual(["failed", "healthy"]);
      await expect(next.runtime.callTool("healthy", "probe", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "/healthy" }],
      });
      expect(warn).toHaveBeenCalledWith(
        "bundle-mcp: remote session termination was not confirmed; continuing local cleanup",
      );
    } finally {
      next.releaseLease();
    }
  } finally {
    finishDelete.resolve();
    timeout.mockRestore();
    await manager.disposeAll();
    await scheduler.stop();
    await server.close();
    warn.mockRestore();
  }
});
