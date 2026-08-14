/** Cgroup-backed guard for starting expensive isolated gateway work. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

const MB = 1024 * 1024;
const DEFAULT_MEMORY_USAGE_RATIO_LIMIT = 0.85;
const DEFAULT_UNBOUNDED_WORKING_SET_BYTES_LIMIT = 6 * 1024 * MB;
const DEFAULT_MEMORY_GROWTH_RATIO_LIMIT = 0.08;
const DEFAULT_MEMORY_GROWTH_BYTES_LIMIT = 512 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 5 * 60_000;

export type DispatchPressureOverride = {
  approvedBy: "Chris";
  reason: string;
};

export type DispatchPressureGuardInput = {
  workKind: "gateway_agent" | "cron_isolated_agent";
  workId: string;
  override?: DispatchPressureOverride;
};

export type DispatchPressureDecision =
  | {
      status: "allow";
      reason: "below_threshold" | "cgroup_unavailable";
      sample?: DispatchPressureSample;
    }
  | {
      status: "override";
      reason: "chris_approved_urgent";
      sample?: DispatchPressureSample;
      override: DispatchPressureOverride;
    }
  | {
      status: "defer";
      reason:
        | "cgroup_memory_threshold"
        | "cgroup_memory_absolute_threshold"
        | "cgroup_memory_growth";
      sample: DispatchPressureSample;
      threshold: DispatchPressureThreshold;
    };

export type DispatchPressureSample = {
  cgroupDir: string;
  currentBytes: number;
  inactiveFileBytes: number;
  workingSetBytes: number;
  maxBytes?: number;
  usageRatio?: number;
  previousWorkingSetBytes?: number;
  growthBytes?: number;
  windowMs?: number;
};

export type DispatchPressureThreshold = {
  currentBytes?: number;
  workingSetBytes?: number;
  usageRatio?: number;
  growthBytes?: number;
  growthRatio?: number;
  windowMs?: number;
};

type DispatchPressureGuardOptions = {
  nowMs?: () => number;
  readTextFile?: (file: string) => string;
  cgroupDir?: string;
  memoryUsageRatioLimit?: number;
  unboundedWorkingSetBytesLimit?: number;
  memoryGrowthRatioLimit?: number;
  memoryGrowthBytesLimit?: number;
  growthWindowMs?: number;
};

type PreviousSample = {
  ts: number;
  workingSetBytes: number;
  maxBytes?: number;
};

let previousSample: PreviousSample | undefined;

function readTextFile(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function parseCgroupMemoryValue(raw: string): number | "max" | undefined {
  const trimmed = raw.trim();
  if (trimmed === "max") {
    return "max";
  }
  return parseStrictNonNegativeInteger(trimmed);
}

function parseMemoryStatValue(raw: string, key: string): number {
  for (const line of raw.split(/\r?\n/u)) {
    const [candidateKey, candidateValue] = line.trim().split(/\s+/u);
    if (candidateKey === key) {
      return parseStrictNonNegativeInteger(candidateValue ?? "") ?? 0;
    }
  }
  return 0;
}

function resolveCgroupV2Dir(options: DispatchPressureGuardOptions): string | undefined {
  if (options.cgroupDir) {
    return options.cgroupDir;
  }
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const read = options.readTextFile ?? readTextFile;
    const line = read("/proc/self/cgroup")
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

function readCgroupMemorySample(
  options: DispatchPressureGuardOptions,
): DispatchPressureSample | undefined {
  const cgroupDir = resolveCgroupV2Dir(options);
  if (!cgroupDir) {
    return undefined;
  }
  try {
    const read = options.readTextFile ?? readTextFile;
    const current = parseCgroupMemoryValue(read(path.join(cgroupDir, "memory.current")));
    const max = parseCgroupMemoryValue(read(path.join(cgroupDir, "memory.max")));
    if (typeof current !== "number") {
      return undefined;
    }
    const inactiveFileBytes = parseMemoryStatValue(
      read(path.join(cgroupDir, "memory.stat")),
      "inactive_file",
    );
    const workingSetBytes = Math.max(0, current - inactiveFileBytes);
    if (max === "max" || typeof max !== "number" || max <= 0) {
      return {
        cgroupDir,
        currentBytes: current,
        inactiveFileBytes,
        workingSetBytes,
      };
    }
    return {
      cgroupDir,
      currentBytes: current,
      inactiveFileBytes,
      workingSetBytes,
      maxBytes: max,
      usageRatio: workingSetBytes / max,
    };
  } catch {
    return undefined;
  }
}

function withGrowth(
  sample: DispatchPressureSample,
  now: number,
  growthWindowMs: number,
): DispatchPressureSample {
  const previous = previousSample;
  previousSample = { ts: now, workingSetBytes: sample.workingSetBytes, maxBytes: sample.maxBytes };
  if (!previous || previous.maxBytes !== sample.maxBytes) {
    return sample;
  }
  const windowMs = now - previous.ts;
  if (windowMs <= 0 || windowMs > growthWindowMs) {
    return sample;
  }
  const growthBytes = sample.workingSetBytes - previous.workingSetBytes;
  return growthBytes > 0
    ? {
        ...sample,
        previousWorkingSetBytes: previous.workingSetBytes,
        growthBytes,
        windowMs,
      }
    : sample;
}

export function decideDispatchPressure(
  input: DispatchPressureGuardInput,
  options: DispatchPressureGuardOptions = {},
): DispatchPressureDecision {
  const rawSample = readCgroupMemorySample(options);
  if (rawSample === undefined) {
    return input.override
      ? { status: "override", reason: "chris_approved_urgent", override: input.override }
      : { status: "allow", reason: "cgroup_unavailable" };
  }

  const growthWindowMs = options.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS;
  const sample = withGrowth(rawSample, options.nowMs?.() ?? Date.now(), growthWindowMs);
  const usageRatioLimit = options.memoryUsageRatioLimit ?? DEFAULT_MEMORY_USAGE_RATIO_LIMIT;
  const growthRatioLimit = options.memoryGrowthRatioLimit ?? DEFAULT_MEMORY_GROWTH_RATIO_LIMIT;
  const unboundedWorkingSetBytesLimit =
    options.unboundedWorkingSetBytesLimit ?? DEFAULT_UNBOUNDED_WORKING_SET_BYTES_LIMIT;
  const growthBytesLimit =
    sample.maxBytes !== undefined
      ? Math.min(
          options.memoryGrowthBytesLimit ?? DEFAULT_MEMORY_GROWTH_BYTES_LIMIT,
          sample.maxBytes * growthRatioLimit,
        )
      : (options.memoryGrowthBytesLimit ?? DEFAULT_MEMORY_GROWTH_BYTES_LIMIT);
  const thresholdDecision =
    sample.maxBytes !== undefined &&
    sample.usageRatio !== undefined &&
    sample.usageRatio >= usageRatioLimit
      ? {
          status: "defer" as const,
          reason: "cgroup_memory_threshold" as const,
          sample,
          threshold: {
            workingSetBytes: Math.floor(sample.maxBytes * usageRatioLimit),
            usageRatio: usageRatioLimit,
          },
        }
      : sample.maxBytes === undefined && sample.workingSetBytes >= unboundedWorkingSetBytesLimit
        ? {
            status: "defer" as const,
            reason: "cgroup_memory_absolute_threshold" as const,
            sample,
            threshold: {
              workingSetBytes: unboundedWorkingSetBytesLimit,
            },
          }
        : sample.growthBytes !== undefined && sample.growthBytes >= growthBytesLimit
          ? {
              status: "defer" as const,
              reason: "cgroup_memory_growth" as const,
              sample,
              threshold: {
                growthBytes: growthBytesLimit,
                growthRatio: growthRatioLimit,
                windowMs: growthWindowMs,
              },
            }
          : undefined;

  if (input.override) {
    return {
      status: "override",
      reason: "chris_approved_urgent",
      sample,
      override: input.override,
    };
  }
  return thresholdDecision ?? { status: "allow", reason: "below_threshold", sample };
}

export function resetDispatchPressureGuardForTest(): void {
  previousSample = undefined;
}
