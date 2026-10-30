import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { clearOpenClawAgentDatabaseValidationCache } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPathAsync,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import * as verificationImplementation from "./openclaw-database-verify.impl.js";
import * as verification from "./openclaw-database-verify.js";
import { readOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

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

function createNativeSource(assertCurrent: () => void): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        if (!grant()) {
          throw new Error("Native integrity fixture lost its retained admission");
        }
      }, binding.attachment),
    }),
  };
}

it.runIf(process.platform === "linux")(
  "classifies dead-owner admission using native WAL capabilities and provenance",
  async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-process-death-") };
    const cases = [
      "same-boot",
      "checkpointed-wal",
      "background-foreign-write",
      "background-revoked",
      "background-closed",
      "background-idle-swap",
      "background-idle-timeout",
      "background-replaced",
      "background-preparing",
      "background-preparation-failed",
      "foreign-boot",
      "legacy-lease",
      "pid-reused",
      "dirty-receipt",
      "corrupt-page",
      "interrupted-admission",
    ];
    const child = fork(
      fileURLToPath(new URL("./openclaw-agent-db-crash.test-support.ts", import.meta.url)),
      cases,
      { execArgv: ["--import", "tsx"], env: { ...process.env, ...env }, silent: true },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    type Fixture = { agentId: string; path: string; corruptionOffset: number };
    let fixtures: Fixture[];
    try {
      fixtures = await new Promise<Fixture[]>((resolve, reject) => {
        const failed = () => reject(new Error(`Crash fixture exited before opening: ${stderr}`));
        child.once("error", reject);
        child.once("exit", failed);
        child.once("message", (message) => {
          child.off("exit", failed);
          resolve(message as Fixture[]);
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    expect(child.signalCode).toBe("SIGKILL");
    expect(fixtures.map((fixture) => fixture.agentId)).toEqual(cases);
    const shared = openOpenClawStateDatabase({ env });
    for (const fixture of fixtures) {
      const { agentId, path: pathname } = fixture;
      const deferred =
        agentId === "same-boot" ||
        agentId === "checkpointed-wal" ||
        agentId.startsWith("background-");
      const idle = agentId.startsWith("background-idle-");
      const pending = agentId.startsWith("background-prepar");
      const durable =
        agentId === "same-boot" ||
        agentId === "checkpointed-wal" ||
        agentId === "background-preparing" ||
        idle;
      const held = shared.db
        .prepare(
          "SELECT lease_id, provenance, owner_pid, owner_start_time FROM agent_database_leases WHERE path=?",
        )
        .get(pathname);
      expect(held).toMatchObject({
        lease_id: expect.stringMatching(/^[a-f0-9-]+$/u),
        provenance: expect.stringMatching(/^process-v1:[a-f0-9]{64}$/u),
        owner_pid: child.pid,
        owner_start_time: expect.any(Number),
      });
      if (agentId === "interrupted-admission") {
        expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();
      } else {
        expect(readOpenClawAgentIntegrityVerification(pathname, env)?.clean_close).toBe(0);
      }
      if (agentId === "checkpointed-wal") {
        expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
      } else {
        expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(32);
      }
      if (agentId === "foreign-boot" || agentId === "corrupt-page") {
        shared.db
          .prepare("UPDATE agent_database_leases SET provenance=? WHERE path=?")
          .run(`process-v1:${"0".repeat(64)}`, pathname);
      } else if (agentId === "legacy-lease") {
        shared.db
          .prepare("UPDATE agent_database_leases SET provenance=NULL WHERE path=?")
          .run(pathname);
      } else if (agentId === "pid-reused") {
        shared.db
          .prepare("UPDATE agent_database_leases SET owner_pid=?, owner_start_time=-1 WHERE path=?")
          .run(process.pid, pathname);
      } else if (agentId === "dirty-receipt") {
        shared.db.prepare("DELETE FROM agent_database_leases WHERE path=?").run(pathname);
      }
      if (agentId === "corrupt-page") {
        const file = fs.openSync(pathname, "r+");
        try {
          // This checkpointed table has no newer WAL image to hide the invalid btree page.
          fs.writeSync(file, Buffer.from([0]), 0, 1, fixture.corruptionOffset);
        } finally {
          fs.closeSync(file);
        }
      }

      counter.path = pathname;
      counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const context = captureOpenClawStateWorkerContext({ env });
      let current = true;
      const assertCurrent = () => {
        context.admission.assertCurrent();
        assertAgentDatabaseAdmitted(agentId, { env });
        if (!current) {
          throw new Error("Crash fixture admission revoked");
        }
      };
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent,
        createAdmission: (binding) => () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            assertCurrent();
            if (!grant()) {
              throw new Error("Crash fixture lost its current native admission");
            }
          }, binding.attachment),
        }),
      };
      const execution = idle
        ? captureOpenClawAgentDatabaseExecution({ agentId, path: pathname, env })
        : undefined;
      const generation = execution
        ? {
            run: execution.runExisting.bind(execution),
            close: () => closeOpenClawAgentDatabaseByPathAsync(pathname),
          }
        : createAgentDatabaseNativeGeneration(
            agentId,
            pathname,
            context,
            assertCurrent,
            () => context.admission.assertCurrent(),
            undefined,
            () => {},
            retainVerification,
          );
      const integrityCheck = vi.spyOn(verification, "requestOpenClawAgentDatabaseIntegrityCheck");
      try {
        if (agentId === "corrupt-page") {
          await expect(generation.run(source, async () => "opened")).rejects.toThrow(
            /integrity|malformed|corrupt/i,
          );
          expect(Atomics.load(new Int32Array(counter.checks), 0)).toBeGreaterThan(0);
          expect(integrityCheck).not.toHaveBeenCalled();
          continue;
        }
        const sessionKey = `agent:${agentId}:after-crash`;
        const initialize = async () => {
          await expect(
            generation.run(source, (scope) => {
              return scope.execute({
                type: "session.transcript.initialize",
                input: { sessionKey, sessionId: "after-crash" },
              });
            }),
          ).resolves.toMatchObject({ kind: "session-transcript-initialized", sessionKey });
        };
        const finishPreparation = createDeferredCore();
        let preparing: Promise<void> | undefined;
        if (pending) {
          const opened = createDeferredCore();
          const refusal = createAgentDatabaseInspectionRefusal({
            agentId,
            paths: [pathname],
            pending: true,
            reason: "Startup preparation is pending",
          });
          recordAgentDatabaseAdmissions([refusal], { env });
          preparing = preparePendingAgentDatabase(
            refusal,
            {
              env,
              assertCurrent: () => context.admission.assertCurrent(),
            },
            async () => {
              await initialize();
              opened.resolve();
              await finishPreparation.promise;
              if (agentId === "background-preparation-failed") {
                throw new Error("Synthetic startup preparation failed");
              }
            },
          ).catch((error: unknown) => {
            failPendingAgentDatabase(refusal, error, { env });
            opened.reject(error);
          });
          await opened.promise;
        } else {
          await initialize();
        }
        expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual(
          deferred ? [0, 0] : [1, 1],
        );
        if (deferred) {
          expect(integrityCheck).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              path: pathname,
              env: expect.objectContaining(env),
              check: "full",
            }),
          );
          expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();

          // Drop the foreground borrower while the check is still queued before startup.
          if (agentId === "background-idle-timeout") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            try {
              await execution!.release();
              await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
            } finally {
              vi.useRealTimers();
            }
          } else {
            await execution?.release();
          }

          const applied = createDeferredCore();
          const applyResults = verificationImplementation.applyOpenClawDatabaseVerificationResults;
          let applicationError: unknown;
          const application = vi
            .spyOn(verificationImplementation, "applyOpenClawDatabaseVerificationResults")
            .mockImplementation(async (options) => {
              try {
                // The real child has finished its full scan; hold only the publication boundary.
                expect(options.results).toEqual([{ path: pathname, ok: true }]);
                if (agentId === "background-foreign-write") {
                  using foreign = openNodeSqliteDatabase(pathname);
                  foreign.exec(
                    "UPDATE auth_profile_state SET updated_at=2 WHERE state_key='committed-wal'",
                  );
                } else if (agentId === "background-revoked") {
                  current = false;
                } else if (agentId === "background-closed") {
                  await generation.close();
                } else if (agentId === "background-idle-swap") {
                  // Exceed the four warm slots while the scan's proof is still unpublished.
                  for (const siblingId of [
                    "same-boot",
                    "checkpointed-wal",
                    "background-foreign-write",
                    "background-revoked",
                    "background-closed",
                  ]) {
                    const sibling = captureOpenClawAgentDatabaseExecution({
                      agentId: siblingId,
                      env,
                    });
                    try {
                      await expect(sibling.runExisting(source, async () => "opened")).resolves.toBe(
                        "opened",
                      );
                    } finally {
                      await sibling.release();
                    }
                  }
                } else if (agentId === "background-replaced") {
                  const replacement = `${pathname}.replacement`;
                  using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
                  await requireNodeSqlite().backup(reader, replacement);
                  fs.renameSync(replacement, pathname);
                }
                let settled = false;
                const applying = applyResults(options).finally(() => {
                  settled = true;
                });
                if (pending) {
                  try {
                    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
                    await vi.advanceTimersByTimeAsync(0);
                    expect(settled, "verification must wait for startup admission").toBe(false);
                    expect(readOpenClawAgentIntegrityVerification(pathname, env)).toBeUndefined();
                  } finally {
                    vi.useRealTimers();
                    finishPreparation.resolve();
                    await preparing;
                  }
                }
                await applying;
              } catch (error) {
                applicationError = error;
                throw error;
              } finally {
                applied.resolve();
              }
            });
          let verifier: ReturnType<typeof verification.startOpenClawDatabaseIntegrityVerifier>;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            verifier = verification.startOpenClawDatabaseIntegrityVerifier({ env });
            vi.advanceTimersByTime(0);
          } finally {
            vi.useRealTimers();
          }
          try {
            await applied.promise;
            await verifier.stop();
            expect(applicationError).toBeUndefined();
            expect(readOpenClawAgentIntegrityVerification(pathname, env), agentId).toEqual(
              durable
                ? expect.objectContaining({
                    verified_at: expect.any(Number),
                    clean_close: 0,
                  })
                : undefined,
            );
          } finally {
            await verifier.stop();
            application.mockRestore();
          }
        } else {
          expect(integrityCheck).not.toHaveBeenCalled();
        }
      } finally {
        integrityCheck.mockRestore();
        await execution?.release();
        await generation.close();
        if (idle) {
          // Worker preloads capture the next case's counter at creation.
          await closeOpenClawAgentDatabasesAsync();
        }
      }
      if (deferred) {
        expect(readOpenClawAgentIntegrityVerification(pathname, env)).toEqual(
          durable ? expect.objectContaining({ clean_close: 1 }) : undefined,
        );
        // Remove process-local proof so the successor can consume only the durable receipt.
        clearOpenClawAgentDatabaseValidationCache(pathname);
        counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
        current = true;
        recordAgentDatabaseAdmissions([], { env });
        const successor = createAgentDatabaseNativeGeneration(
          agentId,
          pathname,
          context,
          assertCurrent,
          assertCurrent,
          undefined,
          () => {},
          retainVerification,
        );
        try {
          await expect(successor.run(source, async () => "reopened")).resolves.toBe("reopened");
          expect(Array.from(new Int32Array(counter.checks)), agentId).toEqual(
            durable ? [0, 0] : [1, 1],
          );
        } finally {
          await successor.close();
          await verification.startOpenClawDatabaseIntegrityVerifier({ env }).stop();
        }
      }
      using reopened = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(reopened.prepare("SELECT store_json FROM auth_profile_store").all()).toEqual([
        { store_json: '{"ok":true}' },
      ]);
      expect(reopened.prepare("SELECT state_key FROM auth_profile_state").all()).toEqual([
        { state_key: "committed-wal" },
      ]);
    }
  },
);

it("settles peer native leases when close revokes a shared worker's opening executor", async () => {
  const fixture = () => ({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-peers-")) },
  });
  const source = createNativeSource(() => {});
  const peers = [];
  const options = [];
  // Retained agents share broker workers with the next native opener.
  for (let index = 0; index < 4; index += 1) {
    const target = fixture();
    options.push(target);
    const peer = captureOpenClawAgentDatabaseExecution(target);
    await peer.prepare(source);
    peers.push(peer);
  }
  const target = fixture();
  options.push(target);
  const execution = captureOpenClawAgentDatabaseExecution(target);
  let closing: Promise<void> | undefined;
  const preparing = execution.prepare({
    ...source,
    createAdmission(binding) {
      return source.createAdmission({
        ...binding,
        authorize(request) {
          if (
            !closing &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-open-resume"
          ) {
            closing = closeOpenClawAgentDatabasesAsync();
            void closing.catch(() => {});
          }
          binding.authorize(request);
        },
      });
    },
  });
  try {
    await expect(preparing).rejects.toThrow("Agent database execution admission is closed");
    expect(closing).toBeDefined();
    await closing;
    for (const owner of options) {
      expect(
        openOpenClawStateDatabase({ env: owner.env })
          .db.prepare("SELECT lease_id FROM agent_database_leases")
          .all(),
      ).toEqual([]);
    }
  } finally {
    await Promise.allSettled([
      preparing,
      closing,
      execution.release(),
      ...peers.map((peer) => peer.release()),
    ]);
  }
});
