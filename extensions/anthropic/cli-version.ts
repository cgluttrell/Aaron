import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

// A failed probe falls back to the transport floor; retry later rather than pin that floor for
// the process lifetime (T2831: one timed-out probe kept Opus 5.5 rejected until restart).
const FAILED_PROBE_RETRY_MS = 60_000;
const LATE_RESULT_GRACE_MS = 200;

/** Share one lazy discovery result between native CLI capabilities and OAuth identity. */
export function createClaudeCodeVersionProbe(
  api: OpenClawPluginApi,
  options: { nowMs?: () => number } = {},
) {
  const nowMs = options.nowMs ?? Date.now;
  let installedVersion: string | undefined;
  let inFlight: Promise<string | undefined> | undefined;
  let failedAt: number | undefined;
  const probe = async (): Promise<string | undefined> => {
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      const executable = resolveClaudeTerminalExecutable(process.env, { pathStrategy: "direct" });
      if (!executable) {
        return undefined;
      }
      // The runner retains process cleanup; requests need not wait for a slow tree kill.
      const run = api.runtime.system.runCommandWithTimeout([executable.executable, "--version"], {
        timeoutMs: 1_500,
        killProcessTree: true,
        killGraceMs: 100,
        maxOutputBytes: { stdout: 1_024, stderr: 1_024 },
        terminateOnOutputLimit: true,
      });
      // A stalled event loop can also make the runner classify an exited CLI as timed out;
      // its complete stdout is still installed-version evidence. Other failures stay rejected.
      const readVersion = (result: Awaited<typeof run>) =>
        (result.code === 0 || result.termination === "timeout") && !result.outputLimitExceeded
          ? parseClaudeCodeVersion(result.stdout)
          : undefined;
      // A main-thread stall can outlast the request budget even when the CLI answered in
      // milliseconds; keep that late answer for later requests instead of discarding it.
      run.then(
        (result) => {
          installedVersion ??= readVersion(result);
        },
        () => undefined,
      );
      // After a stall the CLI has usually exited already; a short grace lets this request use it.
      installedVersion ??= readVersion(
        await withTimeout(run, 1_500).catch(
          async () => await withTimeout(run, LATE_RESULT_GRACE_MS),
        ),
      );
      return installedVersion;
    } catch {
      return undefined;
    }
  };
  const resolveVersion = async (): Promise<string | undefined> => {
    if (installedVersion) {
      return installedVersion;
    }
    if (inFlight) {
      return await inFlight;
    }
    if (failedAt !== undefined && nowMs() - failedAt < FAILED_PROBE_RETRY_MS) {
      return undefined;
    }
    inFlight = probe().then((version) => {
      failedAt = version ? undefined : nowMs();
      inFlight = undefined;
      return version;
    });
    return await inFlight;
  };
  return {
    resolveVersion,
    ensureDynamicSystemPromptSectionsSupport: async () => {
      await resolveVersion();
    },
    supportsDynamicSystemPromptSections: () =>
      supportsClaudeDynamicSystemPromptSections(installedVersion),
  };
}
