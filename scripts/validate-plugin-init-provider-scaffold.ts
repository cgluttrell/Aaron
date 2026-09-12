import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPluginsInitCommand } from "../src/cli/plugins-authoring-command.js";

type InspectorReport = {
  status?: unknown;
  summary?: {
    breakageCount?: unknown;
    warningCount?: unknown;
    issueCount?: unknown;
  };
};

const artifactRoot = path.resolve(
  process.env.OPENCLAW_PLUGIN_INIT_VALIDATE_ROOT ?? ".artifacts/plugin-init-provider-scaffold",
);
const projectDir = path.join(artifactRoot, "plugin-init-test");
const reportPath = path.join(projectDir, ".clawhub-validation", "plugin-inspector-report.json");

function run(command: string, args: string[], cwd: string): void {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function runCapture(command: string, args: string[], cwd: string): string {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
  return result.stdout;
}

function toPackageFileSpec(fromDir: string, packagePath: string): string {
  return `file:${path.relative(fromDir, packagePath).replace(/\\/g, "/")}`;
}

function readWorkspacePackageVersions(): Map<string, string> {
  const packageVersions = new Map<string, string>();
  for (const packageDir of ["packages/ai"]) {
    const packageJsonPath = path.join(process.cwd(), packageDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
      packageVersions.set(packageJson.name, packageJson.version);
    }
  }
  return packageVersions;
}

function rewriteWorkspaceDependencyVersions(
  packageJson: Record<string, unknown>,
  workspacePackageVersions: Map<string, string>,
): number {
  let rewritten = 0;
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
        continue;
      }
      const version = workspacePackageVersions.get(name);
      if (!version) {
        throw new Error(
          `Local OpenClaw package references unconfigured workspace dependency: ${name}`,
        );
      }
      (dependencies as Record<string, string>)[name] = version;
      rewritten += 1;
    }
  }
  return rewritten;
}

function patchLocalOpenClawPackage(packagePath: string): string {
  const workspacePackageVersions = readWorkspacePackageVersions();
  const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-package-"));
  try {
    run("tar", ["-xzf", packagePath, "-C", unpackDir], process.cwd());
    const packageJsonPath = path.join(unpackDir, "package", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    const rewritten = rewriteWorkspaceDependencyVersions(packageJson, workspacePackageVersions);
    if (rewritten === 0) {
      return packagePath;
    }
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    const patchedPackagePath = path.join(artifactRoot, "openclaw-local-provider-scaffold.tgz");
    run("tar", ["-czf", patchedPackagePath, "-C", unpackDir, "package"], process.cwd());
    return patchedPackagePath;
  } finally {
    fs.rmSync(unpackDir, { force: true, recursive: true });
  }
}

function packLocalOpenClawPackage(): string {
  run("pnpm", ["build:plugin-sdk:strict-smoke"], process.cwd());
  const rawPackOutput = runCapture(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactRoot],
    process.cwd(),
  );
  const packEntries = JSON.parse(rawPackOutput) as Array<{ filename?: unknown }>;
  const filename = packEntries[0]?.filename;
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error(`npm pack did not report a package filename: ${rawPackOutput}`);
  }
  return patchLocalOpenClawPackage(path.join(artifactRoot, filename));
}

function useLocalOpenClawPackage(packagePath: string): void {
  const packageJsonPath = path.join(projectDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    openclaw: toPackageFileSpec(projectDir, packagePath),
  };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function readInspectorReport(): InspectorReport {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`ClawHub validation report not found: ${reportPath}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8")) as InspectorReport;
}

function assertCleanInspectorReport(report: InspectorReport): void {
  const breakageCount = Number(report.summary?.breakageCount ?? Number.NaN);
  const warningCount = Number(report.summary?.warningCount ?? Number.NaN);
  const issueCount = Number(report.summary?.issueCount ?? Number.NaN);
  if (report.status !== "pass" || breakageCount !== 0 || warningCount !== 0 || issueCount !== 0) {
    throw new Error(
      `Plugin Inspector was not clean: status=${String(
        report.status,
      )}, breakages=${breakageCount}, warnings=${warningCount}, issues=${issueCount}`,
    );
  }
}

fs.rmSync(projectDir, { force: true, recursive: true });
fs.mkdirSync(artifactRoot, { recursive: true });

await runPluginsInitCommand("plugin-init-test", {
  directory: projectDir,
  name: "Plugin Init Test",
  type: "provider",
});
useLocalOpenClawPackage(packLocalOpenClawPackage());

run("npm", ["install", "--no-audit", "--fund=false"], projectDir);
run("npm", ["run", "build"], projectDir);
run("npm", ["test"], projectDir);
run("npm", ["run", "validate"], projectDir);
assertCleanInspectorReport(readInspectorReport());

console.log(`Generated provider scaffold passed ClawHub validation: ${projectDir}`);
