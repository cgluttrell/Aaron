import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const storeMocks = vi.hoisted(() => ({
  saveAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn().mockResolvedValue(null),
}));

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    saveAuthProfileStore: storeMocks.saveAuthProfileStore,
    updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  };
});

function makeEpermError(): NodeJS.ErrnoException {
  const error = new Error(
    "EPERM: operation not permitted, copyfile 'auth-profiles.json.tmp' -> 'auth-profiles.json'",
  ) as NodeJS.ErrnoException;
  error.code = "EPERM";
  return error;
}

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-test",
      },
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(null);
  storeMocks.saveAuthProfileStore.mockImplementation(() => {
    throw makeEpermError();
  });

  const { __testing } = await import("./usage.js");
  __testing.setDepsForTest({
    saveAuthProfileStore: storeMocks.saveAuthProfileStore,
    updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  });
});

describe("auth profile bookkeeping persistence failures", () => {
  it("does not fail a successful request when last-good persistence throws EPERM", async () => {
    const { markAuthProfileSuccess } = await import("./profiles.js");
    const store = makeStore();

    await expect(
      markAuthProfileSuccess({
        store,
        provider: "anthropic",
        profileId: "anthropic:default",
      }),
    ).resolves.toBeUndefined();

    expect(store.lastGood?.anthropic).toBe("anthropic:default");
    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledTimes(1);
  });

  it("does not fail request flow when failure bookkeeping persistence throws EPERM", async () => {
    const { markAuthProfileFailure } = await import("./usage.js");
    const store = makeStore();

    await expect(
      markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "unknown",
      }),
    ).resolves.toBeUndefined();

    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(1);
    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledTimes(1);
  });

  it("does not fail request flow when blocked-profile persistence throws EPERM", async () => {
    const { markAuthProfileBlockedUntil } = await import("./usage.js");
    const store = makeStore();
    const blockedUntil = Date.now() + 60_000;

    await expect(
      markAuthProfileBlockedUntil({
        store,
        profileId: "anthropic:default",
        blockedUntil,
        source: "wham",
      }),
    ).resolves.toBeUndefined();

    expect(store.usageStats?.["anthropic:default"]?.blockedUntil).toBe(blockedUntil);
    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledTimes(1);
  });
});
