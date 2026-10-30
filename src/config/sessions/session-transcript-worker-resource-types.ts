import type {
  UsageCostWorkerInput,
  UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { createSessionTranscriptHistoryPool } from "./session-transcript-read-pools.js";

export type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  nativeSequence: number;
  retiredSequence: number;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  rotation?: Promise<void>;
};

export type SessionCostWorkerLane = SessionDatabaseWorkerLane & {
  pool: WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>;
};
export type SessionHistoryWorkerLane = SessionDatabaseWorkerLane & {
  pool: ReturnType<typeof createSessionTranscriptHistoryPool>;
};
export type SessionDatabaseCleanup = { run: () => Promise<void> };
export type SessionHistoryDatabaseTarget = OpenClawAgentDatabaseOptions & {
  requestedPaths?: readonly string[];
};
export type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
  generation: number;
  pending: number;
  revoked: boolean;
  nativeSequences: Map<SessionDatabaseWorkerLane, number>;
  hostEffects: Set<Promise<unknown>>;
  cleanups: Set<SessionDatabaseCleanup>;
  aborters: Set<() => void>;
  closing?: Promise<void>;
  unregister: () => void;
  retainAlias: (alias: string) => void;
};
