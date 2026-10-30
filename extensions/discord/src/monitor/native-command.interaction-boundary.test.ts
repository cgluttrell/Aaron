import {
  ApplicationCommandOptionType,
  ChannelType,
  GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import * as commandStatus from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachRestMock,
  createInternalInteractionPayload,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import * as pickerPreferences from "./model-picker-preferences.js";
import * as pickerState from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordNativeCommand,
} from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const THREAD = "100000000000000003";
const USER = "100000000000000004";
const PRIVATE_THREAD = "100000000000000005";
const CHANNEL_CASES = [
  { label: "parent", channelId: CHANNEL },
  { label: "public thread", channelId: THREAD },
  { label: "private thread", channelId: PRIVATE_THREAD },
] as const;

type FixtureChannel = Extract<
  NonNullable<ReturnType<typeof createInternalInteractionPayload>["channel"]>,
  { type: ChannelType.GuildText | ChannelType.PublicThread | ChannelType.PrivateThread }
>;

function channelFixture(channelId: string): FixtureChannel {
  if (channelId === THREAD || channelId === PRIVATE_THREAD) {
    return {
      id: channelId,
      type: channelId === THREAD ? ChannelType.PublicThread : ChannelType.PrivateThread,
      parent_id: CHANNEL,
      name: "topic",
    };
  }
  if (channelId === CHANNEL || channelId === "denied") {
    return { id: channelId, type: ChannelType.GuildText, name: "parent" };
  }
  throw new Error(`Unexpected Discord channel ${channelId}`);
}

function createConfig(): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: [`user:${USER}`] } },
    agents: { defaults: { model: { primary: "test-provider/test-model" } } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: { [GUILD]: { channels: { [CHANNEL]: { enabled: true } } } },
      },
    },
  };
}

function createHarness() {
  const cfg = createConfig();
  let currentConfig = cfg;
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    accountId: "default",
    token: "test-token",
    readConfig: () => currentConfig,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const commandContext = {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    readPolicy,
    accountId: "default",
    sessionPrefix: "discord:slash",
    postApplySettleMs: 0,
    threadBindings: createNoopThreadBindingManager("default"),
  };
  const client = createInternalTestClient([
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "status", description: "Status", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "help", description: "Help", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: {
        name: "boundary-choice",
        description: "Choose",
        acceptsArgs: true,
        args: [
          {
            name: "choice",
            description: "Choice",
            type: "string",
            preferAutocomplete: true,
            choices: ({ model }) => [model ?? "unresolved"],
          },
        ],
      },
    }),
  ]);
  client.componentHandler.register(createDiscordModelPickerFallbackButton(commandContext));
  const post = vi.fn(async () => undefined);
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/channels/")) {
      return channelFixture(path.slice("/channels/".length));
    }
    throw new Error(`Unexpected Discord GET ${path}`);
  });
  const patch = vi.fn(async () => undefined);
  attachRestMock(client, { post, get, patch });
  const session = vi.spyOn(sessionStore, "getSessionEntry").mockReturnValue(undefined);
  vi.spyOn(pickerState, "loadDiscordModelPickerData").mockResolvedValue(
    createModelsProviderData({ "test-provider": ["test-model"] }),
  );
  vi.spyOn(pickerPreferences, "readDiscordModelPickerRecentModels").mockResolvedValue([]);
  const dispatch = vi
    .spyOn(channelInbound, "dispatchChannelInboundTurn")
    .mockImplementation(async () => {
      throw new Error("Unexpected agent turn");
    });
  const status = vi
    .spyOn(commandStatus, "resolveDirectStatusReplyForSession")
    .mockImplementation(async ({ sessionKey }) => ({ text: `Status for ${sessionKey}` }));
  return {
    client,
    post,
    get,
    status,
    dispatch,
    session,
    patch,
    replacePolicy: () => {
      currentConfig = {
        ...cfg,
        channels: { discord: { groupPolicy: "disabled" } },
      };
    },
  };
}

function payload(channelId: string, hydrated = false, userId = USER, commandName = "status") {
  return createInternalInteractionPayload({
    id: "interaction1",
    token: "test-token",
    guild_id: GUILD,
    channel_id: channelId,
    member: {
      user: { id: userId, username: "tester", discriminator: "0", avatar: null, global_name: null },
      roles: [],
      joined_at: "2026-01-01T00:00:00.000Z",
      deaf: false,
      mute: false,
      permissions: "0",
      flags: GuildMemberFlags.CompletedOnboarding,
    },
    ...(hydrated ? { channel: channelFixture(channelId) } : {}),
    data: { id: "command1", name: commandName, type: 1 },
  });
}

function autocompletePayload(channelId: string, hydrated = false, userId = USER) {
  return createInternalInteractionPayload({
    ...payload(channelId, hydrated, userId),
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      id: "command2",
      name: "boundary-choice",
      type: 1,
      options: [
        { name: "choice", type: ApplicationCommandOptionType.String, value: "", focused: true },
      ],
    },
  });
}

function pickerPayload(channelId: string, action: "back" | "reset" = "back", userId = USER) {
  return createInternalComponentInteractionPayload({
    ...payload(channelId, false, userId),
    data: {
      custom_id: pickerState.buildDiscordModelPickerCustomId({
        command: "model",
        action,
        view: "providers",
        userId,
      }),
    },
  });
}

function expectFollowUp(harness: ReturnType<typeof createHarness>, content: string) {
  expect(harness.post).toHaveBeenCalledWith(
    "/webhooks/app1/test-token",
    { body: { content, flags: 64 } },
    undefined,
  );
}

function expectEmptyAutocomplete(harness: ReturnType<typeof createHarness>) {
  expect(harness.post).toHaveBeenCalledExactlyOnceWith(
    "/interactions/interaction1/test-token/callback",
    {
      body: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [] },
      },
    },
  );
  expect(harness.session).not.toHaveBeenCalled();
}

function denyThreadParent(harness: ReturnType<typeof createHarness>, channelId = THREAD) {
  harness.get.mockImplementation(async (path: string) => {
    const channel = channelFixture(path.slice("/channels/".length));
    return channel.id === channelId ? { ...channel, parent_id: "denied" } : channel;
  });
}

function expectVisibleStatus(harness: ReturnType<typeof createHarness>, channelId: string) {
  const sessionKey = `agent:main:discord:channel:${channelId}`;
  expect(harness.status, JSON.stringify(harness.post.mock.calls)).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey, channel: "discord", senderId: USER, isGroup: true }),
  );
  expectFollowUp(harness, `Status for ${sessionKey}`);
}

// Isolated boundary proof: REST is controlled; interaction construction, dispatch,
// access policy, conversation routing and response serialization are production code.
describe("Client.handleInteraction native command channel identity", () => {
  beforeEach(() => clearDiscordChannelInfoCacheForTest());
  afterEach(() => vi.restoreAllMocks());

  it.each(
    CHANNEL_CASES.flatMap(({ label, channelId }) =>
      [false, true].map((hydrated) => ({ label, channelId, hydrated })),
    ),
  )("delivers status for $label with hydration=$hydrated", async ({ channelId, hydrated }) => {
    const harness = createHarness();
    await harness.client.handleInteraction(payload(channelId, hydrated));
    expectVisibleStatus(harness, channelId);
  });

  it.each(CHANNEL_CASES)("dispatches /help for the $label session", async ({ channelId }) => {
    const harness = createHarness();
    harness.dispatch.mockImplementationOnce(async (plan) => {
      if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
        throw new Error("Expected direct Discord delivery");
      }
      const reply = { text: "Help from the command fixture" };
      const info = { kind: "final" as const };
      const delivered = await plan.delivery.deliver(reply, info);
      await plan.delivery.onDelivered?.(reply, info, delivered);
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true as const,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } },
      };
    });

    await harness.client.handleInteraction(payload(channelId, false, USER, "help"));

    expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        route: { agentId: "main", sessionKey: `agent:main:discord:slash:${USER}` },
        ctxPayload: expect.objectContaining({
          SessionKey: `agent:main:discord:slash:${USER}`,
          CommandTargetSessionKey: `agent:main:discord:channel:${channelId}`,
          commandText: "/help",
        }),
      }),
    );
    const context = harness.dispatch.mock.calls[0]?.[0].ctxPayload;
    expect(context?.MessageThreadId).toBe(channelId === CHANNEL ? undefined : channelId);
    expect(context?.ThreadParentId).toBe(channelId === CHANNEL ? undefined : CHANNEL);
    expectFollowUp(harness, "Help from the command fixture");
  });

  it.each(
    [THREAD, PRIVATE_THREAD].flatMap((channelId) =>
      ["status", "help"].map((commandName) => ({ channelId, commandName })),
    ),
  )(
    "rejects /$commandName in thread $channelId with a denied parent",
    async ({ channelId, commandName }) => {
      const harness = createHarness();
      denyThreadParent(harness, channelId);
      await harness.client.handleInteraction(payload(channelId, false, USER, commandName));
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
      expectFollowUp(harness, "This channel is not allowed.");
    },
  );

  it.each(CHANNEL_CASES)(
    "autocompletes for the $label session through the registered option",
    async ({ channelId }) => {
      const harness = createHarness();
      await harness.client.handleInteraction(autocompletePayload(channelId));
      expect(harness.post).toHaveBeenCalledWith("/interactions/interaction1/test-token/callback", {
        body: {
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: { choices: [{ name: "test-model", value: "test-model" }] },
        },
      });
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
    },
  );

  it.each(CHANNEL_CASES)(
    "opens the registered picker for the $label session",
    async ({ channelId }) => {
      const harness = createHarness();
      await harness.client.handleInteraction(pickerPayload(channelId));
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
      expect(harness.patch).toHaveBeenCalledWith(
        "/webhooks/app1/test-token/messages/%40original",
        expect.objectContaining({
          body: expect.objectContaining({ components: expect.any(Array) }),
        }),
        expect.anything(),
      );
      expect(JSON.stringify(harness.patch.mock.calls)).toContain("test-provider");
    },
  );

  it.each([
    { denial: "sender", channelId: CHANNEL },
    { denial: "parent", channelId: THREAD },
    { denial: "parent", channelId: PRIVATE_THREAD },
  ])("denies raw autocomplete with denied $denial in $channelId", async ({ denial, channelId }) => {
    const harness = createHarness();
    const interaction = autocompletePayload(
      channelId,
      false,
      denial === "sender" ? "100000000000000099" : USER,
    );
    if (denial === "parent") {
      denyThreadParent(harness, channelId);
    }
    await harness.client.handleInteraction(interaction);
    expectEmptyAutocomplete(harness);
  });

  it.each([
    { denial: "sender", channelId: CHANNEL },
    { denial: "parent", channelId: THREAD },
    { denial: "parent", channelId: PRIVATE_THREAD },
    { denial: "identity", channelId: CHANNEL },
  ])(
    "denies raw picker selection with denied $denial in $channelId",
    async ({ denial, channelId }) => {
      const harness = createHarness();
      const interaction = pickerPayload(
        channelId,
        "reset",
        denial === "sender" ? "100000000000000099" : USER,
      );
      if (denial === "parent") {
        denyThreadParent(harness, channelId);
      }
      if (denial === "identity") {
        Reflect.deleteProperty(interaction, "channel_id");
      }
      await harness.client.handleInteraction(interaction);
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        "Failed to apply test-provider/test-model",
      );
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        denial === "sender" ? "not authorized" : "not allowed",
      );
    },
  );

  it.each(["status", "autocomplete", "picker"] as const)(
    "denies raw %s when policy changes during the channel fetch",
    async (surface) => {
      const harness = createHarness();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      harness.get.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
      });
      const interaction =
        surface === "status"
          ? payload(CHANNEL)
          : surface === "autocomplete"
            ? autocompletePayload(CHANNEL)
            : pickerPayload(CHANNEL, "reset");
      const pending = harness.client.handleInteraction(interaction);
      try {
        const fetched = await Promise.race([
          entered.promise.then(() => true),
          pending.then(() => false),
        ]);
        expect(fetched).toBe(true);
        harness.replacePolicy();
      } finally {
        release.resolve();
        await pending;
      }
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
      if (surface === "autocomplete") {
        expectEmptyAutocomplete(harness);
      } else if (surface === "status") {
        expectFollowUp(harness, "Access policy changed. Try this interaction again.");
      } else {
        expect(JSON.stringify(harness.post.mock.calls)).toContain(
          "Failed to apply test-provider/test-model",
        );
      }
    },
  );
});

installDiscordIngressTestRuntime();
