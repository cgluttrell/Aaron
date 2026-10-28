import { expect, it, vi } from "vitest";
import type { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { GatewayOperatorRecoveryOwnershipError } from "../../infra/restart-recovery-errors.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import { createRestartRecoveryStoreFixture } from "./main-session-restart-recovery-fixture.test-support.js";
import type { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

/** Requires the caller's gateway and transcript module mocks. */
export function registerStaleOperatorSourceCase(params: {
  getStateDir: () => string;
  makeMainSessionFixture: (overrides: SessionEntryFixture) => Promise<{
    sessionsDir: string;
    readEntry: () => ReturnType<typeof loadSessionEntry>;
  }>;
  // The caller's wrapper supplies its mocked gateway recovery runtime.
  recoverRestartAbortedMainSessions: (
    params: Omit<Parameters<typeof recoverRestartAbortedMainSessions>[0], "gatewayRuntime"> & {
      gatewayRuntime?: GatewayRecoveryRuntime;
    },
  ) => ReturnType<typeof recoverRestartAbortedMainSessions>;
}) {
  const { writeCompletedToolTranscript } = createRestartRecoveryStoreFixture(params.getStateDir);
  it("retires a stale operator recovery source once with a local notice", async () => {
    const { sessionsDir, readEntry } = await params.makeMainSessionFixture({});
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(new GatewayOperatorRecoveryOwnershipError());

    await expect(
      params.recoverRestartAbortedMainSessions({ cfg: {}, stateDir: params.getStateDir() }),
    ).resolves.toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });

    // Stable probes agent.wait after a rejected dispatch; the resend itself happens once.
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(([request]) => (request as { method?: string }).method === "agent"),
    ).toHaveLength(1);
    expect(readEntry()).toMatchObject({ abortedLastRun: false });
    expect(readEntry()?.mainRestartRecovery).toBeUndefined();
    expect(vi.mocked(appendAssistantMessageToSessionTranscript)).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Restart recovery operator source no longer owns this input"),
      }),
    );
  });
}
