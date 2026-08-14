// Diagnostic memory helpers capture process and service-cgroup memory facts for support diagnostics.
import fs from "node:fs";
import path from "node:path";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { writeDiagnosticMemoryPressureBundleSync } from "./diagnostic-stability-bundle.js";
import { createSubsystemLogger } from "./subsystem.js";

// Diagnostic memory sampler with threshold/growth pressure detection and repeat suppression.
const MB = 1024 * 1024;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_CGROUP_MEMORY_WARNING_BYTES = 4096 * MB;
const DEFAULT_CGROUP_MEMORY_CRITICAL_BYTES = 6144 * MB;
const DEFAULT_CGROUP_MEMORY_GROWTH_WARNING_BYTES = 1024 * MB;
const DEFAULT_CGROUP_MEMORY_GROWTH_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

const log = createSubsystemLogger("gateway").child("diagnostics/memory");

type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  cgroupMemoryWarningBytes?: number;
  cgroupMemoryCriticalBytes?: number;
  cgroupMemoryGrowthWarningBytes?: number;
  cgroupMemoryGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};

type DiagnosticCgroupMemoryUsage = {
  currentBytes: number;
  maxBytes?: number | "max";
};

type DiagnosticMemorySample = {
  ts: number;
  memory: DiagnosticMemoryUsage;
  cgroupMemory?: DiagnosticCgroupMemoryUsage;
};

type DiagnosticMemoryState = {
  lastSample: DiagnosticMemorySample | null;
  lastPressureAtByKey: Map<string, number>;
};

const state: DiagnosticMemoryState = {
  lastSample: null,
  lastPressureAtByKey: new Map(),
};

// Convert Node's runtime shape into the diagnostic event contract.
function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): DiagnosticMemoryUsage {
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function resolveThresholds(
  thresholds?: DiagnosticMemoryThresholds,
): Required<DiagnosticMemoryThresholds> {
  return {
    rssWarningBytes: thresholds?.rssWarningBytes ?? DEFAULT_RSS_WARNING_BYTES,
    rssCriticalBytes: thresholds?.rssCriticalBytes ?? DEFAULT_RSS_CRITICAL_BYTES,
    heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? DEFAULT_HEAP_WARNING_BYTES,
    heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? DEFAULT_HEAP_CRITICAL_BYTES,
    rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
    rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
    cgroupMemoryWarningBytes:
      thresholds?.cgroupMemoryWarningBytes ?? DEFAULT_CGROUP_MEMORY_WARNING_BYTES,
    cgroupMemoryCriticalBytes:
      thresholds?.cgroupMemoryCriticalBytes ?? DEFAULT_CGROUP_MEMORY_CRITICAL_BYTES,
    cgroupMemoryGrowthWarningBytes:
      thresholds?.cgroupMemoryGrowthWarningBytes ?? DEFAULT_CGROUP_MEMORY_GROWTH_WARNING_BYTES,
    cgroupMemoryGrowthCriticalBytes:
      thresholds?.cgroupMemoryGrowthCriticalBytes ?? DEFAULT_CGROUP_MEMORY_GROWTH_CRITICAL_BYTES,
    growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
    pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
  };
}

function pickThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, thresholds } = params;
  if (memory.rssBytes >= thresholds.rssCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssCriticalBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) {
    return {
      level: "critical",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedCriticalBytes,
    };
  }
  if (memory.rssBytes >= thresholds.rssWarningBytes) {
    return {
      level: "warning",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssWarningBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) {
    return {
      level: "warning",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedWarningBytes,
    };
  }
  return null;
}

function pickCgroupThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  cgroupMemory: DiagnosticCgroupMemoryUsage | undefined;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, cgroupMemory, thresholds } = params;
  if (!cgroupMemory) {
    return null;
  }
  if (cgroupMemory.currentBytes >= thresholds.cgroupMemoryCriticalBytes) {
    return {
      level: "critical",
      reason: "cgroup_memory_threshold",
      memory,
      thresholdBytes: thresholds.cgroupMemoryCriticalBytes,
      cgroupMemoryBytes: cgroupMemory.currentBytes,
      cgroupMemoryMaxBytes: cgroupMemory.maxBytes,
    };
  }
  if (cgroupMemory.currentBytes >= thresholds.cgroupMemoryWarningBytes) {
    return {
      level: "warning",
      reason: "cgroup_memory_threshold",
      memory,
      thresholdBytes: thresholds.cgroupMemoryWarningBytes,
      cgroupMemoryBytes: cgroupMemory.currentBytes,
      cgroupMemoryMaxBytes: cgroupMemory.maxBytes,
    };
  }
  return null;
}

function pickGrowthPressure(params: {
  previous: DiagnosticMemorySample | null;
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { previous, current, thresholds } = params;
  if (!previous) {
    return null;
  }
  const windowMs = current.ts - previous.ts;
  if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
    return null;
  }
  const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
  if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthCriticalBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) {
    return {
      level: "warning",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthWarningBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  return null;
}

function pickCgroupGrowthPressure(params: {
  previous: DiagnosticMemorySample | null;
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { previous, current, thresholds } = params;
  if (!previous?.cgroupMemory || !current.cgroupMemory) {
    return null;
  }
  const windowMs = current.ts - previous.ts;
  if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
    return null;
  }
  const cgroupMemoryGrowthBytes =
    current.cgroupMemory.currentBytes - previous.cgroupMemory.currentBytes;
  if (cgroupMemoryGrowthBytes >= thresholds.cgroupMemoryGrowthCriticalBytes) {
    return {
      level: "critical",
      reason: "cgroup_memory_growth",
      memory: current.memory,
      thresholdBytes: thresholds.cgroupMemoryGrowthCriticalBytes,
      cgroupMemoryBytes: current.cgroupMemory.currentBytes,
      cgroupMemoryGrowthBytes,
      cgroupMemoryMaxBytes: current.cgroupMemory.maxBytes,
      windowMs,
    };
  }
  if (cgroupMemoryGrowthBytes >= thresholds.cgroupMemoryGrowthWarningBytes) {
    return {
      level: "warning",
      reason: "cgroup_memory_growth",
      memory: current.memory,
      thresholdBytes: thresholds.cgroupMemoryGrowthWarningBytes,
      cgroupMemoryBytes: current.cgroupMemory.currentBytes,
      cgroupMemoryGrowthBytes,
      cgroupMemoryMaxBytes: current.cgroupMemory.maxBytes,
      windowMs,
    };
  }
  return null;
}

function shouldEmitPressure(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
  now: number,
  repeatMs: number,
): boolean {
  const key = `${pressure.level}:${pressure.reason}`;
  const lastAt = state.lastPressureAtByKey.get(key);
  // Pressure events can repeat during sustained memory spikes; throttle per level/reason pair.
  if (lastAt !== undefined && now - lastAt < repeatMs) {
    return false;
  }
  state.lastPressureAtByKey.set(key, now);
  return true;
}

function formatOptionalPressureMetric(label: string, value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? ` ${label}=${value}` : "";
}

function formatScaledNumber(value: number): string {
  const fixed = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/u, "").replace(/(\.\d*[1-9])0$/u, "$1");
}

function formatReadableBytes(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex++;
  }
  return unitIndex === 0
    ? `${Math.round(scaled)} ${BYTE_UNITS[unitIndex]}`
    : `${formatScaledNumber(scaled)} ${BYTE_UNITS[unitIndex]}`;
}

function formatPressureRatio(params: {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">;
  thresholdBytes: number;
}): string | undefined {
  const { pressure, thresholdBytes } = params;
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) {
    return undefined;
  }
  const value = (() => {
    switch (pressure.reason) {
      case "heap_threshold":
        return pressure.memory.heapUsedBytes;
      case "rss_growth":
        return pressure.rssGrowthBytes;
      case "cgroup_memory_threshold":
        return pressure.cgroupMemoryBytes;
      case "cgroup_memory_growth":
        return pressure.cgroupMemoryGrowthBytes;
      case "rss_threshold":
        return pressure.memory.rssBytes;
    }
    // Unreached for current reason codes; keeps the IIFE explicitly total so a
    // future reason cannot silently fall through as undefined.
    return undefined;
  })();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const ratio = (value / thresholdBytes) * 100;
  return `${formatScaledNumber(ratio)}%`;
}

function formatPressureSummary(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
): string {
  const parts = [
    `rss=${formatReadableBytes(pressure.memory.rssBytes)}`,
    `heap=${formatReadableBytes(pressure.memory.heapUsedBytes)}`,
    pressure.cgroupMemoryBytes !== undefined
      ? `cgroup=${formatReadableBytes(pressure.cgroupMemoryBytes)}`
      : "",
    pressure.cgroupMemoryMaxBytes !== undefined
      ? `cgroupMax=${
          pressure.cgroupMemoryMaxBytes === "max"
            ? "max"
            : formatReadableBytes(pressure.cgroupMemoryMaxBytes)
        }`
      : "",
    pressure.thresholdBytes !== undefined
      ? `threshold=${formatReadableBytes(pressure.thresholdBytes)}`
      : "",
    pressure.thresholdBytes !== undefined
      ? `thresholdRatio=${formatPressureRatio({
          pressure,
          thresholdBytes: pressure.thresholdBytes,
        })}`
      : "",
    pressure.rssGrowthBytes !== undefined
      ? `rssGrowth=${formatReadableBytes(pressure.rssGrowthBytes)}`
      : "",
    pressure.cgroupMemoryGrowthBytes !== undefined
      ? `cgroupGrowth=${formatReadableBytes(pressure.cgroupMemoryGrowthBytes)}`
      : "",
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function formatPressureNextStep(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
): string {
  return pressure.level === "critical"
    ? "nextStep=inspect latest stability bundle or run openclaw gateway diagnostics export; restart gateway if process is unstable"
    : "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists";
}

function logMemoryPressure(params: {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">;
  writeCriticalBundle: boolean;
}): void {
  const { pressure } = params;
  const message =
    `memory pressure: level=${pressure.level} reason=${pressure.reason}` +
    ` ${formatPressureSummary(pressure)}` +
    ` rssBytes=${pressure.memory.rssBytes}` +
    ` heapUsedBytes=${pressure.memory.heapUsedBytes}` +
    formatOptionalPressureMetric("thresholdBytes", pressure.thresholdBytes) +
    formatOptionalPressureMetric("rssGrowthBytes", pressure.rssGrowthBytes) +
    formatOptionalPressureMetric("cgroupMemoryBytes", pressure.cgroupMemoryBytes) +
    formatOptionalPressureMetric("cgroupMemoryGrowthBytes", pressure.cgroupMemoryGrowthBytes) +
    formatOptionalPressureMetric("windowMs", pressure.windowMs) +
    (pressure.level === "critical"
      ? ` memoryPressureSnapshot=${params.writeCriticalBundle ? "enabled" : "disabled"}`
      : "") +
    ` ${formatPressureNextStep(pressure)}`;
  log.warn(message);
}

function parseStrictNonNegativeInteger(raw: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readCgroupMemoryValue(file: string): number | "max" | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw === "max" ? "max" : parseStrictNonNegativeInteger(raw);
  } catch {
    return undefined;
  }
}

function resolveCgroupV2MemoryDir(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const line = fs
      .readFileSync("/proc/self/cgroup", "utf8")
      .split(/\r?\n/u)
      .find((entry) => entry.startsWith("0::"));
    if (!line) {
      return undefined;
    }
    return path.join("/sys/fs/cgroup", line.slice("0::".length).trim().replace(/^\/+/u, ""));
  } catch {
    return undefined;
  }
}

function collectCgroupMemoryUsage(): DiagnosticCgroupMemoryUsage | undefined {
  const dir = resolveCgroupV2MemoryDir();
  if (!dir) {
    return undefined;
  }
  const current = readCgroupMemoryValue(path.join(dir, "memory.current"));
  if (typeof current !== "number") {
    return undefined;
  }
  const max = readCgroupMemoryValue(path.join(dir, "memory.max"));
  return {
    currentBytes: current,
    ...(max !== undefined ? { maxBytes: max } : {}),
  };
}

export function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  cgroupMemoryUsage?: DiagnosticCgroupMemoryUsage;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
  writeCriticalBundle?: boolean;
  stateDir?: string;
  sessionStorePaths?: string[];
  resolveSessionStorePaths?: () => string[] | undefined;
}): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
  const cgroupMemory =
    options?.cgroupMemoryUsage ?? (options?.memoryUsage ? undefined : collectCgroupMemoryUsage());
  const current = { ts: now, memory, cgroupMemory };
  const thresholds = resolveThresholds(options?.thresholds);
  const shouldEmitSample = options?.emitSample !== false;

  if (shouldEmitSample) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory,
      uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
    });
  }

  const pressure =
    pickCgroupThresholdPressure({ memory, cgroupMemory, thresholds }) ??
    pickThresholdPressure({ memory, thresholds }) ??
    pickCgroupGrowthPressure({ previous: state.lastSample, current, thresholds }) ??
    pickGrowthPressure({ previous: state.lastSample, current, thresholds });
  state.lastSample = current;
  if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    const writeCriticalBundle = options?.writeCriticalBundle === true;
    logMemoryPressure({ pressure, writeCriticalBundle });
    if (pressure.level === "critical" && writeCriticalBundle) {
      // Critical snapshots are opt-in because bundle writes can add IO during memory pressure.
      const sessionStorePaths = options?.sessionStorePaths ?? options?.resolveSessionStorePaths?.();
      const result = writeDiagnosticMemoryPressureBundleSync({
        pressure,
        stateDir: options?.stateDir,
        sessionStorePaths,
        now: new Date(now),
      });
      if (result.status === "written") {
        log.warn(
          `critical memory pressure bundle written: path=${result.path} reason=${pressure.reason} level=${pressure.level}`,
        );
      } else if (result.status === "failed") {
        log.warn(`critical memory pressure bundle failed: ${String(result.error)}`);
      }
    } else if (pressure.level === "critical") {
      log.warn(
        "critical memory pressure snapshot disabled: diagnostics.memoryPressureSnapshot=false",
      );
    }
  }
  return memory;
}

/** Clears process-local memory diagnostic state for isolated tests. */
export function resetDiagnosticMemoryForTest(): void {
  state.lastSample = null;
  state.lastPressureAtByKey.clear();
}
