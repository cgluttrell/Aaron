import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const claudeBackend: CliBackendPlugin & { pluginId: string } = {
  id: "claude-cli",
  pluginId: "anthropic",
  bundleMcp: true,
  bundleMcpMode: "claude-config-file",
  nativeToolMode: "selectable",
  toolAvailabilityEnforcement: "execution-args",
  resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
  config: {
    command: "claude",
    args: ["--print"],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
  },
};

describe("CLI bootstrap file access", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      makeBootstrapWarn: () => () => undefined,
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each<{ writeAllowed: boolean; managedNativeTools: string[] }>([
    { writeAllowed: false, managedNativeTools: [] },
    { writeAllowed: true, managedNativeTools: [] },
    // Orchestration tools grant no file access, so the mediated surface still decides.
    { writeAllowed: false, managedNativeTools: ["Agent", "Workflow"] },
  ])("keeps bootstrap file access accurate: %j", async ({ writeAllowed, managedNativeTools }) => {
    const nativeBackend = buildAnthropicCliBackend();
    const { dir } = fixture.session;
    const bootstrapPath = path.join(dir, "BOOTSTRAP.md");
    const content = "Complete the first-run ritual, then delete this file.";
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => true,
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "BOOTSTRAP.md", path: bootstrapPath, content, missing: false }],
        contextFiles: [{ path: bootstrapPath, content }],
      }),
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...claudeBackend,
          config: { ...claudeBackend.config, systemPromptArg: "--system-prompt" },
          projectNativeToolAuthority: nativeBackend.projectNativeToolAuthority,
          resolveManagedNativeTools: nativeBackend.resolveManagedNativeTools,
        },
      ],
    });
    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionKey: "agent:main:main",
      trigger: "user",
      config: {
        agents: { defaults: { workspace: dir } },
        tools: { allow: writeAllowed ? ["read", "write"] : ["read"] },
        plugins: {
          entries: {
            anthropic: { config: { managedNativeTools: { default: managedNativeTools } } },
          },
        },
      },
    });
    try {
      expect(context.params.cliToolAvailability?.native).toEqual(managedNativeTools);
      expect(context.systemPrompt).toContain(
        writeAllowed
          ? "BOOTSTRAP.md below; follow before normal reply."
          : "this run cannot safely finish full BOOTSTRAP.md",
      );
      expect(context.systemPrompt.includes(content)).toBe(writeAllowed);
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });
});
