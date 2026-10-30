import { expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

type Input = Parameters<typeof resolveCliRuntimeToolPolicy>[0];
type Overrides = Partial<Omit<Input, "params">> & { params?: Partial<RunCliAgentParams> };
const session = { sessionId: "coding", updatedAt: 1 };
const managedNative = ["Agent", "Workflow"];
const ordinary: Input = {
  params: {
    sessionId: "coding",
    sessionKey: "agent:coder:dashboard:coding",
    sessionFile: "fixture.jsonl",
    workspaceDir: "/workspace",
    prompt: "implement",
    provider: "claude-cli",
    model: "fixture",
    runId: "fixture-run",
    timeoutMs: 1000,
    config: {},
    sessionEntry: session,
  },
  policyAgentId: "coder",
  policySessionKey: "agent:coder:dashboard:coding",
  backendId: "claude-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};
const completion: Partial<RunCliAgentParams> = {
  trustedInternalHandoff: {
    kind: "subagent-completion",
    sourceSessionKey: "agent:coder:subagent:child",
    targetSessionKey: "agent:coder:dashboard:coding",
    targetSessionId: "coding",
    provider: "claude-cli",
    model: "fixture",
  },
};
function withManagedNative({ params, ...overrides }: Overrides = {}): Input {
  return {
    ...ordinary,
    // Resolve by the policy agent, so per-agent selections follow the turn's owner.
    resolveManagedNativeTools: ({ agentId }) => (agentId === "coder" ? managedNative : []),
    ...overrides,
    params: { ...ordinary.params, ...params },
  };
}

it.each([{}, { params: completion }])(
  "keeps the operator's managed native tools on ordinary and completion turns: %j",
  (overrides) => {
    const result = resolveCliRuntimeToolPolicy(withManagedNative(overrides));
    expect(result.params.cliToolAvailability).toEqual({ native: managedNative, openClaw: [] });
    expect(result.runtimeToolsAllowPolicy).toEqual(["*"]);
    // Prepare reads this list to know the selection confers no file capability.
    expect(result.managedNativeTools).toEqual(managedNative);
  },
);

it.each<[string, Overrides]>([
  ["workspace-only", { params: { config: { tools: { fs: { workspaceOnly: true } } } } }],
  ["a caller tool cap", { params: { ...completion, toolsAllow: ["read"] } }],
])("drops managed native tools for %s", (_name, overrides) => {
  const result = resolveCliRuntimeToolPolicy(withManagedNative(overrides));
  expect(result.params.cliToolAvailability?.native).toEqual([]);
  expect(result.managedNativeTools).toEqual([]);
});

it("leaves node-placed Claude turns on their unmediated native surface", () => {
  const result = resolveCliRuntimeToolPolicy(
    withManagedNative({ params: { sessionEntry: { ...session, execHost: "node" } } }),
  );
  expect(result.params.cliToolAvailability).toBeUndefined();
  expect(result.managedNativeTools).toEqual([]);
});
