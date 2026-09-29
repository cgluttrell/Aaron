import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord channel target-resolver tests cover normalized and directory-backed routing.
import { describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";
import * as directoryLive from "./directory-live.js";

function createCfg(): OpenClawConfig {
  return {
    channels: {
      discord: {
        enabled: true,
        token: "test-token-placeholder",
      },
    },
  } as OpenClawConfig;
}

function requireResolveTarget() {
  const resolveTarget = discordPlugin.messaging?.targetResolver?.resolveTarget;
  if (!resolveTarget) {
    throw new Error("Expected discordPlugin.messaging.targetResolver.resolveTarget to be defined");
  }
  return resolveTarget;
}

describe("discordPlugin messaging target resolver", () => {
  it("owns reserved destination literals and explicit-address guidance", () => {
    expect(discordPlugin.messaging?.targetResolver?.reservedLiterals).toEqual([
      "me",
      "self",
      "owner",
    ]);
    expect(discordPlugin.messaging?.targetResolver?.rejectReservedLiteralMatches).toBe(true);
    expect(discordPlugin.messaging?.targetResolver?.hint).toContain("user:<id> or channel:<id>");
  });
  it("resolves Discord usernames through the messaging target resolver", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);

    await expect(
      requireResolveTarget()({
        cfg: createCfg(),
        accountId: "default",
        input: "jane",
        normalized: "channel:jane",
        preferredKind: "user",
      }),
    ).resolves.toEqual({
      to: "user:999",
      kind: "user",
      display: "jane",
      source: "directory",
    });
  });

  it("rejects unresolved Discord names after the shared directory lookup misses", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValue([]);

    await expect(
      requireResolveTarget()({
        cfg: createCfg(),
        accountId: "default",
        input: "channel:missing",
        normalized: "channel:missing",
        preferredKind: "channel",
      }),
    ).resolves.toBeNull();
    await expect(
      requireResolveTarget()({
        cfg: createCfg(),
        accountId: "default",
        input: "user:missing",
        normalized: "user:missing",
        preferredKind: "user",
      }),
    ).resolves.toBeNull();
  });

  it("does not reinterpret a bare channel name as a Discord username on fallback", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "General" } as const,
    ]);

    await expect(
      requireResolveTarget()({
        cfg: createCfg(),
        accountId: "default",
        input: "general",
        normalized: "channel:general",
      }),
    ).resolves.toBeNull();
  });
});
