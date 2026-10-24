/**
 * Fork T3705 (T3699 option D): bounded re-check for isolated cron dispatches deferred by the
 * gateway memory pressure guard.
 *
 * The guard's defer is correct; losing the run until the next day is not. When a scheduled
 * isolated agent dispatch is deferred, the outcome schedules a re-check every
 * PRESSURE_RETRY_INTERVAL_MS until the guard admits, the window closes
 * (PRESSURE_RETRY_WINDOW_MS after the first defer), or the job's next natural slot arrives,
 * whichever is first. Attempts are also capped by count, so a saturated night ends in exactly
 * one logged give-up and the natural schedule resumes. The guard thresholds are untouched:
 * every re-check goes back through the same guard.
 *
 * Bookkeeping is process-local (keyed by the cron service deps object). A gateway restart
 * drops it; the next deferral then opens a fresh window that is still bounded by the cap and
 * the next natural slot.
 */

export const CRON_PRESSURE_DEFER_ERROR =
  "gateway memory pressure guard deferred isolated cron agent dispatch";
const PRESSURE_RETRY_INTERVAL_MS = 10 * 60_000;
const PRESSURE_RETRY_WINDOW_MS = 3 * 60 * 60_000;
const PRESSURE_RETRY_MAX_ATTEMPTS = Math.floor(
  PRESSURE_RETRY_WINDOW_MS / PRESSURE_RETRY_INTERVAL_MS,
);

type PressureRetryWindow = {
  firstDeferredAtMs: number;
  cutoffAtMs: number;
  attempts: number;
  /** One outcome can be applied more than once (stored row, then authoritative row). */
  lastEndedAtMs?: number;
  lastRetryAtMs?: number;
  exhausted?: boolean;
};

type PressureRetryLog = {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

const windowsByService = new WeakMap<object, Map<string, PressureRetryWindow>>();

function windowsFor(serviceKey: object): Map<string, PressureRetryWindow> {
  let windows = windowsByService.get(serviceKey);
  if (!windows) {
    windows = new Map();
    windowsByService.set(serviceKey, windows);
  }
  return windows;
}

/** True when a run outcome is the pressure guard's isolated-dispatch deferral. */
export function isPressureDeferredOutcome(result: { status: string; error?: string }): boolean {
  return result.status === "skipped" && result.error === CRON_PRESSURE_DEFER_ERROR;
}

/** Drops any open re-check window for a job (any non-deferred outcome closes it). */
export function clearPressureDeferralRetry(serviceKey: object, jobId: string): void {
  windowsByService.get(serviceKey)?.delete(jobId);
}

/**
 * Returns the re-check time for a deferred scheduled run, or undefined to keep the natural
 * next slot. Logs one warn per scheduled re-check and one warn when an open window gives up.
 */
export function resolvePressureDeferralRetry(params: {
  serviceKey: object;
  log: PressureRetryLog;
  jobId: string;
  endedAtMs: number;
  naturalNextRunAtMs: number | undefined;
}): number | undefined {
  const windows = windowsFor(params.serviceKey);
  const naturalCutoff = params.naturalNextRunAtMs ?? Number.POSITIVE_INFINITY;
  const existing = windows.get(params.jobId);
  if (existing?.lastEndedAtMs === params.endedAtMs) {
    return existing.lastRetryAtMs;
  }
  // An exhausted window only answers re-applies of its own outcome (handled above); the next
  // natural-slot deferral opens a fresh window.
  const open = existing && !existing.exhausted ? existing : undefined;
  const window: PressureRetryWindow = open ?? {
    firstDeferredAtMs: params.endedAtMs,
    cutoffAtMs: Math.min(params.endedAtMs + PRESSURE_RETRY_WINDOW_MS, naturalCutoff),
    attempts: 0,
  };
  // A schedule edit mid-window can only pull the cutoff earlier.
  window.cutoffAtMs = Math.min(window.cutoffAtMs, naturalCutoff);
  const retryAtMs = params.endedAtMs + PRESSURE_RETRY_INTERVAL_MS;
  if (window.attempts < PRESSURE_RETRY_MAX_ATTEMPTS && retryAtMs < window.cutoffAtMs) {
    window.attempts += 1;
    window.lastEndedAtMs = params.endedAtMs;
    window.lastRetryAtMs = retryAtMs;
    windows.set(params.jobId, window);
    params.log.warn(
      {
        jobId: params.jobId,
        attempt: window.attempts,
        maxAttempts: PRESSURE_RETRY_MAX_ATTEMPTS,
        retryAtMs,
        firstDeferredAtMs: window.firstDeferredAtMs,
        cutoffAtMs: window.cutoffAtMs,
      },
      "cron: pressure-deferred isolated dispatch will re-check the guard",
    );
    return retryAtMs;
  }
  windows.set(params.jobId, {
    ...window,
    exhausted: true,
    lastEndedAtMs: params.endedAtMs,
    lastRetryAtMs: undefined,
  });
  if (open) {
    params.log.warn(
      {
        jobId: params.jobId,
        attempts: window.attempts,
        maxAttempts: PRESSURE_RETRY_MAX_ATTEMPTS,
        firstDeferredAtMs: window.firstDeferredAtMs,
        cutoffAtMs: window.cutoffAtMs,
        nextRunAtMs: params.naturalNextRunAtMs,
      },
      "cron: pressure-deferred isolated dispatch gave up re-checking; skipped until next slot",
    );
  }
  return undefined;
}
