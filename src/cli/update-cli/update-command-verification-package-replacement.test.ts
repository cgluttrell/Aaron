import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { isUpdateRunVerificationConfirmed } from "../../infra/update-run-verification.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "../daemon-cli/restart-health.test-helpers.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { maybeRestartService } from "./update-command-service.js";

vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunStep: vi.fn(),
  recordUpdateRunVerification: vi.fn(),
}));
vi.mock("../../infra/update-run-report-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-report-health.js")>()),
  readUpdateRunReportHealth: vi.fn(async () => ({ kind: "unavailable" })),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));
vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));
vi.mock("./update-command-config-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config-snapshot.js")>()),
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: vi.fn(async () => "accepted"),
}));

// Split from update-command-verification.test.ts on the release line, which
// carries more retained cases than main and would exceed the max-lines budget.
let server: Server | undefined;
async function listen() {
  server = createServer((_req, res) => res.writeHead(200).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing loopback listener");
  }
  return address.port;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordUpdateRunVerification).mockReset();
  vi.mocked(recordUpdateRunStep).mockReset();
  resetRestartHealthMocks();
});
afterEach(async () => {
  restoreRestartHealthMocks();
  server?.closeAllConnections();
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

describe("package replacement observation with --no-restart", () => {
  it.each(
    (["npm", "pnpm", "bun"] as const).flatMap((mode) =>
      (
        [
          "ready",
          "starting",
          "old-version",
          "old-build",
          "missing-build",
          "retained-identity",
        ] as const
      ).map((state) => ({ mode, state })),
    ),
  )(
    "observes a package watcher restart without failing --no-restart ($mode, $state)",
    async ({ mode, state }) => {
      const verified = state === "ready" || state === "retained-identity";
      mockProcessPlatform("linux");
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
        makeGatewayService({ status: "running", pid: 8000 }),
      );
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation(
        state === "starting"
          ? async () => {
              throw new Error("gateway timeout after 3000ms");
            }
          : gatewayHealthResponse({
              server: {
                version:
                  state === "old-version" || state === "retained-identity"
                    ? "2026.9.7"
                    : "2026.9.8",
                buildId:
                  state === "missing-build"
                    ? undefined
                    : state === "old-build"
                      ? "previous-build"
                      : state === "retained-identity"
                        ? "retained-build"
                        : "candidate",
                bootId: "watcher-successor",
              },
            }),
      );
      const result: UpdateRunResult = {
        status: "ok",
        mode,
        after: { version: "2026.9.8", buildId: "candidate" },
        steps: [],
        durationMs: 0,
      };
      const outcome = await maybeRestartService({
        result,
        opts: { json: true, restart: false, run: { runId: "watcher-restart", env: {} } },
        shouldRestart: false,
        observePackageReplacement: true,
        expectedGatewayIdentity:
          state === "retained-identity"
            ? { version: "2026.9.7", buildId: "retained-build" }
            : undefined,
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: await listen(),
        timeoutMs: 1000,
      });
      expect(outcome).toBe("ok");
      expect(runUpdatedInstallGatewayCommand).not.toHaveBeenCalled();
      expect(result.status).toBe("ok");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.failureFacts).toBeUndefined();
      expect(result.steps[0]?.termination).toBeUndefined();
      expect(result.steps[0]?.advisory?.message).toEqual(
        verified ? undefined : expect.stringContaining("--no-restart"),
      );
      expect(recordUpdateRunVerification).toHaveBeenCalledWith(
        "watcher-restart",
        expect.objectContaining({
          versionMatch: state === "starting" ? undefined : verified,
        }),
        expect.anything(),
      );
      const facts = vi.mocked(recordUpdateRunVerification).mock.calls.at(-1)?.[1];
      expect(facts && isUpdateRunVerificationConfirmed(facts)).toBe(verified);
      if (state === "old-build") {
        expect(facts?.runningBuildId).toBe("previous-build");
        expect(result.steps[0]?.advisory?.message).toContain("candidate");
        expect(result.steps[0]?.advisory?.message).toContain("previous-build");
        expect(
          renderUpdateRunReport({
            ...updateRunReportInputFromResult(result),
            verification: facts ?? {},
          }).markdown,
        ).toContain("build mismatch");
      }
    },
  );
});
