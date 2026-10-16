// T3726: a rate-limited (429) primary during a cron agentTurn must fall through
// to the agent's configured fallback model — including for system-declared
// skill-collection-review jobs (T3723) — while every non-rate-limit failure
// class keeps the review's model pin. Runs the real gateway path:
// cron.run → run-executor → runWithModelFallback → embedded runner → provider HTTP.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPreparedModelRuntimeSnapshots } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../src/config/config.js";
import type { ModelDefinitionConfig } from "../src/config/types.models.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "../src/cron/skill-collection-review-monitor.js";
import {
  loadCronStore,
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../src/cron/store.js";
import type { CronJobCreate, CronStoredJob } from "../src/cron/types.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "../src/gateway/test-helpers.listener.js";
import { createWarnLogCapture } from "../src/logging/test-helpers/warn-log-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

// The real Gateway here exercises scheduled model failover; cgroup admission has
// its own tests. Shared CI pressure must not skip this job.
vi.mock("../src/process/dispatch-pressure-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process/dispatch-pressure-guard.js")>()),
  decideDispatchPressure: () => ({ status: "allow", reason: "below_threshold" }),
}));

// Attached devices are outside these scheduled model journeys.
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

type ProviderBehavior = "ok" | "rate-limit" | "bad-request";

// One provider pair per scenario keeps rate-limit cooldown state from one
// scenario out of the next one's candidate selection.
const PROVIDER_PAIRS = {
  "generic-a": { primary: "rlprime-a", fallback: "rlbackup-a" },
  "generic-b": { primary: "rlprime-b", fallback: "rlbackup-b" },
  "review-main": { primary: "rlprime-main", fallback: "rlbackup-main" },
  "review-aux": { primary: "rlprime-aux", fallback: "rlbackup-aux" },
} as const;

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

describe("cron agentTurn rate-limit fallback", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "falls through to the configured fallback only on rate-limited primaries",
    { timeout: 240_000 },
    async () => {
      const isolatedHome = expectDefined(process.env.OPENCLAW_TEST_HOME, "isolated test HOME");
      const root = tempDirs.make("cron-rate-limit-fallback-", isolatedHome);
      const workspaceDir = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const cleanup: Array<() => void | Promise<void>> = [];
      const behaviors = new Map<string, ProviderBehavior>();
      const requestCounts = new Map<string, number>();
      const providerErrors: string[] = [];
      let responseSequence = 0;

      const setScenario = (
        pair: (typeof PROVIDER_PAIRS)[keyof typeof PROVIDER_PAIRS],
        primary: ProviderBehavior,
        fallback: ProviderBehavior,
      ) => {
        behaviors.set(pair.primary, primary);
        behaviors.set(pair.fallback, fallback);
      };
      const countFor = (providerId: string) => requestCounts.get(providerId) ?? 0;

      await runQaGatewayFixture(
        async () => {
          await mkdir(workspaceDir, { recursive: true });
          vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
          vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
          vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
          for (const key of [
            "OPENCLAW_TEST_MINIMAL_GATEWAY",
            "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
            "OPENCLAW_SKIP_CANVAS_HOST",
            "OPENCLAW_SKIP_GMAIL_WATCHER",
          ]) {
            vi.stubEnv(key, "1");
          }
          vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
          vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
          vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
          vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
          for (const key of [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
          ]) {
            vi.stubEnv(key, undefined);
          }
          cleanup.push(() => clearRuntimeConfigSnapshot());
          cleanup.push(() => closeOpenClawStateDatabaseForTest());
          cleanup.push(() => closeOpenClawStateDatabaseAsync());

          const provider: Server = createServer((req, res) => {
            try {
              const url = new URL(req.url ?? "/", "http://fixture.invalid");
              const match = /^\/p\/([a-z0-9-]+)\/v1\/responses$/.exec(url.pathname);
              const providerId = match?.[1];
              if (req.method !== "POST" || !providerId || !behaviors.has(providerId)) {
                throw new Error(`Unexpected provider request: ${req.method} ${url.pathname}`);
              }
              req.resume();
              requestCounts.set(providerId, countFor(providerId) + 1);
              const behavior = behaviors.get(providerId);
              if (behavior === "rate-limit") {
                // Mirrors the T3723 incident class: a provider cap whose floor
                // (120 s) exceeds retry.provider.maxRetryDelayMs (60 s default).
                res.writeHead(429, {
                  "content-type": "application/json",
                  "retry-after": "120",
                });
                res.end(
                  JSON.stringify({
                    error: {
                      type: "rate_limit_error",
                      message: "Rate limit reached. Please try again in 120 seconds.",
                    },
                  }),
                );
                return;
              }
              if (behavior === "bad-request") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: {
                      type: "invalid_request_error",
                      message: "Synthetic invalid request for the fallback guard.",
                    },
                  }),
                );
                return;
              }
              responseSequence += 1;
              writeOpenAiResponsesText(res, {
                text: `done via ${providerId}`,
                messageId: `msg-${providerId}-${responseSequence}`,
                responseId: `resp-${providerId}-${responseSequence}`,
              });
            } catch (error) {
              providerErrors.push(String(error));
              res.writeHead(500).end();
            }
          });
          cleanup.push(async () => {
            provider.closeAllConnections();
            if (provider.listening) {
              await new Promise<void>((resolve, reject) => {
                provider.close((error) => (error ? reject(error) : resolve()));
              });
            }
          });
          await new Promise<void>((resolve, reject) => {
            provider.once("error", reject);
            provider.listen(0, "127.0.0.1", resolve);
          });
          const address = provider.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected provider TCP address");
          }
          const providerOrigin = `http://127.0.0.1:${address.port}`;

          const gatewayPortClaim = await acquireGatewayE2ePortBlock();
          const gatewayPort = gatewayPortClaim.port;
          let unstartedGatewayPortClaim: typeof gatewayPortClaim | undefined = gatewayPortClaim;
          cleanup.push(() => unstartedGatewayPortClaim?.release());
          const gatewayToken = "synthetic-rate-limit-fallback-gateway-token";

          const providerIds = Object.values(PROVIDER_PAIRS).flatMap((pair) => [
            pair.primary,
            pair.fallback,
          ]);
          const modelRef = (providerId: string) => `${providerId}/${providerId}-model`;
          const modelConfigs = Object.fromEntries(
            providerIds.map((providerId) => [
              modelRef(providerId),
              {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            ]),
          );
          const agentModel = (pair: { primary: string; fallback: string }) => ({
            primary: modelRef(pair.primary),
            fallbacks: [modelRef(pair.fallback)],
          });
          const cfg: OpenClawConfig = {
            gateway: {
              mode: "local",
              port: gatewayPort,
              auth: { mode: "token", token: gatewayToken },
              controlUi: { enabled: false },
            },
            agents: {
              ownership: "explicit",
              entries: {
                main: { model: agentModel(PROVIDER_PAIRS["review-main"]) },
                aux: { model: agentModel(PROVIDER_PAIRS["review-aux"]) },
                "generic-a": { model: agentModel(PROVIDER_PAIRS["generic-a"]) },
                "generic-b": { model: agentModel(PROVIDER_PAIRS["generic-b"]) },
              },
              defaults: {
                workspace: workspaceDir,
                skipBootstrap: true,
                timeoutSeconds: 30,
                model: agentModel(PROVIDER_PAIRS["generic-a"]),
                models: modelConfigs,
                thinkingDefault: "off",
              },
            },
            models: {
              providers: Object.fromEntries(
                providerIds.map((providerId) => [
                  providerId,
                  {
                    baseUrl: `${providerOrigin}/p/${providerId}/v1`,
                    apiKey: `synthetic-${providerId}-token`,
                    api: "openai-responses",
                    request: { allowPrivateNetwork: true },
                    models: [buildModel(`${providerId}-model`)],
                  },
                ]),
              ),
            },
            tools: { toolSearch: false },
            plugins: { allow: [], slots: { memory: "none" } },
            cron: { enabled: false },
            skills: { workshop: { autonomous: { mode: "auto" } } },
          };
          await writeFile(configPath, JSON.stringify(cfg));
          setRuntimeConfigSnapshot(cfg, cfg);

          // Seed the system-owned review jobs from the real monitor spec
          // producer. The scheduler-side reconcile that normally declares them
          // is a background loop the manual-RPC gateway fixture keeps off.
          const reviewSeedAgents = new Set(["main", "aux"]);
          const nowMs = Date.now();
          const seededReviewJobs: CronStoredJob[] = [
            ...resolveSkillCollectionReviewMonitorSpecs(cfg, []),
          ]
            .filter((spec) => reviewSeedAgents.has(spec.agentId))
            .map(({ input }) =>
              Object.assign({}, input, {
                id: randomUUID(),
                enabled: true,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                scheduledToolPolicy: { version: 1, mode: "trusted" },
                state: {},
              } satisfies Partial<CronStoredJob>),
            );
          expect(seededReviewJobs).toHaveLength(2);
          await saveCronJobsStore(resolveCronJobsStorePathFromConfig(cfg), {
            version: 1,
            jobs: seededReviewJobs,
          });

          const realFetch = globalThis.fetch.bind(globalThis);
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              if (
                url.origin !== providerOrigin &&
                url.origin !== `http://127.0.0.1:${gatewayPort}`
              ) {
                throw new Error(`Unexpected fixture network destination: ${url.origin}`);
              }
              return await realFetch(input, init);
            }),
          );
          cleanup.push(() => resetPreparedModelRuntimeSnapshotsForTest());

          const finishedRuns = new Map<
            string,
            ReturnType<typeof createDeferred<Record<string, unknown>>>
          >();
          const finishedFor = (jobId: string) => {
            let deferred = finishedRuns.get(jobId);
            if (!deferred) {
              deferred = createDeferred<Record<string, unknown>>();
              finishedRuns.set(jobId, deferred);
            }
            return deferred;
          };
          unstartedGatewayPortClaim = undefined;
          const gateway = await startGatewayWithClient({
            portClaim: gatewayPortClaim,
            cfg,
            configPath,
            token: gatewayToken,
            scopes: ["operator.admin"],
            onEvent: (event) => {
              if (
                event.event === "cron" &&
                isRecord(event.payload) &&
                event.payload.action === "finished" &&
                typeof event.payload.jobId === "string"
              ) {
                finishedFor(event.payload.jobId).resolve(event.payload);
              }
            },
          });
          cleanup.push(async () => {
            await runQaGatewayFixture(
              () => disconnectGatewayClient(gateway.client),
              () => gateway.server.close({ reason: "rate-limit fallback fixture complete" }),
            );
          });
          await gateway.server.startupSettled;
          await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
            gatewayLifecycle: true,
            catalogMode: "static",
          });

          const storePath = resolveCronJobsStorePathFromConfig(getRuntimeConfig());
          const reviewJobFor = async (agentId: string) =>
            expectDefined(
              (await loadCronStore(storePath)).jobs.find(
                (job) => job.declarationKey === `skill-collection-review:${agentId}`,
              ),
              `system-declared review job for ${agentId}`,
            );

          const addGenericJob = async (agentId: string) =>
            await gateway.client.request<{ id: string }>("cron.add", {
              name: `Rate limit fallback ${agentId}`,
              agentId,
              enabled: true,
              schedule: { kind: "every", everyMs: 86_400_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "Reply with the single word done." },
              delivery: { mode: "none" },
            } satisfies CronJobCreate);

          const startedAtMs = Date.now();
          const stage = (label: string) => {
            // eslint-disable-next-line no-console
            console.log(`[cron-rate-limit-fallback] +${Date.now() - startedAtMs}ms ${label}`);
          };
          const runJob = async (jobId: string, label: string) => {
            stage(`run ${label}`);
            let runResult: unknown;
            try {
              runResult = await gateway.client.request("cron.run", { id: jobId, mode: "force" });
            } catch (error) {
              throw new Error(`cron.run failed for ${label}: ${String(error)}`, { cause: error });
            }
            expect(runResult).toMatchObject({ ok: true });
            const completion = await withTestTimeout(
              finishedFor(jobId).promise,
              120_000,
              `Expected ${label} cron run to finish`,
            );
            stage(`finished ${label}`);
            return completion;
          };
          const diagnostics = (completion: unknown) =>
            JSON.stringify({
              completion,
              providerErrors,
              requestCounts: Object.fromEntries(requestCounts),
            });

          stage("gateway startup settled");
          const warnLogs = createWarnLogCapture("cron-rate-limit-fallback");
          cleanup.push(() => warnLogs.cleanup());

          // Scenario 1 (T3723 regression): the system-declared
          // skill-collection-review job reaches the agent's fallback when its
          // pinned primary is rate-limited.
          {
            const pair = PROVIDER_PAIRS["review-main"];
            setScenario(pair, "rate-limit", "ok");
            const job = await reviewJobFor("main");
            const completion = await runJob(job.id, "review rate-limit fallback");
            expect(completion, diagnostics(completion)).toMatchObject({ status: "ok" });
            expect(countFor(pair.primary), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            expect(countFor(pair.fallback), diagnostics(completion)).toBeGreaterThanOrEqual(1);
          }

          // Scenario 2: a generic agentTurn with a rate-limited primary falls
          // through to the configured fallback, which serves the turn.
          {
            const pair = PROVIDER_PAIRS["generic-a"];
            setScenario(pair, "rate-limit", "ok");
            const job = await addGenericJob("generic-a");
            const completion = await runJob(job.id, "generic rate-limit fallback");
            expect(completion, diagnostics(completion)).toMatchObject({ status: "ok" });
            expect(countFor(pair.primary), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            expect(countFor(pair.fallback), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            const warning = await warnLogs.findText(`rate-limited ${pair.primary}/`);
            expect(warning).toContain(
              `rate-limited ${pair.primary}/${pair.primary}-model; switching to fallback ` +
                `${pair.fallback}/${pair.fallback}-model (reason=rate_limit)`,
            );
          }

          // Scenario 3: primary AND fallback rate-limited — the existing
          // chain-exhausted failure is preserved, with bounded request counts.
          {
            const pair = PROVIDER_PAIRS["generic-b"];
            setScenario(pair, "rate-limit", "rate-limit");
            const job = await addGenericJob("generic-b");
            const completion = await runJob(job.id, "both rate-limited");
            expect(completion, diagnostics(completion)).toMatchObject({ status: "error" });
            expect(countFor(pair.primary), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            expect(countFor(pair.fallback), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            expect(countFor(pair.primary), diagnostics(completion)).toBeLessThanOrEqual(12);
            expect(countFor(pair.fallback), diagnostics(completion)).toBeLessThanOrEqual(12);
          }

          // Scenario 4 (guard): a non-rate-limit failure (HTTP 400) on a review
          // job's primary must NOT trigger the new switch — the fallback
          // provider is never contacted and the run surfaces the error.
          {
            const pair = PROVIDER_PAIRS["review-aux"];
            setScenario(pair, "bad-request", "ok");
            const job = await reviewJobFor("aux");
            const completion = await runJob(job.id, "review bad-request guard");
            expect(completion, diagnostics(completion)).toMatchObject({ status: "error" });
            expect(countFor(pair.primary), diagnostics(completion)).toBeGreaterThanOrEqual(1);
            expect(countFor(pair.fallback), diagnostics(completion)).toBe(0);
          }

          expect(providerErrors).toEqual([]);
        },
        () => runQaGatewayFixture(async () => {}, ...cleanup.toReversed()),
        () => vi.restoreAllMocks(),
        () => vi.unstubAllGlobals(),
        () => vi.unstubAllEnvs(),
      );
    },
  );
});
