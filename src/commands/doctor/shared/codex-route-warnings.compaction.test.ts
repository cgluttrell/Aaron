import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn().mockReturnValue({ profiles: {}, usageStats: {} }),
  evaluateStoredCredentialEligibility: vi
    .fn()
    .mockReturnValue({ eligible: true, reasonCode: "ok" }),
  isInstalledPluginEnabled: vi.fn().mockReturnValue(false),
  loadInstalledPluginIndex: vi.fn().mockReturnValue({ plugins: [] }),
  resolveAuthProfileOrder: vi.fn().mockReturnValue([]),
  resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(null),
}));

// mock-isolation: Route repair must not read the host auth-profile store.
vi.mock("../../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));

// mock-isolation: Credential eligibility is fixed so repair decisions are deterministic.
vi.mock("../../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

import {
  collectCodexRouteWarnings as collectCodexRouteWarningsUnderTest,
  maybeRepairCodexRoutes as maybeRepairCodexRoutesUnderTest,
} from "./codex-route-warnings.js";

function collectCodexRouteWarnings(cfg: OpenClawConfigWithLegacyRoster): string[] {
  return collectCodexRouteWarningsUnderTest({ cfg });
}

function maybeRepairCodexRoutes(cfg: OpenClawConfigWithLegacyRoster) {
  return maybeRepairCodexRoutesUnderTest({ cfg, shouldRepair: true });
}

function codexCompactionWarning(...details: string[]): string {
  return [
    "- Codex runtime ignores compaction.provider; compaction.model still applies to OpenClaw host summaries.",
    ...details,
  ].join("\n");
}

describe("Codex route compaction overrides", () => {
  it("keeps shared default compaction fields that non-Codex agents override", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: {
            model: "openai/gpt-5.4",
            provider: "custom-summary",
            keepRecentTokens: 10_000,
          },
        },
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            compaction: { model: "anthropic/claude-haiku-4-6" },
          },
        ],
      },
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
      keepRecentTokens: 10_000,
    });
    expect(result.warnings).toStrictEqual([
      codexCompactionWarning(
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.provider` manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ),
    ]);
  });

  it.each([undefined, "custom-summary"])(
    "preserves the host summary model during Codex repair (provider=%s)",
    (provider) => {
      const result = maybeRepairCodexRoutes({
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "anthropic/claude-sonnet-4-6",
              keepRecentTokens: 10_000,
              ...(provider ? { provider } : {}),
            },
          },
        },
        plugins: { entries: { codex: { enabled: true } } },
      });

      expect(result.cfg.agents?.defaults?.compaction).toEqual({
        model: "anthropic/claude-sonnet-4-6",
        keepRecentTokens: 10_000,
      });
      expect(result.warnings).toEqual([]);
      expect(maybeRepairCodexRoutes(result.cfg).changes).toEqual([]);
    },
  );

  it("keeps doctor fix hint for agent-specific compaction overrides", () => {
    const warnings = collectCodexRouteWarnings({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          compaction: { model: "openai/gpt-5.4", provider: "custom-summary" },
        },
        list: [
          {
            id: "codex",
            model: "openai/gpt-5.5",
            compaction: { model: "openai/gpt-5.4", provider: "agent-summary" },
          },
          { id: "inherited", model: "openai/gpt-5.5" },
          { id: "worker", model: "anthropic/claude-sonnet-4-6" },
        ],
      },
    });

    expect(warnings).toStrictEqual([
      codexCompactionWarning(
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.provider` manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ),
      codexCompactionWarning(
        "- agents.list.codex.compaction.provider: agent-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ),
    ]);
  });
});
