// Rooted cron reviews preserve their host-selected root and instructions across runtimes.
import { describe, expect, it, vi } from "vitest";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../../skills/workshop/maintenance-prompt.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "../skill-collection-review-monitor.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  acquirePreparedModelRuntimeMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronPayloadOutcomeMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const executionRoot = "/tmp/workshop-skills";

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();
  it("runs a system review on OpenClaw with its selected Codex-configured model and no fallback", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: "main",
            model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5"] },
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
              "openai/gpt-5": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    };
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        executionRoot,
        job: { ...spec!.input, id: "review-main", state: {} },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        fallbacksOverride: [],
      }),
    );
    expect(acquirePreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          expect.objectContaining({
            provider: "openai",
            modelId: "gpt-5.4",
            runtime: "openclaw",
          }),
        ],
      }),
      expect.anything(),
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessId: "openclaw",
        agentHarnessRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
      }),
    );
    expect(runCliAgentMock).not.toHaveBeenCalled();

    // Resolve the actual fallback candidate chain from the runner's options.
    // The configured Codex fallback must not become a second candidate.
    const fallbackRequest = runWithModelFallbackMock.mock.calls[0]?.[0] as {
      provider: string;
      model: string;
      fallbacksOverride?: string[];
    };
    expect(
      resolveModelCandidateChain({
        cfg,
        agentId: "main",
        provider: fallbackRequest.provider,
        model: fallbackRequest.model,
        requestedRouteResolution: "resolved",
        fallbacksOverride: fallbackRequest.fallbacksOverride,
      }).map(({ provider, model }) => `${provider}/${model}`),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("runs a declared system review with a Claude CLI primary and returns its report", async () => {
    const helpers = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      helpers.pickLastNonEmptyTextFromPayloads,
    );
    resolveCronPayloadOutcomeMock.mockImplementation(helpers.resolveCronPayloadOutcome);
    const skillsSnapshot = { prompt: "", skills: [] };
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runCliAgentMock.mockImplementation(async (params) => {
      params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Workshop review complete: retained useful procedures." }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "cal",
        executionRoot,
        skillsSnapshot,
        job: {
          declarationKey: "skill-collection-review:cal",
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
        cfg: {
          agents: {
            list: [{ id: "cal" }],
            defaults: {
              model: "anthropic/claude-opus-4-6",
              models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      outputText: "Workshop review complete: retained useful procedures.",
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        rootedExecution: { root: executionRoot },
        workspaceDir: executionRoot,
        skillsSnapshot,
        trigger: "cron",
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      }),
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
