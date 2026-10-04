import { errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { evaluateAgentRunDispatchPressure } from "./agent-run-admission-pressure-policy.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";
/** Applies the dispatch-pressure gate to a prepared gateway agent run. */
export function evaluatePreparedAgentRunDispatchPressure(
  params: PrepareAgentRunDispatchParams,
): ReturnType<typeof errorShape> | undefined {
  return evaluateAgentRunDispatchPressure({
    suppressVisibleSessionEffects: params.suppressVisibleSessionEffects,
    agentRunTracking: params.client?.internal?.agentRunTracking,
    acpTurnSource: params.request.acpTurnSource,
    cwd: params.request.cwd,
    runId: params.runId,
    override: params.request.dispatchPressureOverride,
    log: params.context.logGateway,
  });
}
