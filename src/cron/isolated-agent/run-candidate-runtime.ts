import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { supportsCronExecutionRoot } from "../execution-root-runtime.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import type { CronJob } from "../types.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { MutableCronSession } from "./run-session-state.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(params: {
  cfgWithAgentDefaults: OpenClawConfig;
  agentId: string;
  runSessionKey: string;
  cronSession: MutableCronSession;
  job: CronJob;
}) {
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
    const rootedRuntimeOverride =
      params.job.declarationKey?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX) &&
      !supportsCronExecutionRoot(runtime, cliExecution)
        ? "openclaw"
        : sessionRuntimeOverride;
    if (rootedRuntimeOverride !== sessionRuntimeOverride) {
      executionProvider = provider;
      runtime = "openclaw";
      cliExecution = false;
    }
    return {
      sessionRuntimeOverride: rootedRuntimeOverride,
      executionProvider,
      cliExecution,
      runtime,
    };
  };
}
