import { describe, expect, it } from "vitest";
import {
  makeRunAgentAttemptParams,
  makeSessionEntry,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";

describe("CLI restart-safe recovery", () => {
  it("refuses recovery when the runtime cannot enforce safe tools", () => {
    const params = makeRunAgentAttemptParams({
      agentDir: "/tmp/openclaw-restart-safe-cli-agent",
      providerOverride: "claude-cli",
      modelOverride: "opus",
      sessionEntry: makeSessionEntry("restart-safe-cli"),
      sessionKey: "agent:main:direct:restart-safe-cli",
      workspaceDir: "/tmp/openclaw-restart-safe-cli-workspace",
      opts: { forceRestartSafeTools: true },
    });

    expect(() => runAgentAttempt(params)).toThrow(
      "CLI runtimes cannot enforce restart-safe tool restrictions",
    );
  });
});
