import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { allowDispatchPressureForTest, setupCronServiceSuite } from "./service.test-harness.js";
import { stop } from "./service/ops-lifecycle.js";
import { remove, update } from "./service/ops-mutations.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer-scheduler.js";
import { runMissedJobs } from "./service/timer.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-restart-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});
const time = (value: string) => Date.parse(value);

describe("pending agent admission for missed command occurrences", () => {
  const restart = time("2025-12-13T17:00:00Z");
  const schedules = [
    {
      id: "digest",
      expr: "45 7 * * *",
      last: "2025-12-12T07:45:00Z",
      next: "2025-12-14T07:45:00Z",
    },
    { id: "drift", expr: "0 8 * * *", last: "2025-12-12T08:00:00Z", next: "2025-12-14T08:00:00Z" },
    {
      id: "sweep",
      expr: "5 9,17 * * *",
      last: "2025-12-12T17:05:00Z",
      next: "2025-12-13T17:05:00Z",
    },
  ] as const;
  const command = (entry: (typeof schedules)[number]) =>
    job({
      id: entry.id,
      agentId: "main",
      schedule: { kind: "cron", expr: entry.expr, tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "command", argv: ["echo", entry.id] },
      state: {
        nextRunAtMs: time(entry.next),
        lastRunAtMs: time(entry.last),
        lastRunStatus: "ok",
      },
    });

  it("holds all three exact occurrences until admission, then executes each once", async () => {
    vi.setSystemTime(restart);
    const { store, deps } = await fixture(schedules.map(command), { nowMs: () => restart });
    const pending = createDeferred<void>();
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        vi.spyOn(admission, "waitForAgentPreparation").mockImplementation(() => pending.promise);
        const state = createCronServiceState(deps);
        const catchup = runMissedJobs(state, { deferAgentWork: true });
        await vi.waitFor(async () => {
          const jobs = (await loadCronStore(store.storePath)).jobs;
          expect(jobs.every((entry) => entry.state.queuedAtMs !== undefined)).toBe(true);
        });
        expect(deps.runCommandJob).not.toHaveBeenCalled();
        for (const entry of (await loadCronStore(store.storePath)).jobs) {
          expect(entry.state.nextRunAtMs).toBe(
            time(schedules.find((item) => item.id === entry.id)!.next),
          );
          expect(entry.state.lastRunStatus).toBe("ok");
        }
        pending.resolve();
        await catchup;
        const jobs = (await loadCronStore(store.storePath)).jobs;
        expect(deps.runCommandJob).toHaveBeenCalledTimes(3);
        for (const entry of schedules) {
          const current = jobs.find((item) => item.id === entry.id);
          expect(current?.state).toMatchObject({
            lastRunAtMs: restart,
            lastRunStatus: "ok",
            nextRunAtMs: time(entry.next),
          });
        }
        stop(state);
      });
    } finally {
      pending.resolve();
      await store.cleanup();
    }
  });

  it("keeps unrelated timed command jobs runnable during the admission wait", async () => {
    vi.setSystemTime(restart);
    let now = restart;
    const healthy = job({
      id: "healthy",
      agentId: "other",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: restart + 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "command", argv: ["echo", "healthy"] },
      state: { nextRunAtMs: restart + 60_000 },
    });
    const { store, deps } = await fixture([command(schedules[0]), healthy], {
      nowMs: () => now,
    });
    const pending = createDeferred<void>();
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((agentId) =>
          agentId === "main" ? pending.promise : undefined,
        );
        const state = createCronServiceState(deps);
        const catchup = runMissedJobs(state, { deferAgentWork: true });
        await vi.waitFor(async () => {
          expect(
            (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === "digest")
              ?.state.queuedAtMs,
          ).toBeDefined();
        });
        now += 60_000;
        await onTimer(state);
        expect(deps.runCommandJob).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ job: expect.objectContaining({ id: "healthy" }) }),
        );
        pending.resolve();
        await catchup;
        expect(deps.runCommandJob).toHaveBeenCalledTimes(2);
        stop(state);
      });
    } finally {
      pending.resolve();
      await store.cleanup();
    }
  });

  it("does not let a still-pending overdue command run from a timer tick", async () => {
    vi.setSystemTime(restart);
    const overdue = command(schedules[0]);
    overdue.state.nextRunAtMs = time("2025-12-13T07:45:00Z");
    const { store, deps } = await fixture([overdue], { nowMs: () => restart });
    const pending = createDeferred<void>();
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        vi.spyOn(admission, "waitForAgentPreparation").mockImplementation(() => pending.promise);
        const state = createCronServiceState(deps);
        const catchup = runMissedJobs(state, { deferAgentWork: true });
        await vi.waitFor(async () => {
          expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeDefined();
        });
        await onTimer(state);
        expect(deps.runCommandJob).not.toHaveBeenCalled();
        pending.resolve();
        await catchup;
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
        stop(state);
      });
    } finally {
      pending.resolve();
      await store.cleanup();
    }
  });

  it("settles unreserved overflow before opening the timer during admission", async () => {
    vi.setSystemTime(restart);
    const pendingJob = command(schedules[0]);
    pendingJob.state.nextRunAtMs = time("2025-12-13T07:45:00Z");
    const overflow = command(schedules[1]);
    overflow.agentId = "other";
    overflow.state.nextRunAtMs = time("2025-12-13T08:00:00Z");
    const { store, deps } = await fixture([pendingJob, overflow], {
      nowMs: () => restart,
      maxMissedJobsPerRestart: 0,
      missedJobStaggerMs: 5_000,
    });
    const pending = createDeferred<void>();
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((agentId) =>
          agentId === "main" ? pending.promise : undefined,
        );
        const state = createCronServiceState(deps);
        const catchup = runMissedJobs(state, { deferAgentWork: true });
        await vi.waitFor(async () => {
          const jobs = (await loadCronStore(store.storePath)).jobs;
          expect(jobs.find((entry) => entry.id === "digest")?.state.queuedAtMs).toBeDefined();
          expect(jobs.find((entry) => entry.id === "drift")?.state.startupCatchupAtMs).toBe(
            restart + 5_000,
          );
        });
        await onTimer(state);
        expect(deps.runCommandJob).not.toHaveBeenCalled();
        pending.resolve();
        await catchup;
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
        stop(state);
      });
    } finally {
      pending.resolve();
      await store.cleanup();
    }
  });

  it("admits one pending agent without waiting for another", async () => {
    vi.setSystemTime(restart);
    const second = { ...command(schedules[1]), agentId: "second" };
    const { store, deps } = await fixture([command(schedules[0]), second], {
      nowMs: () => restart,
    });
    const firstReady = createDeferred<void>();
    const secondReady = createDeferred<void>();
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((agentId) =>
          agentId === "second" ? secondReady.promise : firstReady.promise,
        );
        const state = createCronServiceState(deps);
        const catchup = runMissedJobs(state, { deferAgentWork: true });
        await vi.waitFor(async () => {
          expect(
            (await loadCronStore(store.storePath)).jobs.every(
              (entry) => entry.state.queuedAtMs !== undefined,
            ),
          ).toBe(true);
        });
        secondReady.resolve();
        await vi.waitFor(() => expect(deps.runCommandJob).toHaveBeenCalledOnce());
        expect(deps.runCommandJob).toHaveBeenCalledWith(
          expect.objectContaining({ job: expect.objectContaining({ id: "drift" }) }),
        );
        firstReady.resolve();
        await catchup;
        expect(deps.runCommandJob).toHaveBeenCalledTimes(2);
        stop(state);
      });
    } finally {
      firstReady.resolve();
      secondReady.resolve();
      await store.cleanup();
    }
  });

  it.each(["disabled", "deleted"] as const)(
    "does not revive a %s command while admission waits",
    async (change) => {
      vi.setSystemTime(restart);
      const { store, deps } = await fixture([command(schedules[0])], { nowMs: () => restart });
      const pending = createDeferred<void>();
      try {
        await withAgentDatabaseStartupAdmission(async (admission) => {
          vi.spyOn(admission, "waitForAgentPreparation").mockImplementation(() => pending.promise);
          const state = createCronServiceState(deps);
          const catchup = runMissedJobs(state, { deferAgentWork: true });
          await vi.waitFor(async () => {
            expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeDefined();
          });
          if (change === "disabled") {
            await update(state, "digest", { enabled: false });
          } else {
            await remove(state, "digest");
          }
          pending.resolve();
          await catchup;
          expect(deps.runCommandJob).not.toHaveBeenCalled();
          const jobs = (await loadCronStore(store.storePath)).jobs;
          expect(change === "deleted" ? jobs.length === 0 : jobs[0]?.enabled === false).toBe(true);
          stop(state);
        });
      } finally {
        pending.resolve();
        await store.cleanup();
      }
    },
  );

  it.each(["failure", "schedule-edit", "stop"] as const)(
    "handles admission wait %s without running the retired command",
    async (scenario) => {
      vi.setSystemTime(restart);
      let available = true;
      let now = restart;
      const { store, deps } = await fixture([command(schedules[0])], {
        nowMs: () => now,
        isAgentAvailable: () => available,
      });
      const pending = createDeferred<void>();
      try {
        await withAgentDatabaseStartupAdmission(async (admission) => {
          let waiting = true;
          vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((_agentId, options) => {
            if (!waiting) {
              return undefined;
            }
            options?.signal?.addEventListener(
              "abort",
              () => pending.reject(options?.signal?.reason),
              { once: true },
            );
            return pending.promise;
          });
          const state = createCronServiceState(deps);
          const catchup = runMissedJobs(state, { deferAgentWork: true });
          await vi.waitFor(async () => {
            expect((await loadCronStore(store.storePath)).jobs[0]?.state.queuedAtMs).toBeDefined();
          });
          if (scenario === "schedule-edit") {
            await update(state, "digest", {
              schedule: { kind: "cron", expr: "30 10 * * *", tz: "UTC" },
            });
            pending.resolve();
          } else if (scenario === "stop") {
            stop(state);
            waiting = false;
          } else {
            available = false;
            pending.reject(new Error("database preparation failed"));
          }
          await catchup;
          expect(deps.runCommandJob).not.toHaveBeenCalled();
          const current = (await loadCronStore(store.storePath)).jobs[0];
          if (scenario === "failure") {
            expect(current?.state.lastRunStatus).toBe("error");
            expect(current?.state.lastError).toContain("database preparation failed");
            expect(current?.state.consecutiveErrors).toBe(1);
            expect(current?.state.nextRunAtMs).toBe(restart + 60_000);
            expect(current?.state.startupCatchupAtMs).toBe(restart + 60_000);
            stop(state);
            waiting = false;
            available = true;
            const restarted = createCronServiceState(deps);
            await runMissedJobs(restarted);
            expect(deps.runCommandJob).not.toHaveBeenCalled();
            now += 60_000;
            await onTimer(restarted);
            await onTimer(restarted);
            expect(deps.runCommandJob).toHaveBeenCalledOnce();
            expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
            stop(restarted);
          } else {
            expect(current?.state.lastRunStatus).toBe("ok");
          }
          if (scenario === "schedule-edit") {
            expect(current?.schedule).toMatchObject({ expr: "30 10 * * *" });
          }
          if (scenario === "stop") {
            const restarted = createCronServiceState(deps);
            await runMissedJobs(restarted);
            expect(deps.runCommandJob).toHaveBeenCalledOnce();
            expect((await loadCronStore(store.storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
            stop(restarted);
          }
          stop(state);
        });
      } finally {
        pending.resolve();
        await store.cleanup();
      }
    },
  );
});
function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: "restart-job",
    name: "restart job",
    enabled: true,
    createdAtMs: time("2025-12-10T12:00:00Z"),
    updatedAtMs: time("2025-12-13T04:01:00Z"),
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...overrides,
  };
}

async function fixture(jobs: CronJob[], overrides: Partial<CronServiceDeps> = {}) {
  const store = await makeStorePath();
  await saveCronStore(store.storePath, { version: 1, jobs });
  const deps = {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    onEvent: vi.fn(),
    runCommandJob: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    dispatchPressureGuard: allowDispatchPressureForTest,
    ...overrides,
  };
  return { store, deps };
}

async function withRestartedCron(
  jobs: CronJob[],
  run: (cron: CronService, deps: Awaited<ReturnType<typeof fixture>>["deps"]) => Promise<void>,
) {
  const { store, deps } = await fixture(jobs);
  const cron = new CronService(deps);
  try {
    await cron.start();
    await run(cron, deps);
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

describe("CronService restart catch-up", () => {
  it("preserves delivery target writeback from a startup catch-up run", async () => {
    const target = job({
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run" },
      delivery: { mode: "announce", channel: "telegram", to: "https://t.me/obviyus" },
      state: { nextRunAtMs: Date.now() - 60_000 },
    });
    const { store, deps } = await fixture([target]);
    const state = createCronServiceState({
      ...deps,
      runIsolatedAgentJob: async () => {
        const persisted = await loadCronStore(store.storePath);
        const current = persisted.jobs.find((entry) => entry.id === target.id);
        if (current?.delivery) {
          current.delivery.to = "-10012345/6789";
        }
        await saveCronStore(store.storePath, persisted);
        return { status: "ok", delivered: true };
      },
    });
    await runMissedJobs(state);
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      delivery: { to: "-10012345/6789" },
      state: { lastRunStatus: "ok", lastDelivered: true },
    });
  });

  it("does not resurrect a job removed during startup catch-up", async () => {
    const { store, deps } = await fixture([
      job({
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "run" },
        state: { nextRunAtMs: Date.now() - 60_000 },
      }),
    ]);
    const state = createCronServiceState({
      ...deps,
      runIsolatedAgentJob: async () => {
        await saveCronStore(store.storePath, { version: 1, jobs: [] });
        return { status: "ok", summary: "removed", delivered: false };
      },
    });
    await runMissedJobs(state);
    expect((await loadCronStore(store.storePath)).jobs).toStrictEqual([]);
    expect(state.store?.jobs).toStrictEqual([]);
    expect(deps.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "restart-job", action: "finished", status: "ok" }),
    );
  });

  it("does not defer an isolated cron job whose persisted due slot finished as skipped", async () => {
    vi.setSystemTime(time("2025-12-13T11:00:00Z"));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr: "10 9 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "daily reminder" },
          state: {
            nextRunAtMs: time("2025-12-13T09:10:00Z"),
            lastRunAtMs: time("2025-12-13T09:10:30Z"),
            lastRunStatus: "skipped",
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state).toMatchObject({
          lastRunStatus: "skipped",
          nextRunAtMs: time("2025-12-14T09:10:00Z"),
        });
      },
    );
  });

  it("replays a cron slot due exactly at restart behind a completed persisted slot", async () => {
    vi.setSystemTime(time("2025-12-13T04:02:00Z"));
    await withRestartedCron(
      [
        job({
          state: {
            nextRunAtMs: time("2025-12-13T04:01:00Z"),
            lastRunAtMs: time("2025-12-13T04:01:00Z"),
            lastRunStatus: "ok",
          },
        }),
      ],
      async (_cron, deps) => {
        expect(deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
          "tick",
          expect.objectContaining({ agentId: "main" }),
        );
        expect(deps.requestHeartbeat).toHaveBeenCalled();
      },
    );
  });

  it("marks interrupted recurring jobs failed instead of replaying them on startup", async () => {
    const runningAtMs = time("2025-12-13T16:30:00Z");
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
          state: { nextRunAtMs: time("2025-12-13T16:00:00Z"), runningAtMs },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
        const stored = cron.getJob("restart-job");
        expect(stored?.state.runningAtMs).toBeUndefined();
        expect(stored?.state).toMatchObject({
          lastStatus: "error",
          lastRunStatus: "error",
          lastRunAtMs: runningAtMs,
          lastError: "cron: job interrupted by gateway restart",
        });
        expect(stored?.state.nextRunAtMs).toBeGreaterThan(Date.now());
        expect(deps.onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: "restart-job",
            action: "finished",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: runningAtMs,
          }),
        );
      },
    );
  });

  it("releases queued reservations and runs due jobs after restart", async () => {
    const dueAt = time("2025-12-13T16:30:00Z");
    const state = { nextRunAtMs: dueAt, queuedAtMs: time("2025-12-13T16:45:00Z") };
    await withRestartedCron(
      [
        job({ id: "recurring", schedule: { kind: "every", everyMs: 60_000 }, state }),
        job({
          id: "one-shot",
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(dueAt).toISOString() },
          state,
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSystemEvent).toHaveBeenCalledTimes(2);
        expect(cron.getJob("recurring")).toMatchObject({
          enabled: true,
          state: { lastRunStatus: "ok" },
        });
        expect(cron.getJob("recurring")?.state.queuedAtMs).toBeUndefined();
        expect(cron.getJob("one-shot")).toBeUndefined();
        expect(deps.onEvent).not.toHaveBeenCalledWith(
          expect.objectContaining({
            action: "finished",
            error: "cron: job interrupted by gateway restart",
          }),
        );
      },
    );
  });

  it("does not mistake a future retry for a rescheduled one-shot on restart", async () => {
    const runningAtMs = time("2025-12-13T16:30:00Z");
    await withRestartedCron(
      [
        job({
          deleteAfterRun: true,
          schedule: { kind: "at", at: "2025-12-13T16:00:00Z" },
          updatedAtMs: runningAtMs,
          state: { nextRunAtMs: time("2025-12-13T18:00:00Z"), runningAtMs },
        }),
      ],
      async (cron, deps) => {
        const recovered = cron.getJob("restart-job");
        expect(recovered).toMatchObject({
          enabled: false,
          deleteAfterRun: true,
          schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
          state: {
            lastRunAtMs: runningAtMs,
            lastRunStatus: "error",
            lastDeliveryStatus: "unknown",
          },
        });
        expect(recovered?.state.runningAtMs).toBeUndefined();
        expect(recovered?.state.nextRunAtMs).toBeUndefined();
        expect(recovered?.state.startupCatchupAtMs).toBeUndefined();
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
        expect(deps.onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: "restart-job",
            action: "finished",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: runningAtMs,
          }),
        );
      },
    );
  });

  it("keeps missed cron slots paused until run-end error backoff expires after restart", async () => {
    vi.setSystemTime(time("2025-12-13T04:01:59Z"));
    await withRestartedCron(
      [
        job({
          state: {
            nextRunAtMs: time("2025-12-13T04:10:00Z"),
            lastRunAtMs: time("2025-12-13T04:00:00Z"),
            lastDurationMs: 90_000,
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state.nextRunAtMs).toBe(time("2025-12-13T04:02:00Z"));
        cron.stop();
        vi.setSystemTime(time("2025-12-13T04:02:00Z"));
        await cron.start();
        expect(deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("tick", expect.anything());
      },
    );
  });

  it("keeps past-due retries paused with lastRunStatus-only history and run-end backoff", async () => {
    vi.setSystemTime(time("2025-12-13T04:01:59Z"));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "every", everyMs: 60_000, anchorMs: time("2025-12-13T04:00:00Z") },
          state: {
            nextRunAtMs: time("2025-12-13T04:00:30Z"),
            lastRunAtMs: time("2025-12-13T04:00:00Z"),
            lastDurationMs: 90_000,
            lastRunStatus: "error",
            consecutiveErrors: 1,
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state.nextRunAtMs).toBe(time("2025-12-13T04:02:00Z"));
        expect(cron.getJob("restart-job")?.state.lastRunStatus).toBe("error");
        expect(cron.getJob("restart-job")?.state.lastStatus).toBeUndefined();
      },
    );
  });

  it("stagger-limits overdue disabled-heartbeat one-shot retries after restart", async () => {
    const now = Date.now();
    const jobs = [now - 60_000, now - 45_000].map((nextRunAtMs, index) =>
      job({
        id: `retry-${index}`,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(nextRunAtMs - 30_000).toISOString() },
        wakeMode: "now",
        payload: { kind: "systemEvent", text: `retry-${index}` },
        state: {
          nextRunAtMs,
          lastRunAtMs: nextRunAtMs - 30_000,
          lastRunStatus: "skipped",
          lastError: "disabled",
          consecutiveSkipped: 1,
        },
      }),
    );
    const { store, deps } = await fixture(jobs, {
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });
    const state = createCronServiceState(deps);
    await runMissedJobs(state);
    expect(deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("retry-0", expect.anything());
    expect(deps.requestHeartbeat).toHaveBeenCalledOnce();
    expect((await loadCronStore(store.storePath)).jobs).toEqual([
      expect.objectContaining({
        id: "retry-1",
        enabled: true,
        state: expect.objectContaining({
          lastRunStatus: "skipped",
          lastError: "disabled",
          nextRunAtMs: now + 5_000,
        }),
      }),
    ]);
  });

  it.each([
    {
      label: "the first second of a slot",
      restart: "2025-12-13T04:02:00.500Z",
      last: "2025-12-13T04:01:00Z",
      next: "2025-12-13T04:03:00Z",
      expr: "* * * * *",
      tz: "UTC",
    },
    {
      label: "a daylight-saving fold",
      restart: "2026-11-01T06:05:00Z",
      last: "2026-10-31T07:30:00Z",
      next: "2026-11-01T08:30:00Z",
      expr: "30 1,3 * * *",
      tz: "America/New_York",
    },
    {
      label: "a spring-forward gap",
      restart: "2027-03-14T07:05:00Z",
      last: "2027-03-13T08:45:00Z",
      next: "2027-03-14T07:45:00Z",
      expr: "45 1,2,3 * * *",
      tz: "America/New_York",
    },
  ])("replays a missed slot across $label only once", async ({ restart, last, next, expr, tz }) => {
    vi.setSystemTime(time(restart));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr, tz },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: { nextRunAtMs: time(next), lastRunAtMs: time(last), lastStatus: "ok" },
        }),
      ],
      async (cron, deps) => {
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
        expect(cron.getJob("restart-job")?.state).toMatchObject({
          lastRunAtMs: time(restart),
          nextRunAtMs: time(next),
        });
        cron.stop();
        await cron.start();
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
      },
    );
  });
});
