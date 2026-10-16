// Fork T3705 (T3699 option D): pressure-deferred isolated cron dispatch re-checks the guard on
// a bounded schedule, exercised through the real onTimer -> execute -> outcome path.
import { describe, expect, it, vi, type Mock } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import {
  readCgroupMemorySample,
  type DispatchPressureDecision,
  type DispatchPressureGuardInput,
} from "../../process/dispatch-pressure-guard.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  CRON_PRESSURE_DEFER_ERROR,
  PRESSURE_RETRY_INTERVAL_MS,
  PRESSURE_RETRY_MAX_ATTEMPTS,
  resolvePressureDeferralRetry,
} from "./pressure-deferral-retry.js";
import { createDueIsolatedAgentJob } from "./timer.seam.test-support.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-pressure-deferral-retry" });

const GIB = 1024 * 1024 * 1024;
const DEFER_LOG = "cron: isolated agent dispatch deferred by gateway pressure guard";
const RECHECK_LOG = "cron: pressure-deferred isolated dispatch will re-check the guard";
const GIVE_UP_LOG =
  "cron: pressure-deferred isolated dispatch gave up re-checking; skipped until next slot";

type Guard = (input: DispatchPressureGuardInput) => DispatchPressureDecision;

const deferDecision = (): DispatchPressureDecision => ({
  status: "defer" as const,
  reason: "cgroup_memory_absolute_threshold" as const,
  sample: {
    cgroupDir: "/sys/fs/cgroup/openclaw-gateway",
    currentBytes: 13 * GIB,
    fileCacheBytes: 3 * GIB,
    anonBytes: 9 * GIB,
    kernelBytes: GIB,
    workingSetBytes: 10 * GIB,
  },
  threshold: { workingSetBytes: 6 * GIB },
});
const allowDecision = (): DispatchPressureDecision => ({
  status: "allow",
  reason: "below_threshold",
});

async function setup(params: { expr: string; guard: Mock<Guard> }) {
  const { storePath } = await makeStorePath();
  const startMs = Date.parse("2026-10-16T03:00:00.000Z");
  let nowMs = startMs;
  const job: CronJob = {
    ...createDueIsolatedAgentJob({ now: startMs }),
    // Exact slots: top-of-hour expressions otherwise get a deterministic stagger.
    schedule: { kind: "cron", expr: params.expr, tz: "UTC", staggerMs: 0 },
    state: { nextRunAtMs: startMs },
  };
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronServiceState({
    defaultAgentId: "main",
    cronEnabled: true,
    log,
    storePath,
    scheduler: createTestGatewayScheduler(),
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
    dispatchPressureGuard: params.guard,
  });
  const tick = async () => {
    await onTimer(state);
    const stored = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
    return stored?.state.nextRunAtMs;
  };
  const advanceTo = (atMs: number) => {
    nowMs = atMs;
  };
  const warnsWith = (msg: string) => log.warn.mock.calls.filter((call) => call[1] === msg);
  return { startMs, tick, advanceTo, runIsolatedAgentJob, warnsWith };
}

describe("pressure-deferred isolated cron dispatch re-check (T3705)", () => {
  it("defers, then dispatches when the guard admits on the second check", async () => {
    const guard = vi
      .fn<Guard>()
      .mockImplementationOnce(deferDecision)
      .mockImplementation(allowDecision);
    const env = await setup({ expr: "0 3 * * *", guard });

    const firstNext = await env.tick();
    expect(firstNext).toBe(env.startMs + PRESSURE_RETRY_INTERVAL_MS);
    expect(env.runIsolatedAgentJob).not.toHaveBeenCalled();
    const [deferLine] = env.warnsWith(DEFER_LOG);
    expect(deferLine?.[0]).toMatchObject({
      reason: "cgroup_memory_absolute_threshold",
      anonBytes: 9 * GIB,
      fileCacheBytes: 3 * GIB,
      kernelBytes: GIB,
      workingSetBytes: 10 * GIB,
    });

    env.advanceTo(firstNext!);
    const secondNext = await env.tick();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(env.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(secondNext).toBe(Date.parse("2026-10-17T03:00:00.000Z"));
    expect(env.warnsWith(GIVE_UP_LOG)).toHaveLength(0);
  });

  it("gives up at the 3 hour cap with one logged skip and resumes the natural schedule", async () => {
    const guard = vi.fn<Guard>(deferDecision);
    const env = await setup({ expr: "0 3 * * *", guard });

    let next = await env.tick();
    for (
      let i = 0;
      i < 2 * PRESSURE_RETRY_MAX_ATTEMPTS && next! < env.startMs + 3 * 3_600_000;
      i++
    ) {
      env.advanceTo(next!);
      next = await env.tick();
    }

    // Re-checks at +10..+170 min; +180 would reach the cap, so the 18th deferral gives up.
    expect(guard).toHaveBeenCalledTimes(18);
    expect(env.warnsWith(RECHECK_LOG)).toHaveLength(17);
    expect(env.warnsWith(GIVE_UP_LOG)).toHaveLength(1);
    expect(env.warnsWith(GIVE_UP_LOG)[0]?.[0]).toMatchObject({ attempts: 17 });
    expect(env.runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(next).toBe(Date.parse("2026-10-17T03:00:00.000Z"));
  });

  it("stops re-checking at the job's next scheduled slot when it comes before the cap", async () => {
    const guard = vi.fn<Guard>(deferDecision);
    const env = await setup({ expr: "0 * * * *", guard });

    let next = await env.tick();
    const slotMs = Date.parse("2026-10-16T04:00:00.000Z");
    for (let i = 0; i < 2 * PRESSURE_RETRY_MAX_ATTEMPTS && next! < slotMs; i++) {
      env.advanceTo(next!);
      next = await env.tick();
    }

    // 03:00 defer, re-checks 03:10..03:50; 04:00 is the natural slot, not a retry.
    expect(guard).toHaveBeenCalledTimes(6);
    expect(env.warnsWith(RECHECK_LOG)).toHaveLength(5);
    expect(env.warnsWith(GIVE_UP_LOG)).toHaveLength(1);
    expect(next).toBe(slotMs);
    const result = env.warnsWith(DEFER_LOG).length;
    expect(result).toBe(6);
  });
});

describe("resolvePressureDeferralRetry bounds (T3705)", () => {
  it("is idempotent per outcome and does not reopen an exhausted window on re-apply", () => {
    const serviceKey = {};
    const log = { warn: vi.fn() };
    const t0 = Date.parse("2026-10-16T03:00:00.000Z");
    const nextDay = t0 + 24 * 3_600_000;
    const resolve = (endedAtMs: number, naturalNextRunAtMs = nextDay) =>
      resolvePressureDeferralRetry({
        serviceKey,
        log,
        jobId: "job",
        endedAtMs,
        naturalNextRunAtMs,
      });

    expect(resolve(t0)).toBe(t0 + PRESSURE_RETRY_INTERVAL_MS);
    expect(resolve(t0)).toBe(t0 + PRESSURE_RETRY_INTERVAL_MS);
    expect(log.warn).toHaveBeenCalledTimes(1);

    let at = t0;
    let retry: number | undefined = t0 + PRESSURE_RETRY_INTERVAL_MS;
    let calls = 0;
    while (retry !== undefined && calls < 100) {
      at = retry;
      retry = resolve(at);
      calls += 1;
    }
    expect(calls).toBeLessThanOrEqual(PRESSURE_RETRY_MAX_ATTEMPTS);
    expect(resolve(at)).toBeUndefined();
    // The next natural slot's deferral opens a fresh, still-bounded window.
    expect(resolve(nextDay, nextDay + 24 * 3_600_000)).toBe(nextDay + PRESSURE_RETRY_INTERVAL_MS);
  });

  it("never schedules a re-check when the natural slot is sooner than the interval", () => {
    const log = { warn: vi.fn() };
    const t0 = Date.parse("2026-10-16T03:00:00.000Z");
    expect(
      resolvePressureDeferralRetry({
        serviceKey: {},
        log,
        jobId: "every-minute",
        endedAtMs: t0,
        naturalNextRunAtMs: t0 + 60_000,
      }),
    ).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("cgroup memory sample breakdown (T3705)", () => {
  it("reads anon and kernel from memory.stat without changing the working set", () => {
    const files: Record<string, string> = {
      "/cg/memory.current": String(13 * GIB),
      "/cg/memory.max": "max",
      "/cg/memory.stat": `anon ${9 * GIB}\nfile ${3 * GIB}\nkernel ${GIB}\nshmem 0\n`,
    };
    const sample = readCgroupMemorySample({
      cgroupDir: "/cg",
      readTextFile: (file: string) => files[file] ?? "",
    });
    expect(sample).toMatchObject({
      currentBytes: 13 * GIB,
      fileCacheBytes: 3 * GIB,
      anonBytes: 9 * GIB,
      kernelBytes: GIB,
      workingSetBytes: 10 * GIB,
    });
    expect(CRON_PRESSURE_DEFER_ERROR).toBe(
      "gateway memory pressure guard deferred isolated cron agent dispatch",
    );
  });
});
