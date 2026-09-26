// Diagnostic memory cgroup tests cover service-cgroup working-set pressure (fork T2480).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { DispatchPressureSample } from "../process/dispatch-pressure-guard.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import { resetLogger } from "./logger.js";

const GIB = 1024 ** 3;
const quietProcess = { rss: 100, heapTotal: 80, heapUsed: 40, external: 10, arrayBuffers: 5 };

function cgroup(workingSetBytes: number, fileCacheBytes = 0, maxBytes?: number) {
  return {
    cgroupDir: "/sys/fs/cgroup/test.service",
    currentBytes: workingSetBytes + fileCacheBytes,
    fileCacheBytes,
    workingSetBytes,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  } satisfies DispatchPressureSample;
}

function pressures(samples: Array<{ now: number; cgroupMemory: DispatchPressureSample | null }>) {
  const events: DiagnosticEventPayload[] = [];
  const stop = onDiagnosticEvent((event) => events.push(event));
  for (const sample of samples) {
    emitDiagnosticMemorySample({
      ...sample,
      emitSample: false,
      memoryUsage: quietProcess,
      thresholds: { pressureRepeatMs: 0 },
    });
  }
  stop();
  return events.filter((event) => event.type === "diagnostic.memory.pressure");
}

describe("diagnostic memory cgroup pressure", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetLogger();
  });

  it("judges the working set, not reclaimable page cache", () => {
    expect(pressures([{ now: 1000, cgroupMemory: cgroup(2 * GIB, 8 * GIB) }])).toEqual([]);
  });

  it("warns and then goes critical on the cgroup working set", () => {
    const events = pressures([
      { now: 1000, cgroupMemory: cgroup(4.5 * GIB, 3 * GIB, 16 * GIB) },
      { now: 20 * 60_000, cgroupMemory: cgroup(6.5 * GIB) },
    ]);

    expect(events).toMatchObject([
      {
        level: "warning",
        reason: "cgroup_memory_threshold",
        thresholdBytes: 4 * GIB,
        cgroupMemoryBytes: 7.5 * GIB,
        cgroupMemoryWorkingSetBytes: 4.5 * GIB,
        cgroupMemoryFileCacheBytes: 3 * GIB,
        cgroupMemoryMaxBytes: 16 * GIB,
      },
      { level: "critical", reason: "cgroup_memory_threshold", thresholdBytes: 6 * GIB },
    ]);
    expect(events[1]).not.toHaveProperty("cgroupMemoryMaxBytes");
  });

  it("reports working-set growth between samples inside the growth window", () => {
    const events = pressures([
      { now: 1000, cgroupMemory: cgroup(GIB) },
      { now: 61_000, cgroupMemory: cgroup(2.25 * GIB) },
      { now: 121_000, cgroupMemory: cgroup(3.5 * GIB) },
    ]);

    expect(events).toMatchObject([
      {
        level: "warning",
        reason: "cgroup_memory_growth",
        thresholdBytes: GIB,
        cgroupMemoryGrowthBytes: 1.25 * GIB,
        windowMs: 60_000,
      },
      { level: "warning", reason: "cgroup_memory_growth", cgroupMemoryGrowthBytes: 1.25 * GIB },
    ]);
  });

  it("ignores growth across a gap longer than the growth window", () => {
    expect(
      pressures([
        { now: 1000, cgroupMemory: cgroup(GIB) },
        { now: 11 * 60_000 + 1000, cgroupMemory: cgroup(3.5 * GIB) },
      ]),
    ).toEqual([]);
  });

  it("forgets the previous cgroup sample when a tick has none", () => {
    expect(
      pressures([
        { now: 1000, cgroupMemory: cgroup(GIB) },
        { now: 31_000, cgroupMemory: null },
        { now: 61_000, cgroupMemory: cgroup(3.5 * GIB) },
      ]),
    ).toEqual([]);
  });

  it("ranks a cgroup threshold ahead of a process RSS threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    emitDiagnosticMemorySample({
      now: 1000,
      emitSample: false,
      memoryUsage: { ...quietProcess, rss: 2000 },
      cgroupMemory: cgroup(6.5 * GIB),
      thresholds: { rssWarningBytes: 1000, rssCriticalBytes: 3000 },
    });
    stop();

    expect(events).toMatchObject([{ level: "critical", reason: "cgroup_memory_threshold" }]);
  });
});
