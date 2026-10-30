import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeCachedOpenClawAgentDatabase,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import { removeAgentIntegrityMetadataForTest } from "./openclaw-agent-db.test-support.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import * as verification from "./openclaw-database-verify.js";
import {
  clearOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import * as stateWorkerStore from "./openclaw-state-worker-store.js";

type IntegrityCounter = { path: string; checks: SharedArrayBuffer };
const counter = vi.hoisted(() => {
  const key = Symbol.for("openclaw.test.agentIntegrityCounter");
  const scope = globalThis as Record<PropertyKey, unknown>;
  return (scope[key] ??= {
    path: "",
    checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
  }) as IntegrityCounter;
});
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      const match = /^PRAGMA (integrity_check|foreign_key_check)(?:[(]'sqlite_schema'[)])?;?$/i.exec(sql.trim());
      if (this.location() === workerData.testIntegrityPath && match) {
        for (const method of ["all", "get", "iterate", "run"]) {
          const execute = statement[method].bind(statement);
          statement[method] = (...args) => {
            Atomics.add(new Int32Array(workerData.testIntegrityChecks),
              match[1].toLowerCase() === "integrity_check" ? 0 : 1, 1);
            return execute(...args);
          };
        }
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          testIntegrityPath: counter.path,
          testIntegrityChecks: counter.checks,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

// Direct native fixtures hold their generation until their explicit close.
const retainVerification = () => async () => {};

it.each(["confirmed close", "native exit"] as const)(
  "uses native close evidence before recovering an agent lease (%s)",
  async (outcome) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-native-close-") };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const leases = () =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(database.path);
    const hostLeases = leases();
    expect(hostLeases).toHaveLength(1);
    const context = captureOpenClawStateWorkerContext({ env });
    const assertCurrent = () => context.admission.assertCurrent();
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Native close fixture lost admission");
          }
        }, binding.attachment),
      }),
    };
    const generation = createAgentDatabaseNativeGeneration(
      database.agentId,
      database.path,
      context,
      assertCurrent,
      assertCurrent,
      undefined,
      () => {},
      retainVerification,
    );
    const workers: Worker[] = [];
    const observeWorker = (worker: Worker) => workers.push(worker);
    const cleanup = vi.spyOn(stateWorkerStore, "openOpenClawStateWorkerCleanupStore");
    process.on("worker", observeWorker);
    try {
      await expect(generation.run(source, async () => "opened")).resolves.toBe("opened");
      expect(leases()).toHaveLength(2);
      const validation = getOpenClawAgentDatabaseValidation(database);
      assert(validation, "native generation must publish validation before retirement");
      process.off("worker", observeWorker);
      if (outcome === "native exit") {
        expect(workers.length).toBeGreaterThan(0);
        await Promise.all(workers.map((worker) => worker.terminate()));
        expect(leases()).toHaveLength(2);
        expect(cleanup).not.toHaveBeenCalled();
        expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(0);
        expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      }
      await generation.close();
      expect(leases()).toEqual(hostLeases);
      expect(cleanup).toHaveBeenCalledTimes(outcome === "confirmed close" ? 0 : 1);
      if (outcome === "confirmed close") {
        expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
      }
    } finally {
      process.off("worker", observeWorker);
      try {
        await generation.close();
      } finally {
        cleanup.mockRestore();
      }
    }
  },
);

it("retires every borrower when native open refusal retains admission cleanup failure", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-open-cleanup-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const rejected = captureOpenClawAgentDatabaseExecution(options);
  const retained = captureOpenClawAgentDatabaseExecution(options);
  const refusal = new Error("Original caller revoked before native agent open");
  const cleanupError = new Error("Original caller cleanup failed after granting open");
  let sourceCurrent = true;
  let domainOpenRequests = 0;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {
      if (!sourceCurrent) {
        throw refusal;
      }
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage === "open") {
            domainOpenRequests += 1;
          }
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Cleanup refusal fixture lost its admission");
          }
          if (request.stage === "open" && domainOpenRequests === 1) {
            // The broker granted factory entry; the factory must still admit its native open.
            sourceCurrent = false;
            throw cleanupError;
          }
        }, binding.attachment),
      });
    },
  };
  try {
    const opening = rejected.runExisting(source, async () => "not admitted");
    await expect(opening).rejects.toBeInstanceOf(AggregateError);
    await expect(opening).rejects.toMatchObject({
      cause: refusal,
      errors: [refusal, { errors: [cleanupError] }],
    });
    // The broker refuses the factory open before re-entering the domain callback.
    expect(domainOpenRequests).toBe(1);
    sourceCurrent = true;
    expect(() => retained.assertCurrent()).toThrow("Agent database execution admission is closed");
    await expect(retained.runExisting(source, async () => "not admitted")).rejects.toThrow(
      "Agent database execution admission is closed",
    );
  } finally {
    sourceCurrent = true;
    const released = await Promise.allSettled([rejected.release(), retained.release()]);
    await closeOpenClawAgentDatabasesAsync();
    expect(released).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }
});

it("retires every borrower when native opening reports a protocol failure", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-open-protocol-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const rejected = captureOpenClawAgentDatabaseExecution(options);
  const retained = captureOpenClawAgentDatabaseExecution(options);
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: () => {},
    createAdmission(binding) {
      return () => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Protocol failure fixture lost admission");
          }
        }, binding.attachment);
        admission.port.postMessage(
          { kind: "native-settlement", settlement: { kind: "invalid" } },
          [],
        );
        admission.service();
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
  const operation = vi.fn(async () => "not admitted");
  try {
    await expect(rejected.runExisting(source, operation)).rejects.toThrow(
      "SQLite worker native settlement is invalid",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(() => retained.assertCurrent()).toThrow("Agent database execution admission is closed");
    await expect(retained.runExisting(source, operation)).rejects.toThrow(
      "Agent database execution admission is closed",
    );
    expect(operation).not.toHaveBeenCalled();
  } finally {
    const released = await Promise.allSettled([rejected.release(), retained.release()]);
    expect(released).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }
});

it.each(["settled", "pending"] as const)(
  "prepares missing storage after an existing-only miss (%s)",
  async (timing) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-prepare-missing-")) };
    const execution = captureOpenClawAgentDatabaseExecution({ agentId: "main", env });
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: () => execution.assertCurrent(),
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            execution.assertCurrent();
            if (!grant()) {
              throw new Error("Missing database fixture lost admission");
            }
          }, binding.attachment),
        });
      },
    };
    try {
      const missing = execution.runExisting(source, async () => "unexpected");
      if (timing === "settled") {
        expect(await missing).toBeUndefined();
      }
      const preparing = execution.prepare(source);
      expect(await missing).toBeUndefined();
      await preparing;
      expect(fs.existsSync(execution.path)).toBe(true);
      expect(await execution.runExisting(source, async () => "opened")).toBe("opened");
    } finally {
      await execution.release();
    }
  },
);

it("opens an unconfigured external store without reconstructing unknown deletion history", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-missing-history-") };
  const external = tempDirs.make("agent-worker-external-history-");
  const pathname = path.join(external, "retained.sqlite");
  const retained = openOpenClawAgentDatabase({
    agentId: "main",
    path: pathname,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-fixture-owner-") },
  });
  retained.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
  closeOpenClawAgentDatabaseByPath(pathname);
  const bytes = fs.readFileSync(pathname);
  const context = captureOpenClawStateWorkerContext({ env });
  const assertCurrent = () => context.admission.assertCurrent();
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        if (!grant()) {
          throw new Error("External store fixture lost its admission");
        }
      }, binding.attachment),
    }),
  };
  const generation = createAgentDatabaseNativeGeneration(
    "main",
    pathname,
    context,
    assertCurrent,
    assertCurrent,
    undefined,
    () => {},
    retainVerification,
  );
  const opening = await Promise.allSettled([generation.run(source, async () => "opened")]);
  const closing = await Promise.allSettled([generation.close()]);
  expect(opening).toEqual([{ status: "fulfilled", value: "opened" }]);
  expect(closing).toEqual([{ status: "fulfilled", value: undefined }]);
  expect(fs.readFileSync(pathname)).toEqual(bytes);
  expect(fs.readdirSync(external)).toEqual(["retained.sqlite"]);
  const shared = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  try {
    expect(
      shared.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get(),
    ).toBeUndefined();
  } finally {
    shared.close();
  }
});

it.each([
  "verified",
  "two-leases",
  "two-leases-missing-metadata",
  "two-leases-stale",
  "two-leases-unknown-owner",
  "two-leases-unclean",
  "prepared-existing",
  "invalidated",
  "failed",
  "revoked-before-grant",
  "revoked-after-verification-admission",
  "missing-metadata",
  "version-mismatch",
  "closed-host",
  "closed-host-blocked",
  "closed-host-blocked-last",
  "closed-host-revoked",
  "closed-host-replaced",
  "closed-host-no-receipt",
  "closed-host-no-receipt-verifier",
  "closed-host-no-receipt-rollback-verifier",
  "closed-host-no-receipt-stopped-verifier",
  "closed-host-no-receipt-retired-verifier",
  "closed-host-no-receipt-revoked-verifier",
] as const)("native execution borrows only current host integrity proof (%s)", async (proof) => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-native-integrity-")) };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
  counter.path = database.path;
  counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const context = captureOpenClawStateWorkerContext({ env });
  const closedHost = proof.startsWith("closed-host");
  const missingReceipt = proof.startsWith("closed-host-no-receipt");
  const siblingLease =
    (closedHost && !missingReceipt && proof !== "closed-host-blocked-last") ||
    proof.startsWith("two-leases")
      ? claimOpenClawAgentDatabaseLease({ agentId: database.agentId, path: database.path, env })
      : undefined;
  if (proof === "two-leases") {
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
  }
  if (proof === "two-leases-missing-metadata") {
    removeAgentIntegrityMetadataForTest(env);
  }
  if (proof === "two-leases-stale" || proof === "two-leases-unknown-owner") {
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_start_time = ? WHERE lease_id = ?")
      .run(proof === "two-leases-stale" ? -1 : null, siblingLease!);
  } else if (proof === "two-leases-unclean") {
    releaseOpenClawAgentDatabaseLease(siblingLease!, { env });
  }
  const claim: OpenClawAgentDatabaseClaim | undefined = closedHost
    ? undefined
    : createOpenClawAgentDatabaseClaim(database, retainAgentDatabase(database.db));
  if (proof === "closed-host-blocked" || proof === "closed-host-blocked-last") {
    database.db.exec("INSERT INTO auth_profile_state VALUES ('checkpoint', '{}', 1)");
    const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
    try {
      reader.exec("BEGIN");
      reader
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='checkpoint'")
        .get();
      database.db.exec("UPDATE auth_profile_state SET updated_at=2 WHERE state_key='checkpoint'");
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.walMaintenance.health?.state).toBe("blocked");
      expect(database.db.isOpen).toBe(false);
      expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
    } finally {
      reader.close();
    }
  } else if (closedHost) {
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (proof === "closed-host-no-receipt-revoked-verifier") {
    clearOpenClawAgentIntegrityVerification(database.path, env);
  } else if (missingReceipt) {
    clearOpenClawAgentDatabaseValidationCache(database.path);
    using store = openNodeSqliteDatabase(resolveQuarantineStorePath(env));
    store.prepare("DELETE FROM agent_integrity_verifications WHERE path=?").run(database.path);
    if (proof === "closed-host-no-receipt-rollback-verifier") {
      using writer = openNodeSqliteDatabase(database.path);
      writer.exec("PRAGMA journal_mode=DELETE");
    }
  }
  const verifier = proof.endsWith("verifier")
    ? verification.startOpenClawDatabaseIntegrityVerifier({ env })
    : undefined;
  if (proof === "closed-host-no-receipt-stopped-verifier") {
    await verifier!.stop();
  }
  const assertCurrent = () => {
    claim?.assertCurrent();
    context.admission.assertCurrent();
  };
  let revokedBeforeGrant = false;
  let revokedAfterVerificationAdmission = false;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (
            proof === "closed-host-no-receipt-retired-verifier" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-integrity-check"
          ) {
            void verifier!.stop();
          }
          if (
            proof === "revoked-before-grant" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "shared-owner"
          ) {
            // Revoke the already-sent proof while the native opener still awaits its grant.
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedBeforeGrant = true;
          }
          if (
            proof === "revoked-after-verification-admission" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-validation-start"
          ) {
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedAfterVerificationAdmission = true;
          }
          if (!grant()) {
            throw new Error("Native integrity fixture lost its retained admission");
          }
        }, binding.attachment),
      });
    },
  };
  const generation = createAgentDatabaseNativeGeneration(
    database.agentId,
    database.path,
    context,
    assertCurrent,
    assertCurrent,
    undefined,
    () => {},
    retainVerification,
  );
  if (
    proof === "invalidated" ||
    proof === "closed-host-revoked" ||
    proof === "revoked-after-verification-admission"
  ) {
    invalidateOpenClawAgentDatabaseValidation(database.path);
  } else if (proof === "closed-host-replaced") {
    fs.copyFileSync(database.path, `${database.path}.replacement`);
    fs.renameSync(`${database.path}.replacement`, database.path);
  } else if (proof === "failed") {
    recordOpenClawAgentDatabaseOpenFailure(database.path, new Error("Synthetic host failure"));
  } else if (proof === "missing-metadata") {
    clearOpenClawAgentIntegrityVerification(database.path, env);
  } else if (proof === "version-mismatch") {
    const store = openNodeSqliteDatabase(resolveQuarantineStorePath(env));
    try {
      store.exec("UPDATE agent_integrity_verifications SET app_version='previous-release'");
    } finally {
      store.close();
    }
  }
  const integrityCheck = vi.spyOn(verification, "requestOpenClawAgentDatabaseIntegrityCheck");
  try {
    if (proof === "closed-host-no-receipt-retired-verifier") {
      const operation = vi.fn(async () => "not admitted");
      await expect(generation.run(source, operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(Array.from(new Int32Array(counter.checks))).toEqual([0, 0]);
      return;
    }
    if (proof === "revoked-after-verification-admission") {
      const operation = vi.fn(async () => "not admitted");
      await expect(generation.run(source, operation)).rejects.toThrow(
        "Agent schema admission changed before publication",
      );
      expect(revokedAfterVerificationAdmission).toBe(true);
      expect(Array.from(new Int32Array(counter.checks))).toEqual([1, 1]);
      expect(operation).not.toHaveBeenCalled();
      return;
    }
    if (proof === "failed") {
      await expect(generation.run(source, async () => "opened")).rejects.toThrow(
        "OpenClaw agent database claim is no longer current",
      );
      expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      expect(Array.from(new Int32Array(counter.checks))).toEqual([0, 0]);
      return;
    }
    await expect(
      generation.run(source, async () => "opened", undefined, proof === "prepared-existing"),
    ).resolves.toBe("opened");
    if (proof === "closed-host-no-receipt-verifier") {
      expect(integrityCheck).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          path: database.path,
          check: "full",
        }),
      );
    } else {
      expect(integrityCheck).not.toHaveBeenCalled();
    }
    expect(Array.from(new Int32Array(counter.checks))).toEqual(
      proof === "verified" ||
        proof === "prepared-existing" ||
        proof === "closed-host" ||
        proof === "closed-host-blocked" ||
        proof === "closed-host-blocked-last" ||
        proof === "closed-host-no-receipt-verifier" ||
        proof === "two-leases" ||
        proof === "two-leases-missing-metadata" ||
        proof === "version-mismatch"
        ? [0, 0]
        : [1, 1],
    );
    expect(revokedBeforeGrant).toBe(proof === "revoked-before-grant");
  } finally {
    integrityCheck.mockRestore();
    await verifier?.stop();
    try {
      await generation.close();
    } finally {
      claim?.release();
      if (siblingLease) {
        releaseOpenClawAgentDatabaseLease(siblingLease, { env }, "read-only");
      }
    }
  }
  if (proof === "closed-host-blocked-last") {
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(1);
  }
});

await import("./openclaw-agent-execution.integrity-native.test-support.js");
