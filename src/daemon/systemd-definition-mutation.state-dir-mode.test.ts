import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileUtf8 } from "./exec-file.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

// mock-isolation: No host systemd or shell command may run from these cases.
vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execBusctlUser: async (env: Record<string, string | undefined>) => ({
    code: 1,
    termination: "exit",
    stdout: "",
    stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT}.service not found.`,
  }),
  execSystemctlUser: async () => ({ code: 0, termination: "exit", stdout: "", stderr: "" }),
}));

import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { stageSystemdService } from "./systemd-install.js";

// Safe fixture modes must not depend on umask; fault cases change permissions explicitly.
const writeFixtureFile = (file: string, contents: string) =>
  fs.writeFile(file, contents, { mode: 0o644 });

describe.skipIf(process.platform === "win32")("systemd state directory mode repair", () => {
  let root: string;
  let stateDir: string;
  let unitPath: string;
  let environmentPath: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-mode-")));
    stateDir = path.join(root, "state");
    env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    unitPath = path.join(env.HOME!, ".config/systemd/user/openclaw-owned.service");
    environmentPath = path.join(stateDir, "gateway.systemd.env");
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(stateDir, { mode: 0o700 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const stage = () =>
    stageSystemdService({
      env,
      stdout: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "replacement-secret-canary",
      },
      environmentValueSources: {
        OPENCLAW_GATEWAY_PORT: "inline",
        OPENCLAW_GATEWAY_TOKEN: "file",
      },
    });

  it.each([0o775, 0o777])(
    "repairs an owned writable state directory (%o) before publication",
    async (mode) => {
      await writeFixtureFile(path.join(stateDir, "operator-data"), "preserved\n");
      await fs.chmod(stateDir, mode);

      expect(await readSystemdDefinitionMutationCapability(env)).toEqual({ kind: "writable" });
      expect((await fs.stat(stateDir)).mode & 0o777).toBe(mode);
      await stage();

      expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
      expect(await fs.readFile(path.join(stateDir, "operator-data"), "utf8")).toBe("preserved\n");
      expect(await fs.readFile(unitPath, "utf8")).toContain("ExecStart=");
      expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
    },
  );

  it("does not publish service credentials if state directory repair fails", async () => {
    await fs.chmod(stateDir, 0o775);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === stateDir) {
        vi.spyOn(handle, "chmod").mockRejectedValue(new Error("state directory chmod denied"));
      }
      return handle;
    });

    await expect(stage()).rejects.toThrow("state directory chmod denied");
    for (const directory of [stateDir, path.dirname(unitPath)]) {
      expect(await fs.readdir(directory)).toEqual([]);
    }
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o775);
  });
});
