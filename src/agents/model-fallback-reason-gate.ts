import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { describeFailoverError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";

type FallbackCandidateRef = { provider: string; model: string };

/**
 * Whether a failure reason may advance the fallback chain. An absent allowlist
 * permits every reason (default behavior); a present one restricts advancing to
 * the listed reasons (T3726: system review cron turns allow only rate_limit).
 */
export function allowsFallbackReason(
  allowlist: readonly FailoverReason[] | undefined,
  reason: FailoverReason | undefined,
): boolean {
  return !allowlist || (reason !== undefined && allowlist.includes(reason));
}

/**
 * Resolves the candidate to advance to after a failed attempt, or undefined when
 * the failure reason is not allowed to advance. Logs an explicit switch line when
 * a rate-limited candidate hands the turn to the next model.
 */
export function resolveAllowedNextCandidate<C extends FallbackCandidateRef>(
  allowlist: readonly FailoverReason[] | undefined,
  error: unknown,
  failed: FallbackCandidateRef,
  next: C | undefined,
  log: { warn: (message: string) => void },
): C | undefined {
  const reason = describeFailoverError(error).reason;
  if (!next || !allowsFallbackReason(allowlist, reason)) {
    return undefined;
  }
  if (reason === "rate_limit") {
    log.warn(
      `rate-limited ${sanitizeForLog(failed.provider)}/${sanitizeForLog(failed.model)}; switching to fallback ${sanitizeForLog(next.provider)}/${sanitizeForLog(next.model)} (reason=rate_limit)`,
    );
  }
  return next;
}
