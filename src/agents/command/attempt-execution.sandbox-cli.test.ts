import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { AgentHarnessPreflightError } from "../harness/errors.js";
import {
  makeCliResult,
  makeRunAgentAttemptParams,
  makeSessionEntry,
  resetCliAttemptFixtureDatabases,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
// mock-isolation: Observe dispatch without launching a host CLI or embedded model run.
vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
// mock-isolation: Observe dispatch without launching an embedded model run.
vi.mock("../embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
// mock-isolation: No live CLI session process may be registered by these cases.
vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
}));

vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    provider.trim().toLowerCase() === "claude-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: OpenClawConfig;
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      // Only the model-level runtime override path is needed; keeping the mock
      // narrow avoids loading provider catalogs here.
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || provider;
    },
  };
});

const CLI_MODEL_REF = "anthropic/claude-opus-4-7";

function sandboxedCliConfig(params: { sandboxMode?: "all"; cliModel?: boolean }): OpenClawConfig {
  const models: Record<string, { agentRuntime: { id: string } }> = {};
  if (params.cliModel) {
    models[CLI_MODEL_REF] = { agentRuntime: { id: "claude-cli" } };
  }
  const sandbox = params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {};
  return { agents: { defaults: { models, ...sandbox } } };
}

/**
 * Drives the real command attempt owner: classification, the sandbox guard,
 * and dispatch selection all run unmocked; only the CLI runner (the host
 * process launch) and the embedded runner are observed.
 */
describe("sandboxed delegated CLI attempts", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-sandbox-cli-attempt-" });
  let suiteRoot: string;
  let agentDir: string;
  let tmpDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeAll(async () => {
    suiteRoot = await fixtureRoot.setup();
    agentDir = path.join(suiteRoot, "agents", "main", "agent");
    storePath = path.join(suiteRoot, "sessions.json");
    await fs.mkdir(agentDir, { recursive: true });
  });

  beforeEach(async () => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", suiteRoot);
    tmpDir = await fixtureRoot.make();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude", forkArg: "--fork-session" },
        },
      ],
    });
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearSessionStoreCacheForTest();
    resetCliAttemptFixtureDatabases(suiteRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(storePath, { force: true });
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  afterAll(async () => {
    await cleanupSessionStateForTest({ stateDir: suiteRoot });
    await fixtureRoot.cleanup();
  });

  async function attempt(params: {
    sessionKey: string;
    entry: Partial<SessionEntry>;
    cfg: OpenClawConfig;
    overrides?: Partial<Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">>;
  }) {
    const sessionEntry = makeSessionEntry(`sandbox-cli-${params.sessionKey.split(":").at(-1)}`, {
      ...params.entry,
    });
    const sessionStore = { [params.sessionKey]: sessionEntry };
    await replaceSessionEntry({ sessionKey: params.sessionKey, storePath }, sessionEntry);
    return runAgentAttempt(
      makeRunAgentAttemptParams({
        workspaceDir: tmpDir,
        agentDir,
        storePath,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        cfg: params.cfg,
        sessionEntry,
        sessionKey: params.sessionKey,
        sessionStore,
        body: "delegated work",
        ...params.overrides,
      }),
    );
  }

  function expectNoDispatch() {
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  }

  it.each([
    {
      name: "hidden subagent child",
      sessionKey: "agent:main:subagent:sandbox-cli-hidden",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "subagent-keyed child without a spawnedBy stamp",
      sessionKey: "agent:main:subagent:sandbox-cli-keyonly",
      entry: {},
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "visible spawned child",
      sessionKey: "agent:main:dashboard:sandbox-cli-visible",
      entry: { parentSessionKey: "agent:main:main", spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "fallback candidate after an API primary",
      sessionKey: "agent:main:subagent:sandbox-cli-fallback",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: { isFallbackRetry: true, originalProvider: "openai" },
    },
    {
      name: "post-spawn runtime override",
      sessionKey: "agent:main:subagent:sandbox-cli-override",
      entry: { spawnedBy: "agent:main:main", agentRuntimeOverride: "claude-cli" },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { agentHarnessRuntimeOverride: "claude-cli" },
    },
    {
      name: "creation-stamped sandbox requirement",
      sessionKey: "agent:main:subagent:sandbox-cli-required",
      entry: { spawnedBy: "agent:main:main", sandbox: "required" as const },
      cfg: sandboxedCliConfig({ cliModel: true }),
      overrides: {},
    },
  ])("refuses host CLI launch for a sandboxed $name", async (testCase) => {
    const run = attempt(testCase);
    await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
    await expect(run).rejects.toThrow(/claude-cli runs on the host and cannot honor the sandbox/);
    expectNoDispatch();
  });

  it("keeps CLI launch for an operator dashboard session parented to main", async () => {
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("operator cli"));
    await attempt({
      sessionKey: "agent:main:dashboard:sandbox-cli-operator",
      entry: { parentSessionKey: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
    });
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps CLI launch for an unsandboxed spawned child", async () => {
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("unsandboxed cli"));
    await attempt({
      sessionKey: "agent:main:subagent:sandbox-cli-unsandboxed",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ cliModel: true }),
    });
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  });

  it("keeps embedded execution for a sandboxed spawned child on an API model", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({ meta: { durationMs: 1 } });
    await attempt({
      sessionKey: "agent:main:subagent:sandbox-cli-embedded",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { providerOverride: "openai", modelOverride: "gpt-5.4" },
    });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
