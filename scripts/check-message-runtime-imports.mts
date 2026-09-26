#!/usr/bin/env node

// Checks that built chunks lazy-load the message gateway runtime through its stable alias (T1048).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const STABLE_ALIAS = "message.gateway.runtime.js";
const STABLE_SPECIFIER = `./${STABLE_ALIAS}`;
const RUNTIME_DYNAMIC_IMPORT_RE =
  /\bimport\(\s*["'](?<specifier>\.\/message\.gateway\.runtime[^"']*)["']\s*\)/gu;
const CHUNK_NAME_RE = /\.(?:m?js)$/u;

type MessageRuntimeImportCheckParams = {
  distDir?: string;
  fs?: typeof fs;
};

/**
 * A running gateway resolves lazy imports against the dist on disk. A chunk that
 * imports a hashed runtime chunk directly breaks after an in-place rebuild renames
 * it, so every lazy import must go through the stable alias.
 */
export function collectMessageRuntimeImportErrors(params: MessageRuntimeImportCheckParams = {}): {
  errors: string[];
  referencingChunks: string[];
} {
  const fsImpl = params.fs ?? fs;
  const distDir = params.distDir ?? path.resolve("dist");
  const errors: string[] = [];
  const referencingChunks: string[] = [];
  let names: string[];
  try {
    names = fsImpl.readdirSync(distDir);
  } catch {
    return { errors: ["dist directory is missing; run the build first"], referencingChunks };
  }
  if (!names.includes(STABLE_ALIAS)) {
    errors.push(`dist/${STABLE_ALIAS} stable alias is missing`);
  }
  for (const name of names.toSorted((left, right) => left.localeCompare(right))) {
    if (name === STABLE_ALIAS || !CHUNK_NAME_RE.test(name)) {
      continue;
    }
    const filePath = path.join(distDir, name);
    if (!fsImpl.statSync(filePath).isFile()) {
      continue;
    }
    const source = fsImpl.readFileSync(filePath, "utf8");
    let referenced = false;
    for (const match of source.matchAll(RUNTIME_DYNAMIC_IMPORT_RE)) {
      referenced = true;
      const specifier = match.groups?.specifier;
      if (specifier !== STABLE_SPECIFIER) {
        errors.push(`${name} lazy-imports ${specifier} instead of ${STABLE_SPECIFIER}`);
      }
    }
    if (referenced) {
      referencingChunks.push(name);
    }
  }
  if (referencingChunks.length === 0) {
    errors.push(`no built chunk lazy-imports ${STABLE_SPECIFIER}`);
  }
  return { errors, referencingChunks };
}

/** Runs the static check, then imports the alias so its hashed target must resolve. */
export async function checkMessageRuntimeImports(
  params: MessageRuntimeImportCheckParams & {
    importModule?: (url: string) => Promise<unknown>;
    logger?: { error(message: string): void };
  } = {},
): Promise<boolean> {
  const logger = params.logger ?? console;
  const distDir = params.distDir ?? path.resolve("dist");
  const { errors } = collectMessageRuntimeImportErrors({ ...params, distDir });
  if (errors.length === 0) {
    const importModule = params.importModule ?? ((url: string) => import(url));
    try {
      await importModule(pathToFileURL(path.join(distDir, STABLE_ALIAS)).href);
    } catch (err) {
      errors.push(`dist/${STABLE_ALIAS} could not be imported: ${String(err)}`);
    }
  }
  for (const error of errors) {
    logger.error(`message runtime import check failed: ${error}`);
  }
  return errors.length === 0;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  if (await checkMessageRuntimeImports()) {
    console.log("Message runtime import check passed.");
  } else {
    process.exit(1);
  }
}
