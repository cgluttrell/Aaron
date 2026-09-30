// Covers heartbeat delivery routes for queued events and isolated completions.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
  mockCallAt,
  readSessionStoreForTest,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
  resetCronActiveJobs();
});

afterEach(async () => {
  setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
  await requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Heartbeat event routing", () => {
  const installDiscordSender = () => {
    const sendDiscord = vi
      .fn()
      .mockResolvedValue({ channel: "discord", messageId: "discord-send" });
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: { deliveryMode: "direct", sendText: sendDiscord, sendMedia: sendDiscord },
          }),
          source: "test",
        },
      ]),
    );
    return sendDiscord;
  };

  it("keeps a routeless MC worker exec completion internal despite the default Discord destination", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendDiscord = installDiscordSender();
      const sessionKey = "agent:qa-security:mission-control-vex-no-route";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "discord", to: "channel:1483685213484613733" },
          },
          list: [{ id: "qa-security" }],
        },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "worker-no-route",
        createdVia: "operator",
        delivery: { kind: "internal" },
      });
      enqueueSystemEvent("Exec completed (worker-command, code 0) :: private result", {
        sessionKey,
      });
      replySpy.mockResolvedValue({ text: "private result" });
      const sendTelegram = vi.fn();

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "qa-security",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      const context = getFirstReplyContext(replySpy);
      expect(context.Body).toContain("user delivery is disabled");
      expect(context.Body).not.toContain("Please relay the command output to the user");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(sendDiscord).not.toHaveBeenCalled();
      const transcript = await loadTranscriptEvents({
        agentId: "qa-security",
        sessionKey,
        sessionId: "worker-no-route",
        storePath,
      });
      expect(
        transcript
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant"),
      ).toEqual([]);
    });
  });

  it("keeps a same-facts WebChat exec completion user-visible without the MC key prefix", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } },
        },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "webchat-no-route",
        createdVia: "operator",
        lastChannel: "webchat",
        lastTo: "",
      });
      expect(readSessionStoreForTest(storePath)[sessionKey]).toMatchObject({
        createdVia: "operator",
        delivery: { kind: "internal" },
      });
      enqueueSystemEvent("Exec completed (webchat-command, code 0) :: visible result", {
        sessionKey,
      });
      replySpy.mockResolvedValue({ text: "visible result" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain(
        "Please relay the command output to the user",
      );
      expect(getFirstReplyContext(replySpy).Body).not.toContain("user delivery is disabled");
    });
  });

  it("routes an MC worker exec completion to its own bound route instead of default Discord", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendDiscord = installDiscordSender();
      const sessionKey = "agent:qa-security:mission-control-vex-bound";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "discord", to: "channel:1483685213484613733" },
          },
          list: [{ id: "qa-security" }],
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "worker-bound",
        createdVia: "operator",
        lastChannel: "telegram",
        lastTo: "5232990709",
      });
      enqueueSystemEvent("Exec completed (worker-command, code 0) :: bound result", { sessionKey });
      replySpy.mockResolvedValue({ text: "bound result" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "bound-send" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "qa-security",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain(
        "Please relay the command output to the user",
      );
      expectTelegramSend(sendTelegram, { to: "5232990709", text: "bound result" });
      expect(sendDiscord).not.toHaveBeenCalled();
    });
  });

  it("continues relaying ordinary bound-channel exec completions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sessionKey = "agent:main:telegram:direct:5232990709";
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } } },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "ordinary-bound",
        lastChannel: "telegram",
        lastTo: "5232990709",
      });
      enqueueSystemEvent("Exec completed (ordinary-command, code 0) :: ordinary result", {
        sessionKey,
      });
      replySpy.mockResolvedValue({ text: "ordinary result" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "ordinary-send" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain(
        "Please relay the command output to the user",
      );
      expectTelegramSend(sendTelegram, { to: "5232990709", text: "ordinary result" });
    });
  });

  it("keeps configured scheduled-task delivery when an MC worker exec event is queued", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendDiscord = installDiscordSender();
      const sessionKey = "agent:qa-security:mission-control-vex-scheduled";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "discord", to: "channel:1483685213484613733" },
          },
          list: [{ id: "qa-security" }],
        },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "worker-scheduled",
        createdVia: "operator",
        delivery: { kind: "internal" },
      });
      enqueueSystemEvent("Exec completed (worker-command, code 0) :: private result", {
        sessionKey,
      });
      replySpy.mockResolvedValue({ text: "scheduled report" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "qa-security",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        tasks: [{ jobId: "report-job", name: "report", prompt: "Send the scheduled report" }],
        deps: { getReplyFromConfig: replySpy },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain("Run the following periodic tasks");
      expect(getFirstReplyContext(replySpy).Body).not.toContain(
        "Please relay the command output to the user",
      );
      expect(sendDiscord).toHaveBeenCalledOnce();
      expect(sendDiscord.mock.calls[0]?.[0]).toMatchObject({
        to: "channel:1483685213484613733",
        text: "scheduled report",
      });
    });
  });
  const createLastTargetConfig = (params: {
    tmpDir: string;
    storePath: string;
    isolatedSession?: boolean;
  }): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: params.storePath },
  });

  const writeTelegramSessionStore = async (
    storePath: string,
    sessionKey: string,
    overrides: Record<string, unknown>,
  ): Promise<void> => {
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
      ...overrides,
    });
  };

  const expectTelegramSend = (
    sendTelegram: ReturnType<typeof vi.fn>,
    params: {
      to: string;
      text: string;
      messageThreadId?: number;
    },
  ) => {
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const [to, text, options] = mockCallAt(sendTelegram, 0, "Telegram send");
    expect(to).toBe(params.to);
    expect(text).toBe(params.text);
    expect((options as { messageThreadId?: number } | undefined)?.messageThreadId).toBe(
      params.messageThreadId,
    );
  };

  it("routes wake-triggered heartbeat replies using queued system-event delivery context", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, {});

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        to: "-100155462274",
        text: "Restart complete",
        messageThreadId: 42,
      });
    });
  });

  it.each([
    {
      name: "base route",
      eventThreadId: undefined,
      baseThreadId: 42,
      expectedThreadId: 42,
      legacy: false,
    },
    {
      name: "same-queue event",
      eventThreadId: 42,
      baseThreadId: 42,
      expectedThreadId: 42,
      legacy: false,
    },
    {
      name: "moved base route",
      eventThreadId: 42,
      baseThreadId: 88,
      expectedThreadId: 42,
      legacy: false,
    },
    {
      name: "legacy same-queue event",
      eventThreadId: 42,
      baseThreadId: 42,
      expectedThreadId: 42,
      legacy: true,
    },
    {
      name: "legacy moved base route",
      eventThreadId: 42,
      baseThreadId: 88,
      expectedThreadId: 42,
      legacy: true,
    },
  ])(
    "delivers isolated exec completion using its $name",
    async ({ eventThreadId, baseThreadId, expectedThreadId, legacy }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
        const baseKey = resolveMainSessionKey(cfg);
        const isolatedKey = `${baseKey}:heartbeat`;
        const queueKey = legacy ? `${isolatedKey}:heartbeat` : isolatedKey;
        const target = (topic: number) => `telegram:-100155462274:topic:${topic}`;
        await writeTelegramSessionStore(storePath, baseKey, {
          sessionId: "base-conversation",
          lastTo: target(baseThreadId),
          lastThreadId: baseThreadId,
          chatType: "group",
          groupId: `-100155462274:topic:${baseThreadId}`,
          subject: "Operations",
          groupActivation: "always",
        });
        await seedSessionStore(storePath, queueKey, {
          sessionId: "previous-isolated-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
        const completion = "Exec completed (background-report, code 0) :: report is ready";
        enqueueSystemEvent(completion, {
          sessionKey: queueKey,
          ...(eventThreadId === undefined
            ? {}
            : {
                deliveryContext: {
                  channel: "telegram",
                  to: target(eventThreadId),
                  threadId: eventThreadId,
                },
              }),
        });
        const sendTelegram = vi
          .fn()
          .mockResolvedValue({ messageId: "completion", chatId: "-100155462274" });
        replySpy.mockResolvedValue({ text: "The report is ready." });

        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey: queueKey,
          reason: "exec-event",
          deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
        });

        expect(result.status).toBe("ran");
        expectTelegramSend(sendTelegram, {
          to: target(expectedThreadId),
          text: "The report is ready.",
          messageThreadId: expectedThreadId,
        });
        expect(getFirstReplyContext(replySpy)).toMatchObject({
          SessionKey: isolatedKey,
          InternalTurnSource: "exec",
          InputProvenance: { kind: "internal_system", sourceTool: "exec" },
          MessageThreadId: expectedThreadId,
          OriginatingChannel: "telegram",
          OriginatingTo: target(expectedThreadId),
          ChatType: "group",
        });
        const options = mockCallAt(
          replySpy,
          0,
          "isolated completion",
        )[1] as InternalGetReplyOptions;
        expect(options.replyConversation?.fields).toMatchObject({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
        });
        expect(options.replyConversation?.fields.GroupSubject).toBe(
          baseThreadId === expectedThreadId ? "Operations" : undefined,
        );
        expect(options.replyConversation?.activation).toBe(
          baseThreadId === expectedThreadId ? "always" : undefined,
        );
        expect(peekSystemEvents(isolatedKey)).toEqual([]);
        expect(peekSystemEvents(queueKey)).toEqual([]);
        const rows = readSessionStoreForTest(storePath);
        if (legacy) {
          expect(rows[queueKey]).toBeUndefined();
        }
        expect(rows[baseKey]?.sessionId).toBe("base-conversation");
        expect(rows[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
        expect(rows[isolatedKey]?.sessionId).not.toBe("previous-isolated-run");
        expect(rows[isolatedKey]?.groupActivation).toBeUndefined();
      });
    },
  );

  it("retains a legacy queue's explicit base until its mixed cron follow-up completes", async ({
    signal,
  }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const baseKey = "agent:ops:alerts:heartbeat";
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey = `${isolatedKey}:heartbeat`;
      const storeTemplate = `${tmpDir}/agents/{agentId}/sessions/sessions.json`;
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "ops" });
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath: storeTemplate,
        isolatedSession: true,
      });
      cfg.agents!.list = [{ id: "ops" }];
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        isolatedSession: true,
        session: "alerts:heartbeat",
        target: "last",
      };
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      await seedSessionStore(storePath, queueKey, {
        sessionId: "old-isolated",
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      const readEntry = (sessionKey: string) =>
        loadExactSessionEntryReadOnly({ storePath, agentId: "ops", sessionKey })?.entry;
      expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
      enqueueSystemEvent("Exec completed (legacy, code 0) :: ready", { sessionKey: queueKey });
      enqueueSystemEvent("Reminder: Legacy queue work", {
        sessionKey: queueKey,
        contextKey: "cron:legacy",
      });
      enqueueSystemEvent("Unrelated base event", { sessionKey: baseKey });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
      replySpy.mockImplementation(async (ctx) => ({
        text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Reminder handled",
      }));
      const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const run = runHeartbeatOnce({
            ...opts,
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
          });
          if (opts.source === "cron") {
            followup.resolve(run);
          }
          return run;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await requestHeartbeatAndWait({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "ops",
          sessionKey: queueKey,
          coalesceMs: 0,
        });
        // The exec wake settles before its separately scheduled cron follow-up.
        await expect(racePromiseWithAbortSignal(followup.promise, signal)).resolves.toMatchObject({
          status: "ran",
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(
          replySpy.mock.calls.map(([ctx]) => [ctx.AgentId, ctx.SessionKey, ctx.InternalTurnSource]),
        ).toEqual([
          ["ops", isolatedKey, "exec"],
          ["ops", isolatedKey, "cron"],
        ]);
        expect(peekSystemEvents(queueKey)).toEqual([]);
        expect(peekSystemEvents(baseKey)).toEqual(["Unrelated base event"]);
        expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
        expect(readEntry(queueKey)).toBeUndefined();
        expect(readEntry(isolatedKey)?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
      } finally {
        runner.stop();
      }
    });
  });

  it.each([
    { name: "legacy isolated", queue: "legacy", dedicated: "none", busy: false },
    { name: "canonical isolated", queue: "isolated", dedicated: "none", busy: false },
    { name: "shared", queue: "shared", dedicated: "none", busy: false },
    { name: "excluded base", queue: "base", dedicated: "none", busy: false },
    { name: "legacy exec and cron", queue: "legacy", dedicated: "exec", busy: false },
    { name: "legacy cron", queue: "legacy", dedicated: "cron", busy: false },
    { name: "busy legacy", queue: "legacy", dedicated: "none", busy: true },
  ])("preserves generic wake queue ownership for $name", async ({ queue, dedicated, busy }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath,
        isolatedSession: queue !== "shared",
      });
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey =
        queue === "legacy"
          ? `${isolatedKey}:heartbeat`
          : queue === "isolated"
            ? isolatedKey
            : baseKey;
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      if (queueKey !== baseKey) {
        await seedSessionStore(storePath, queueKey, {
          sessionId: "previous-isolated-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
      }
      const generic = "Gateway restart ok: queued notification";
      const completion = "Exec completed (queue-report, code 0) :: report is ready";
      const reminder = "Reminder: review the scheduled report";
      if (dedicated === "exec") {
        enqueueSystemEvent(completion, { sessionKey: queueKey });
      }
      if (dedicated !== "none") {
        enqueueSystemEvent(reminder, { sessionKey: queueKey, contextKey: "cron:queue-report" });
      }
      enqueueSystemEvent(generic, { sessionKey: queueKey });
      const queuedBefore = peekSystemEvents(queueKey);
      let queuedAtReply: string[] | undefined;
      let formatted: string | undefined;
      let legacyRowRemovedAtReply = false;
      replySpy.mockImplementation(async (ctx, options) => {
        queuedAtReply = peekSystemEvents(queueKey);
        legacyRowRemovedAtReply = readSessionStoreForTest(storePath)[queueKey] === undefined;
        const eventContext = getReplySystemEventContext(options);
        const eventKey = eventContext?.sessionKey ?? ctx.SessionKey;
        if (!eventKey) {
          throw new Error("Expected the heartbeat's event or execution session key");
        }
        // Use the production generic-event formatter at the injected reply boundary.
        // The full admission suite separately proves route-key fallback and busy deferral.
        formatted = await drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: eventKey,
          isMainSession: false,
          isNewSession: false,
          events: eventContext?.events ?? [],
        });
        return { text: "HEARTBEAT_OK" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey: queueKey,
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => (busy ? 1 : 0),
        },
      });
      if (busy) {
        expect(result).toMatchObject({ status: "skipped", reason: "requests-in-flight" });
        expect(replySpy).not.toHaveBeenCalled();
        expect(peekSystemEvents(queueKey)).toEqual(queuedBefore);
        expect(readSessionStoreForTest(storePath)[queueKey]).toBeDefined();
        return;
      }
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(queuedAtReply).toEqual(queuedBefore);
      const context = getFirstReplyContext(replySpy);
      expect(context.SessionKey).toBe(queue === "shared" ? baseKey : isolatedKey);
      expect(context.InternalTurnSource).toBe(dedicated === "none" ? "heartbeat" : dedicated);
      expect(context.InputProvenance).toEqual({
        kind: "internal_system",
        sourceTool: dedicated === "none" ? "hook" : dedicated,
      });
      if (queue === "legacy") {
        expect(legacyRowRemovedAtReply).toBe(dedicated !== "exec");
      }
      if (queue === "base") {
        expect(formatted ?? "").not.toContain(generic);
        expect(peekSystemEvents(queueKey)).toEqual(queuedBefore);
      } else {
        expect(formatted).toContain(generic);
        expect(formatted).not.toContain(completion);
        expect(formatted).not.toContain(reminder);
        expect(peekSystemEvents(queueKey)).toEqual(dedicated === "exec" ? [reminder] : []);
      }
      if (dedicated !== "none") {
        expect(context.Body).toContain(dedicated === "exec" ? completion : reminder);
        expect(context.Body).not.toContain(generic);
      }
      expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe("base-conversation");
    });
  });

  it("delivers an isolated group completion after its base conversation moves to a blocked direct chat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      cfg.agents!.defaults!.heartbeat!.directPolicy = "block";
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      await writeTelegramSessionStore(storePath, baseKey, {
        sessionId: "moved-direct-conversation",
        lastTo: "user:operator",
        chatType: "direct",
      });
      await seedSessionStore(storePath, isolatedKey, {
        sessionId: "original-group-run",
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      const completion = "Exec completed (group-report, code 0) :: group report is ready";
      enqueueSystemEvent(completion, {
        sessionKey: isolatedKey,
        deliveryContext: { channel: "telegram", to: "group:ops" },
      });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "group-report", chatId: "group:ops" });
      replySpy.mockResolvedValue({ text: "Group report ready." });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey: isolatedKey,
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });
      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, { to: "group:ops", text: "Group report ready." });
      expect(getFirstReplyContext(replySpy)).toMatchObject({
        SessionKey: isolatedKey,
        OriginatingTo: "group:ops",
        ChatType: "group",
      });
      expect(peekSystemEvents(isolatedKey)).toEqual([]);
      expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe(
        "moved-direct-conversation",
      );
    });
  });

  it("does not reuse stale turn-source routing for isolated wake runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, { lastTo: "-100155462274" });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100999999999",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).SessionKey).toBe(`${sessionKey}:heartbeat`);
      expectTelegramSend(sendTelegram, {
        to: "-100155462274",
        text: "Restart complete",
      });
    });
  });
  it("keeps output-bearing exec-event delivery pinned to the original Telegram topic when session route drifts", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastThreadId: 2175,
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-1003774691294",
      });
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "The review-worker spawn finished successfully.",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0) :: review-worker spawn finished", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        to: "telegram:-1003774691294:topic:47",
        text: "The review-worker spawn finished successfully.",
        messageThreadId: 47,
      });
    });
  });

  it("suppresses metadata-only successful exec completions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastThreadId: 2175,
      });

      const sendTelegram = vi.fn();
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "HEARTBEAT_OK",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(getReplySpy).Body).toContain("no command output was found");
      expect(sendTelegram).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "keeps scheduled heartbeat routing with isolation=%s",
    async (isolated) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: isolated });
        const sessionKey = resolveMainSessionKey(cfg);
        await writeTelegramSessionStore(storePath, sessionKey, {
          lastTo: "-100155462274",
          deliveryContext: {
            channel: "telegram",
            to: "-100155462274",
            threadId: 42,
          },
          chatType: "group",
        });

        const sendTelegram = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "-100155462274",
        });
        replySpy.mockResolvedValue({ text: "Topic heartbeat" });

        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: "timer",
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegram,
          },
        });

        expect(result.status).toBe("ran");
        const replyCtx = getFirstReplyContext(replySpy);
        expect(replyCtx.SessionKey).toBe(isolated ? `${sessionKey}:heartbeat` : sessionKey);
        expect(replyCtx.InputProvenance).toEqual({
          kind: "internal_system",
          sourceTool: "heartbeat",
        });
        expect(replyCtx.MessageThreadId).toBe(42);
        expectTelegramSend(sendTelegram, {
          to: "-100155462274",
          text: "Topic heartbeat",
          messageThreadId: 42,
        });
      });
    },
  );
});
