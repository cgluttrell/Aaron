import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { resolveStateDir } from "../config/state-dir.js";
import {
  captureDiagnosticProfile,
  type DiagnosticProfileOutcome,
  ProfileFailure,
} from "./diagnostic-profile.js";
import { readCgroupMemorySample } from "../process/dispatch-pressure-guard.js";
import { createSubsystemLogger } from "./subsystem.js";

const MAX_HEAP_BYTES = 6 * 1024 ** 3;
const HEADROOM_RESERVE_BYTES = 512 * 1024 ** 2;
const COOLDOWN_MS = 60_000;
const log = createSubsystemLogger("gateway").child("diagnostics/heap-snapshot");
let nextCaptureAt = 0;

type HeapSnapshotResult = {
  path: string;
  sizeBytes: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  elapsedMs: number;
};

type MemoryHeadroom = {
  hostAvailableBytes: number;
  cgroupWorkingSetBytes?: number;
  cgroupLimitBytes?: number;
};

function readMemoryHeadroom(): MemoryHeadroom {
  // MemAvailable accounts for reclaimable host cache; free memory alone does not.
  const available = (() => {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"));
      return match ? Number(match[1]) * 1024 : os.freemem();
    } catch {
      return os.freemem();
    }
  })();
  const cgroup = readCgroupMemorySample();
  return {
    hostAvailableBytes: available,
    cgroupWorkingSetBytes: cgroup?.workingSetBytes,
    cgroupLimitBytes: cgroup?.maxBytes,
  };
}

function hasSnapshotHeadroom(heapUsed: number, reading: MemoryHeadroom): boolean {
  // Node documents that constructing a snapshot can double the heap size (about
  // one heap of extra memory). Budget twice that increment plus a reserve for
  // concurrent Gateway work and estimation error.
  const required = 2 * heapUsed + HEADROOM_RESERVE_BYTES;
  const cgroupAvailable =
    reading.cgroupLimitBytes === undefined || reading.cgroupWorkingSetBytes === undefined
      ? Infinity
      : Math.max(0, reading.cgroupLimitBytes - reading.cgroupWorkingSetBytes);
  return required <= Math.min(reading.hostAvailableBytes, cgroupAvailable);
}

/** Owns opt-in main-isolate snapshots; native capture cannot be interrupted. */
export async function captureDiagnosticHeapSnapshot(options: {
  reason?: string;
  signal: AbortSignal;
  hasAuthority: () => boolean;
  /** Test seam for a memory reading; RPC callers always use the process reading. */
  readHeadroom?: () => MemoryHeadroom;
}): Promise<DiagnosticProfileOutcome<HeapSnapshotResult>> {
  let ownedPath: string | undefined;
  let elapsedMs = 0;
  let heapUsedAfter = 0;
  const outcome = await captureDiagnosticProfile({
    ...options,
    durationMs: 0,
    setup: async (session) => {
      if (performance.now() < nextCaptureAt) {
        throw new ProfileFailure("cooldown");
      }
      const heapUsed = process.memoryUsage().heapUsed;
      if (heapUsed > MAX_HEAP_BYTES) {
        throw new ProfileFailure("heap-too-large");
      }
      if (!hasSnapshotHeadroom(heapUsed, (options.readHeadroom ?? readMemoryHeadroom)())) {
        throw new ProfileFailure("insufficient-headroom");
      }
      const directory = path.join(resolveStateDir(), "diagnostics");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (options.signal.aborted || !options.hasAuthority()) {
        throw new ProfileFailure("cancelled");
      }
      const filename = path.join(
        directory,
        `heap-${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`,
      );
      // Reserve privately before native capture opens the file, including with a permissive umask.
      const file = await fs.open(filename, "wx", 0o600);
      ownedPath = filename;
      await file.close();
      await session.post("HeapProfiler.enable");
    },
    start: async () => {
      const heapUsedBefore = process.memoryUsage().heapUsed;
      if (heapUsedBefore > MAX_HEAP_BYTES) {
        throw new ProfileFailure("heap-too-large");
      }
      if (!hasSnapshotHeadroom(heapUsedBefore, (options.readHeadroom ?? readMemoryHeadroom)())) {
        throw new ProfileFailure("insufficient-headroom");
      }
      log.warn("Writing heap snapshot: the main thread will block until capture finishes", {
        heapUsedBefore,
        reason: options.reason,
      });
      const startedAt = performance.now();
      try {
        writeHeapSnapshot(ownedPath!);
      } finally {
        // Starts after native work, so requests queued during a long stall cannot recapture.
        nextCaptureAt = performance.now() + COOLDOWN_MS;
      }
      elapsedMs = performance.now() - startedAt;
      // Metadata I/O can yield to fresh allocations; preserve the post-GC reading now.
      heapUsedAfter = process.memoryUsage().heapUsed;
    },
    stop: async () => ({
      profile: { path: ownedPath!, sizeBytes: (await fs.stat(ownedPath!)).size },
    }),
    // The snapshot file and the runtime's retained snapshot metadata have separate lifetimes.
    disable: (session) => session.post("HeapProfiler.disable"),
    sanitize: (profile, _packageRoot, measurement) => ({
      ...profile,
      heapUsedBefore: measurement.before.heapUsed,
      heapUsedAfter,
      elapsedMs,
    }),
  });
  if (outcome.status === "unavailable" && ownedPath) {
    const removalFailed = await fs.unlink(ownedPath).then(
      () => false,
      () => true,
    );
    outcome.cleanupFailed ||= removalFailed;
  }
  return outcome;
}
