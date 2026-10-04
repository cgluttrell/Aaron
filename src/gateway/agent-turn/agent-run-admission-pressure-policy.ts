import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  decideDispatchPressure,
  type DispatchPressureOverride,
} from "../../process/dispatch-pressure-guard.js";
import type { AgentTurnContext } from "./types.js";

/**
 * Fork T1847 dispatch-pressure gate for gateway agent runs. Applies to background runs only
 * (internal session effects, plugin subagents, ACP manual spawns, cwd runs); interactive
 * turns are never deferred. Returns the refusal to emit when the run must be deferred, or
 * undefined to proceed. An attributed override (authorized in preflight) proceeds and is
 * logged with the sample that would otherwise have deferred it.
 */
export function evaluateAgentRunDispatchPressure(params: {
  suppressVisibleSessionEffects: boolean;
  agentRunTracking?: unknown;
  acpTurnSource?: string;
  cwd?: string;
  runId: string;
  override?: DispatchPressureOverride;
  log: Pick<AgentTurnContext["logGateway"], "warn">;
  decide?: typeof decideDispatchPressure;
}): ReturnType<typeof errorShape> | undefined {
  const applies =
    params.suppressVisibleSessionEffects ||
    params.agentRunTracking === "plugin_subagent" ||
    params.acpTurnSource === "manual_spawn" ||
    Boolean(params.cwd);
  if (!applies) {
    return undefined;
  }
  const decision = (params.decide ?? decideDispatchPressure)({
    workKind: "gateway_agent",
    workId: params.runId,
    override: params.override,
  });
  if (decision.status === "defer") {
    params.log.warn("gateway dispatch pressure guard deferred agent run", {
      runId: params.runId,
      reason: decision.reason,
      currentBytes: decision.sample.currentBytes,
      fileCacheBytes: decision.sample.fileCacheBytes,
      workingSetBytes: decision.sample.workingSetBytes,
      maxBytes: decision.sample.maxBytes,
      usageRatio: decision.sample.usageRatio,
      growthBytes: decision.sample.growthBytes,
      windowMs: decision.sample.windowMs,
      threshold: decision.threshold,
    });
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "gateway memory pressure guard deferred isolated agent dispatch",
    );
  }
  if (decision.status === "override") {
    params.log.warn("gateway dispatch pressure guard override allowed agent run", {
      runId: params.runId,
      approvedBy: decision.override.approvedBy,
      reason: decision.override.reason,
      pressureReason: decision.reason,
      currentBytes: decision.sample?.currentBytes,
      fileCacheBytes: decision.sample?.fileCacheBytes,
      workingSetBytes: decision.sample?.workingSetBytes,
      maxBytes: decision.sample?.maxBytes,
      usageRatio: decision.sample?.usageRatio,
      growthBytes: decision.sample?.growthBytes,
      windowMs: decision.sample?.windowMs,
    });
  }
  return undefined;
}
