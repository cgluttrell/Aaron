import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { resolveStateDir } from "../config/state-dir.js";
import { readCgroupMemorySample } from "../process/dispatch-pressure-guard.js";
import type { DiagnosticProfileOutcome } from "./diagnostic-profile.js";
import { createSubsystemLogger } from "./subsystem.js";

const MAX_HEAP_BYTES = 6 * 1024 ** 3;
const HEADROOM_RESERVE_BYTES = 512 * 1024 ** 2;
const COOLDOWN_MS = 60_000;
const log = createSubsystemLogger("gateway").child("diagnostics/heap-snapshot");
let capturing = false;
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
  const unavailable = (
    reason:
      | "busy"
      | "cooldown"
      | "heap-too-large"
      | "insufficient-headroom"
      | "cancelled"
      | "unsupported",
  ) => ({ status: "unavailable", reason, cleanupFailed: false }) as const;
  const active = () => !options.signal.aborted && options.hasAuthority();
  if (!active()) {
    return unavailable("cancelled");
  }
  if (process.versions.bun) {
    return unavailable("unsupported");
  }
  if (capturing) {
    return unavailable("busy");
  }
  if (performance.now() < nextCaptureAt) {
    return unavailable("cooldown");
  }
  const heapUsed = process.memoryUsage().heapUsed;
  if (heapUsed > MAX_HEAP_BYTES) {
    return unavailable("heap-too-large");
  }
  if (!hasSnapshotHeadroom(heapUsed, (options.readHeadroom ?? readMemoryHeadroom)())) {
    return unavailable("insufficient-headroom");
  }
  capturing = true;
  let ownedPath: string | undefined;
  try {
    const directory = path.join(resolveStateDir(), "diagnostics");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!active()) {
      return unavailable("cancelled");
    }
    const filename = path.join(
      directory,
      `heap-${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`,
    );
    // Reserve privately before V8 opens the file, including with a permissive umask.
    const file = await fs.open(filename, "wx", 0o600);
    ownedPath = filename;
    await file.close();
    const heapUsedBefore = process.memoryUsage().heapUsed;
    if (!active() || heapUsedBefore > MAX_HEAP_BYTES) {
      await fs.unlink(filename);
      ownedPath = undefined;
      return unavailable(active() ? "heap-too-large" : "cancelled");
    }
    if (!hasSnapshotHeadroom(heapUsedBefore, (options.readHeadroom ?? readMemoryHeadroom)())) {
      await fs.unlink(filename);
      ownedPath = undefined;
      return unavailable("insufficient-headroom");
    }
    log.warn("Writing heap snapshot: the main thread will block until V8 finishes", {
      heapUsedBefore,
      reason: options.reason,
    });
    const startedAt = performance.now();
    try {
      writeHeapSnapshot(filename);
    } finally {
      // Starts after native work, so requests queued during a long stall cannot recapture.
      nextCaptureAt = performance.now() + COOLDOWN_MS;
    }
    const elapsedMs = performance.now() - startedAt;
    const heapUsedAfter = process.memoryUsage().heapUsed;
    const { size: sizeBytes } = await fs.stat(filename);
    return {
      status: "complete",
      result: { path: filename, sizeBytes, heapUsedBefore, heapUsedAfter, elapsedMs },
    };
  } catch {
    const cleanupFailed = ownedPath
      ? await fs.unlink(ownedPath).then(
          () => false,
          () => true,
        )
      : false;
    return { status: "unavailable", reason: "capture-failed", cleanupFailed };
  } finally {
    capturing = false;
  }
}
