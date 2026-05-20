import { beforeEach, describe, expect, it, vi } from "vitest";

describe("message action gateway runtime import cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("clears a failed gateway runtime import so a later read can recover", async () => {
    const callGatewayLeastPrivilege = vi.fn();
    const randomIdempotencyKey = vi.fn(() => "idem-recovered");
    const runtimeState = {
      shouldFail: true,
      callGatewayLeastPrivilege,
      randomIdempotencyKey,
    };

    Reflect.set(globalThis, "__openclawMessageRuntimeImportTest", runtimeState);

    vi.doMock("./message.gateway.runtime.js", () => {
      const state = Reflect.get(globalThis, "__openclawMessageRuntimeImportTest") as {
        shouldFail: boolean;
        callGatewayLeastPrivilege: typeof callGatewayLeastPrivilege;
        randomIdempotencyKey: typeof randomIdempotencyKey;
      };
      if (state.shouldFail) {
        throw Object.assign(
          new Error(
            "Cannot find module '/tmp/openclaw/dist/message.gateway.runtime.js' imported from /tmp/openclaw/dist/message-action-runner.js",
          ),
          { code: "ERR_MODULE_NOT_FOUND" },
        );
      }

      return {
        callGatewayLeastPrivilege: state.callGatewayLeastPrivilege,
        randomIdempotencyKey: state.randomIdempotencyKey,
      };
    });

    const { __testing } = await import("./message-action-runner.js");

    await expect(__testing.loadMessageActionGatewayRuntimeForTests()).rejects.toThrow();

    runtimeState.shouldFail = false;

    await expect(__testing.loadMessageActionGatewayRuntimeForTests()).resolves.toMatchObject({
      callGatewayLeastPrivilege,
      randomIdempotencyKey,
    });
  });
});
