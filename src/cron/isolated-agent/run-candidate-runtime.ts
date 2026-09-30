import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { supportsCronExecutionRoot } from "../execution-root-runtime.js";
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
    let executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    let runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    let cliExecution = isCliProvider(executionProvider, params.cfgWithAgentDefaults);
    if (
      params.job.declarationKey?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX) &&
      !supportsCronExecutionRoot(runtime, cliExecution)
    ) {
      sessionRuntimeOverride = "openclaw";
      executionProvider = provider;
      runtime = "openclaw";
      cliExecution = false;
    }
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution,
      runtime,
    };
  };
}
