import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.js";
import { installGatewayTestHooks, writeSessionStore } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("chat input admission across agent databases", () => {
  it("stages an authorized follow-up when the agent also has sessions in its state-dir database", async () => {
    // An absolute per-agent store outside the state dir leaves older state-dir rows
    // discoverable, so session authority reads span two agent databases.
    const fixture = await createBrowserFollowupFixture({ perAgentStore: true });
    await writeSessionStore({
      storePath: path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      ),
      agentId: "main",
      entries: { earlier: { sessionId: "state-dir-session", updatedAt: Date.now() } },
    });
    try {
      const ack = await fixture.send(vi.fn<RespondFn>(), {});
      expect(ack.mock.calls[0]?.[0]).toBe(true);
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
      });
      const recorder = await fixture.dispatchedRecorder;
      recorder.finishPendingInput?.("cancelled");
      await fixture.finishDispatch();
    } finally {
      await fixture.cleanup();
    }
  });
});
