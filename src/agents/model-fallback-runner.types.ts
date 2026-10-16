import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { FailoverReason } from "./failover/signal.js";
import type {
  ModelFallbackErrorHandler,
  ModelFallbackResultClassifier,
  ModelFallbackRunFn,
  ModelFallbackRuntimeContext,
  ModelFallbackStepHandler,
} from "./model-fallback-attempt.js";
import type {
  ModelFallbackCandidate,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";

/** Parameters for runWithModelFallback (moved from model-fallback-runner.ts). */
export type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  userLockedAuthProfileId?: string;
  prepareCandidateChain?: (candidates: readonly ModelFallbackCandidate[]) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  /**
   * Restricts advancing past a failed or cooldown-skipped candidate to these
   * failure reasons. A candidate failing for any other reason ends the chain
   * with the existing no-remaining-candidate failure surface. Absent permits
   * every reason (default behavior).
   */
  fallbackReasonAllowlist?: readonly FailoverReason[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (
    attempt: Parameters<ModelFallbackErrorHandler>[0],
  ) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
} & ModelManifestNormalizationContext;
