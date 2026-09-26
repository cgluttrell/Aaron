import { describe, expect, it, vi } from "vitest";
import type { DispatchPressureDecision } from "../../process/dispatch-pressure-guard.js";
import { evaluateAgentRunDispatchPressure } from "./agent-run-admission-phase.js";

const sample = {
  currentBytes: 7_000,
  fileCacheBytes: 1_000,
  workingSetBytes: 6_000,
  maxBytes: 6_500,
  usageRatio: 0.92,
  growthBytes: 0,
  windowMs: 1_000,
};

function run(decision: DispatchPressureDecision, overrides: Partial<Parameters<typeof evaluateAgentRunDispatchPressure>[0]> = {}) {
  const log = { warn: vi.fn() };
  const decide = vi.fn(() => decision);
  const result = evaluateAgentRunDispatchPressure({
    suppressVisibleSessionEffects: true,
    runId: "run-1",
    log,
    decide,
    ...overrides,
  });
  return { result, log, decide };
}

describe("evaluateAgentRunDispatchPressure (fork T1847)", () => {
  const defer = { status: "defer", reason: "cgroup_memory_threshold", sample, threshold: 0.85 } as unknown as DispatchPressureDecision;

  it("defers a background run under pressure with an UNAVAILABLE refusal and a log line", () => {
    const { result, log, decide } = run(defer);
    expect(decide).toHaveBeenCalledWith({ workKind: "gateway_agent", workId: "run-1", override: undefined });
    expect(result?.message).toBe("gateway memory pressure guard deferred isolated agent dispatch");
    expect(log.warn).toHaveBeenCalledWith(
      "gateway dispatch pressure guard deferred agent run",
      expect.objectContaining({ runId: "run-1", workingSetBytes: 6_000 }),
    );
  });

  it("never gates an interactive turn", () => {
    const { result, decide } = run(defer, { suppressVisibleSessionEffects: false });
    expect(decide).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("applies to plugin subagents, ACP manual spawns and cwd runs", () => {
    for (const extra of [
      { agentRunTracking: "plugin_subagent" },
      { acpTurnSource: "manual_spawn" },
      { cwd: "/tmp/work" },
    ]) {
      const { result } = run(defer, { suppressVisibleSessionEffects: false, ...extra });
      expect(result).toBeDefined();
    }
  });

  it("lets an attributed override proceed and logs it", () => {
    const override = { approvedBy: "Chris" as const, reason: "urgent" };
    const { result, log, decide } = run(
      { status: "override", reason: "cgroup_memory_threshold", override, sample } as unknown as DispatchPressureDecision,
      { override },
    );
    expect(decide).toHaveBeenCalledWith({ workKind: "gateway_agent", workId: "run-1", override });
    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "gateway dispatch pressure guard override allowed agent run",
      expect.objectContaining({ approvedBy: "Chris", reason: "urgent" }),
    );
  });

  it("proceeds silently when there is no pressure", () => {
    const { result, log } = run({ status: "allow", reason: "below_threshold" } as unknown as DispatchPressureDecision);
    expect(result).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
