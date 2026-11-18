import { APIError } from "openai/core/error";
import { describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

describe("recoverEmbeddedRunAttempt rate-limit pacing", () => {
  it.each([
    { errorMessage: "429 rate_limit_exceeded; Retry-After: 3600", delayMs: 3_600_000 },
    {
      errorMessage: "429 requests per minute exceeded. Please try again in 11.054s.",
      delayMs: 11_054,
    },
    { headers: { "retry-after": "7", "retry-after-ms": "8500" }, delayMs: 8500 },
    { headers: { "retry-after": "7", "retry-after-ms": "invalid" }, delayMs: 7000 },
  ])("continues after respecting the provider floor of $delayMs ms", async (scenario) => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, onAgentEvent, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({
        errorMessage: scenario.errorMessage ?? "429 provider rate limit",
        errorBody: scenario.headers ? JSON.stringify({ headers: scenario.headers }) : undefined,
        diagnostics: [],
      });
    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(scenario.delayMs, undefined);
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({
          phase: "retrying",
          attempt: 2,
          maxAttempts: 10,
          reason: "rate_limit",
        }),
      }),
    );
  });

  it.each([
    {
      status: 429,
      headers: new Headers({ "retry-after": "7", "retry-after-ms": "8500" }),
      delayMs: 8500,
    },
    { status: 503, headers: { "Retry-After": "7", "retry-after-ms": "335" }, delayMs: 7000 },
    { status: 429, response: { headers: { "retry-after-ms": "8500" } }, delayMs: 8500 },
    { status: 429, message: "Please try again in 11.054s.", delayMs: 11_054 },
    { status: 429, headers: { "retry-after": "7" }, message: "Retry-After: 12", delayMs: 12_000 },
  ])(
    "honors prompt-exception pacing for HTTP $status with floor $delayMs",
    async ({ status, headers, response, message, delayMs }) => {
      vi.mocked(sleepWithAbort).mockClear();
      const error =
        headers instanceof Headers
          ? new APIError(
              status,
              { message: "provider temporarily unavailable" },
              undefined,
              headers,
            )
          : Object.assign(new Error(message ?? "provider temporarily unavailable"), {
              status,
              headers,
              response,
            });
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        terminal: { kind: "failed", source: "prompt", error },
        errorBody: JSON.stringify({ headers: { "retry-after": "99" } }),
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );

  it.each([65 * 60_000])("honors a Retry-After HTTP date %i ms ahead", async (delayMs) => {
    const nowMs = Date.parse("2026-06-11T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      vi.mocked(sleepWithAbort).mockClear();
      const { recovery } = await recoverAfterTransportDrop({
        errorMessage: `429 rate_limit_exceeded; Retry-After: ${new Date(nowMs + delayMs).toUTCString()}`,
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    {
      label: "fails over past the saved maxRetryDelayMs when a fallback exists",
      errorMessage:
        '429 rate limit: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      errorBody: JSON.stringify({ headers: { "retry-after": "9897" } }),
      fallbackConfigured: true,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "proceed",
      expectedSleepMs: undefined,
    },
    {
      // Live shape: exec/write already ran, so rotation and fallback are both
      // refused downstream. Declining the wait would end the turn; keep waiting.
      label: "keeps waiting past the cap when tool activity made the attempt replay-unsafe",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 9897",
      fallbackConfigured: true,
      replaySafe: false,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 9_897_000,
    },
    {
      label: "still sleeps the same floor with no fallback",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 9897",
      fallbackConfigured: false,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 9_897_000,
    },
    {
      label: "keeps a floor inside the cap on the same model",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 20",
      fallbackConfigured: true,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 20_000,
    },
  ])("$label", async (scenario) => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
      errorMessage: scenario.errorMessage,
      errorBody: scenario.errorBody,
      fallbackConfigured: scenario.fallbackConfigured,
      replaySafe: scenario.replaySafe,
      providerRetryMaxDelayMs: scenario.providerRetryMaxDelayMs,
      diagnostics: [],
    });
    expect(recovery.action).toBe(scenario.expectedAction);
    if (scenario.expectedSleepMs === undefined) {
      expect(sleepWithAbort).not.toHaveBeenCalled();
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    } else {
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(scenario.expectedSleepMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    }
  });

  it("surfaces an unsafe post-tool 429 past the configured wait bound without replay or sleep", async () => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, continueFromCurrentTranscript, failoverRetryController } =
      await recoverAfterTransportDrop({
        config: { agents: { defaults: { retry: { maxUnsafeWaitMs: 600_000 } } } },
        errorMessage: "429 rate_limit_exceeded; Retry-After: 6581",
        fallbackConfigured: true,
        replaySafe: false,
        providerRetryMaxDelayMs: 60_000,
        diagnostics: [],
      });
    expect(recovery.action).toBe("proceed");
    expect(sleepWithAbort).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    expect(failoverRetryController.transientRetryCount).toBe(0);
  });

  it("preserves the larger header floor after an SDK failure becomes an assistant message", async () => {
    vi.mocked(sleepWithAbort).mockClear();
    const projection = projectProviderError(
      new APIError(
        429,
        { message: "Please try again in 1s." },
        undefined,
        new Headers({ "retry-after": "7", "retry-after-ms": "335" }),
      ),
    );
    const { recovery } = await recoverAfterTransportDrop(projection);
    expect(recovery.action).toBe("retry");
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(7000, undefined);
  });
});
