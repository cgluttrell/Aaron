// Check Message Runtime Imports tests cover the message gateway runtime alias guard (T1048).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkMessageRuntimeImports,
  collectMessageRuntimeImportErrors,
} from "../../scripts/check-message-runtime-imports.mts";

const tempRoots: string[] = [];

function createDist(files: Record<string, string>): string {
  const distDir = mkdtempSync(join(tmpdir(), "openclaw-message-runtime-"));
  tempRoots.push(distDir);
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(distDir, name), source);
  }
  return distDir;
}

const ALIAS = {
  "message.gateway.runtime.js": 'export * from "./message.gateway.runtime-abc.mjs";',
};
const RUNTIME = { "message.gateway.runtime-abc.mjs": "export const sendMessage = () => {};" };

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-message-runtime-imports", () => {
  it("accepts chunks that lazy-load the runtime through the stable alias", () => {
    const distDir = createDist({
      ...ALIAS,
      ...RUNTIME,
      "message-action-runner-X1.mjs": 'const load = () => import("./message.gateway.runtime.js");',
      "message-Y2.mjs": "const load = () => import( './message.gateway.runtime.js' );",
    });

    expect(collectMessageRuntimeImportErrors({ distDir })).toEqual({
      errors: [],
      referencingChunks: ["message-action-runner-X1.mjs", "message-Y2.mjs"],
    });
  });

  it("rejects a chunk that lazy-loads a hashed runtime chunk directly", () => {
    const distDir = createDist({
      ...ALIAS,
      ...RUNTIME,
      "message-Y2.mjs": 'const load = () => import("./message.gateway.runtime-abc.mjs");',
    });

    expect(collectMessageRuntimeImportErrors({ distDir }).errors).toEqual([
      "message-Y2.mjs lazy-imports ./message.gateway.runtime-abc.mjs instead of ./message.gateway.runtime.js",
    ]);
  });

  it("rejects a dist without the stable alias or any lazy importer", () => {
    const distDir = createDist({ ...RUNTIME });

    expect(collectMessageRuntimeImportErrors({ distDir }).errors).toEqual([
      "dist/message.gateway.runtime.js stable alias is missing",
      "no built chunk lazy-imports ./message.gateway.runtime.js",
    ]);
  });

  it("fails when the alias target cannot be imported", async () => {
    const distDir = createDist({
      ...ALIAS,
      "message-Y2.mjs": 'const load = () => import("./message.gateway.runtime.js");',
    });
    const logger = { error: vi.fn() };

    await expect(checkMessageRuntimeImports({ distDir, logger })).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("dist/message.gateway.runtime.js could not be imported"),
    );
  });

  it("passes when the alias and its target import", async () => {
    const distDir = createDist({
      ...ALIAS,
      ...RUNTIME,
      "message-Y2.mjs": 'const load = () => import("./message.gateway.runtime.js");',
    });
    const logger = { error: vi.fn() };

    await expect(checkMessageRuntimeImports({ distDir, logger })).resolves.toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
