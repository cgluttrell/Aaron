// Storage-neutral session registry maintenance for cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
import { withSessionRegistryEntriesInWorker } from "./session-entry-read-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { pruneStaleEntries } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

type SessionRegistryMaintenanceStoreSummary = {
  preservedRunning: number;
  pruned: number;
};

type SessionRegistryMaintenanceStoreOptions = SessionStoreTarget & {
  /** Whether to commit the selected removals to the backing store. */
  apply: boolean;
  /** Retention window for cron-run session entries. */
  retentionMs: number;
  /** Currently running cron job ids, normalized to lowercase. */
  runningCronJobIds: ReadonlySet<string>;
  assertCurrent?: () => void;
};

function parseCronRunSessionJobId(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  return /^cron:([^:]+):run:[^:]+(?:$|:)/u.exec(parsed.rest)?.[1];
}

function buildSessionRegistryPreserveKeys(params: {
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): { preserveKeys: Set<string>; preservedRunning: number } {
  const preserveKeys =
    collectActiveSessionWorkAdmissionKeys({
      storePath: params.storePath,
      store: params.store,
    }) ?? new Set<string>();
  let preservedRunning = 0;
  for (const key of Object.keys(params.store)) {
    const jobId = parseCronRunSessionJobId(key);
    if (jobId && params.runningCronJobIds.has(jobId)) {
      preserveKeys.add(key);
      preservedRunning += 1;
    }
  }
  return { preserveKeys, preservedRunning };
}

function pruneSessionRegistryStore(params: {
  children: readonly { sessionKey: string; entry: SessionEntry }[];
  retentionMs: number;
  removals?: SessionEntryLifecycleRemoval[];
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): SessionRegistryMaintenanceStoreSummary {
  const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
    runningCronJobIds: params.runningCronJobIds,
    storePath: params.storePath,
    store: params.store,
  });
  const candidates: { sessionKey: string; entry: SessionEntry }[] = [];
  pruneStaleEntries(params.store, params.retentionMs, {
    log: false,
    onPruned: ({ key, entry }) => candidates.push({ sessionKey: key, entry }),
    preserveKeys,
  });
  // Communication admission follows spawnedBy ancestry, including archived
  // intermediates; retain every ancestor of a live descendant in this store.
  const entries = [
    ...Object.entries(params.store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    ...candidates,
    ...params.children,
  ];
  const parents = new Map<string, string>();
  for (const { sessionKey, entry } of entries) {
    if (entry.spawnedBy) {
      parents.set(sessionKey, entry.spawnedBy);
    }
  }
  for (const { sessionKey, entry } of entries) {
    if (entry.archivedAt !== undefined) {
      continue;
    }
    const visited = new Set<string>([sessionKey]);
    for (let parent = parents.get(sessionKey); parent && !visited.has(parent);) {
      visited.add(parent);
      preserveKeys.add(parent);
      parent = parents.get(parent);
    }
  }
  let pruned = 0;
  for (const { sessionKey, entry } of candidates) {
    if (preserveKeys.has(sessionKey)) {
      params.store[sessionKey] = entry;
      continue;
    }
    pruned += 1;
    params.removals?.push({ sessionKey, expectedEntry: entry, archiveRemovedTranscript: true });
  }
  return {
    preservedRunning,
    pruned,
  };
}

/**
 * Runs session-registry maintenance for one resolved agent store.
 * Preview and apply select removals from one owned worker snapshot.
 * The lifecycle owner commits removals without running generic session maintenance.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  params.assertCurrent?.();
  const { agentId, storePath } = params;
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return {
      preservedRunning: 0,
      pruned: 0,
    };
  }
  let rowRevision = 0;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeScopeAffectsStoredRows(change) &&
      // This store's snapshot is the whole ancestry input; discovery publications are neutral.
      !isSessionStoreTopologyChange(change) &&
      ("all" in change ||
        change.factsInvalidated === true ||
        change.facts?.kind === "entry" ||
        change.facts?.kind === "replacement" ||
        change.facts?.kind === "removed")
    ) {
      rowRevision += 1;
    }
  });
  try {
    return await withSessionRegistryEntriesInWorker(
      { agentId, storePath },
      async (entries, assertReaderCurrent) => {
        const assertCurrent = () => {
          params.assertCurrent?.();
          assertReaderCurrent();
        };
        assertCurrent();
        // The retention reader adds spawned non-cron children for ancestry only; never prune them.
        const store = Object.fromEntries(
          entries
            .filter(({ sessionKey }) => parseCronRunSessionJobId(sessionKey) !== undefined)
            .map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        const children = entries.filter(
          ({ sessionKey }) => parseCronRunSessionJobId(sessionKey) === undefined,
        );
        const revision = rowRevision;
        const removals: SessionEntryLifecycleRemoval[] = [];
        const planned = pruneSessionRegistryStore({
          retentionMs: params.retentionMs,
          removals: params.apply ? removals : undefined,
          children,
          runningCronJobIds: params.runningCronJobIds,
          storePath,
          store,
        });
        if (removals.length > 0) {
          const mutation = await applySessionEntryLifecycleMutation({
            agentId,
            storePath,
            removals,
            skipMaintenance: true,
            commitGuard() {
              assertCurrent();
              // Child creation or restoration must still match the ancestry read.
              if (rowRevision !== revision) {
                throw new Error("Session ancestry changed before cron registry cleanup");
              }
            },
          });
          assertCurrent();
          return {
            preservedRunning: planned.preservedRunning,
            pruned: mutation.removedEntries,
          };
        }
        return planned;
      },
    );
  } finally {
    unsubscribe();
  }
}
