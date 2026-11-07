// Shared test harness for memory-core dreaming service tests.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
export type CronAddInput = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: { mode: "none" };
};
export type CronPatch = Partial<CronAddInput>;
export type CronJobLike = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string; message?: string; lightContext?: boolean };
  delivery?: { mode?: string };
  createdAtMs?: number;
};
export type CronParam = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJobLike[]>;
  add: (input: CronAddInput) => Promise<unknown>;
  update: (id: string, patch: CronPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};
type CronHarnessOptions = {
  listThrowsForFirstCalls?: number;
};
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
export type DreamingPluginApiTestDouble = DreamingPluginApi & {
  scheduler: ReturnType<typeof createTestPluginServiceScheduler>;
  logger: ReturnType<typeof createLogger>;
  on: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn<DreamingPluginApi["registerService"]>>;
};

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCronHarness(initialJobs: CronJobLike[] = [], opts?: CronHarnessOptions) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];
  const mutationCalls: string[] = [];

  const cron: CronParam = {
    async list() {
      listCalls += 1;
      if (opts?.listThrowsForFirstCalls && listCalls <= opts.listThrowsForFirstCalls) {
        throw new Error(`list failed on call ${listCalls}`);
      }
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
        ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
      }));
    },
    async add(input) {
      mutationCalls.push("add");
      addCalls.push(input);
      jobs.push({
        ...input,
        id: `job-${jobs.length + 1}`,
        schedule: { ...input.schedule },
        payload: { ...input.payload },
        ...(input.delivery ? { delivery: { ...input.delivery } } : {}),
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id, patch) {
      mutationCalls.push(`update:${id}`);
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return {};
      }
      const current = expectDefined(jobs[index], `managed cron job ${id}`);
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
        ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}),
      };
      return {};
    },
    async remove(id) {
      mutationCalls.push(`remove:${id}`);
      removeCalls.push(id);
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      return { removed: index >= 0 };
    },
  };

  return {
    cron,
    jobs,
    addCalls,
    updateCalls,
    removeCalls,
    mutationCalls,
    get listCalls() {
      return listCalls;
    },
  };
}

export function createDreamingConfig(
  dreaming: Record<string, unknown> = {
    enabled: true,
    frequency: "15 4 * * *",
    timezone: "UTC",
  },
  config: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      entries: {
        "memory-core": { config: { dreaming } },
      },
    },
  } as OpenClawConfig;
}

export function createDreamingTestContext(
  params: {
    config?: OpenClawConfig;
    runtime?: { config?: Pick<DreamingPluginApi["runtime"]["config"], "current"> };
    initialJobs?: CronJobLike[];
    cronOptions?: CronHarnessOptions;
  } = {},
) {
  const logger = createLogger();
  const harness = createCronHarness(params.initialJobs, params.cronOptions);
  const api: DreamingPluginApiTestDouble = {
    ...createTestPluginApi({
      config: params.config ?? createDreamingConfig(),
      pluginConfig: {},
      logger,
    }),
    logger,
    on: vi.fn<DreamingPluginApi["on"]>(),
    scheduler: createTestPluginServiceScheduler(),
    registerService: vi.fn<DreamingPluginApi["registerService"]>(),
  };
  Object.assign(api.runtime, { agent: createPluginRuntimeMock().agent }, params.runtime);
  return { api, harness, logger };
}
