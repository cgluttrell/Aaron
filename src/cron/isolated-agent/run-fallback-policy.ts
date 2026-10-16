/** Resolves model fallback chains for isolated cron runs and preflight. */
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import type { CronJob } from "../types.js";
import {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";
import { logWarn } from "./run.runtime.js";

const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);

/** The system review pins model and runtime; fallback serves only rate limits. */
export function isSkillCollectionReviewCronJob(job: Pick<CronJob, "declarationKey">): boolean {
  return job.declarationKey?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX) === true;
}

/** Resolves cron model fallbacks, giving explicit payload fallbacks precedence over subagent/default policy. */
export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
}): string[] | undefined {
  // The system review previously pinned an empty chain here; a rate-limited
  // primary then slept out provider retry floors until the cron timeout or the
  // stuck-session watchdog killed the run and no fallback ever served it
  // (T3723/T3726). Review jobs now resolve the normal chain; the executor
  // restricts their fallback to rate_limit-class failures and keeps the
  // Workshop-root OpenClaw runtime pin for every candidate.
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride =
    typeof payload?.model === "string" && payload.model.trim().length > 0;
  if (payloadFallbacks !== undefined) {
    return payloadFallbacks;
  }
  if (params.useSubagentFallbacks === true && !hasCronPayloadModelOverride) {
    // A payload model override owns its full candidate chain; otherwise the
    // selected subagent can contribute its configured fallback policy.
    const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(
      params.cfg,
      params.agentId,
    );
    if (subagentFallbacksOverride !== undefined) {
      return subagentFallbacksOverride;
    }
  }
  if (!hasCronPayloadModelOverride && params.inheritDefaultFallbacksForAgentStringModel === true) {
    const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
    if (defaultFallbacks.length > 0) {
      return defaultFallbacks;
    }
  }
  return resolveEffectiveModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    hasSessionModelOverride: hasCronPayloadModelOverride,
    modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
  });
}

/** Builds the ordered model candidates used by cron preflight checks. */
export function resolveCronPreflightCandidates(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  provider: string;
  model: string;
  useSubagentFallbacks?: boolean;
  inheritDefaultFallbacksForAgentStringModel?: boolean;
}): ModelCandidate[] {
  const fallbacksOverride = resolveCronFallbacksOverride(params);
  return resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    fallbacksOverride,
  });
}

/** Selects the reachable candidate and retains only its remaining fallback chain. */
export async function resolveCronPreflight(
  params: Parameters<typeof resolveCronPreflightCandidates>[0],
) {
  const modelPreflightRuntime = await cronModelPreflightRuntimeLoader.load();
  const preflightCandidates = resolveCronPreflightCandidates(params);
  let firstUnavailableReason: string | undefined;
  for (const [index, candidate] of preflightCandidates.entries()) {
    const candidatePreflight = await modelPreflightRuntime.preflightCronModelProvider({
      cfg: params.cfg,
      provider: candidate.provider,
      model: candidate.model,
    });
    if (candidatePreflight.status === "unavailable") {
      firstUnavailableReason ??= candidatePreflight.reason;
      // The review job never preflight-switches its pinned primary; its chain
      // only serves live rate-limit failover during execution.
      if (isSkillCollectionReviewCronJob(params.job)) {
        break;
      }
      continue;
    }
    const modelFallbacksOverride =
      candidate.provider !== params.provider || candidate.model !== params.model
        ? preflightCandidates
            .slice(index + 1)
            .map((remaining) => `${remaining.provider}/${remaining.model}`)
        : undefined;
    if (modelFallbacksOverride && firstUnavailableReason !== undefined) {
      logWarn(
        `[cron:${params.job.id}] ${firstUnavailableReason}; continuing with fallback ${candidate.provider}/${candidate.model}.`,
      );
    }
    return {
      ok: true as const,
      provider: candidate.provider,
      model: candidate.model,
      modelFallbacksOverride,
      runtimePluginCandidates: preflightCandidates.slice(index),
    };
  }
  if (firstUnavailableReason !== undefined) {
    return { ok: false as const, reason: firstUnavailableReason };
  }
  return {
    ok: true as const,
    provider: params.provider,
    model: params.model,
    modelFallbacksOverride: undefined,
    runtimePluginCandidates: preflightCandidates,
  };
}
