import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { parseClaudeCodeVersion, supportsClaudeDynamicSystemPromptSections } from "./cli-shared.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

const log = createSubsystemLogger("anthropic-cli-version");

const FAILED_PROBE_RETRY_MS = 60_000;
const LATE_RESULT_GRACE_MS = 200;

/** Share one discovery result between native CLI capabilities and OAuth identity. */
export function createClaudeCodeVersionProbe(api: OpenClawPluginApi) {
  let installedVersion: string | undefined;
  let inFlight: Promise<string | undefined> | undefined;
  let failedAt: number | undefined;
  const probe = async (): Promise<string | undefined> => {
    try {
      // Login-shell PATH discovery can block well beyond the request probe budget.
      const executable = resolveClaudeTerminalExecutable(process.env, { pathStrategy: "direct" });
      if (!executable) {
        log.warn(
          "Claude Code version probe: executable-missing; OAuth requests keep the built-in version floor",
        );
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
      const readVersion = (result: Awaited<typeof run>) =>
        (result.code === 0 || result.termination === "timeout") && !result.outputLimitExceeded
          ? parseClaudeCodeVersion(result.stdout)
          : undefined;
      // A late but complete runner result still identifies the installed CLI for later requests.
      run.then(
        (result) => {
          installedVersion ??= readVersion(result);
        },
        () => undefined,
      );
      const result = await withTimeout(run, 1_500).catch(
        async () => await withTimeout(run, LATE_RESULT_GRACE_MS),
      );
      installedVersion ??= readVersion(result);
      if (!installedVersion) {
        log.warn(
          result.code === 0 && !result.outputLimitExceeded
            ? "Claude Code version probe: unparseable-output; OAuth requests keep the built-in version floor"
            : "Claude Code version probe: command-failed; OAuth requests keep the built-in version floor",
        );
      }
      return installedVersion;
    } catch {
      log.warn(
        "Claude Code version probe: probe-error; OAuth requests keep the built-in version floor",
      );
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
    if (failedAt !== undefined && Date.now() - failedAt < FAILED_PROBE_RETRY_MS) {
      return undefined;
    }
    inFlight = probe().then((version) => {
      failedAt = version ? undefined : Date.now();
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
