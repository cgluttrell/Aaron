import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession" | "job"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) => {
    // The system-owned review uses the same runtime preference as interactive
    // Workshop review, regardless of the agent model's default harness.
    sessionRuntimeOverride = params.job.declarationKey?.startsWith(
      SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
    )
      ? "openclaw"
      : sessionRuntimeOverride;
    const executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    const runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution: isCliProvider(executionProvider, params.cfgWithAgentDefaults),
      runtime,
    };
  };
}
