#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const stableGatewayRuntimePath = path.join(distDir, "message.gateway.runtime.js");

function fail(message) {
  console.error(`message runtime import check failed: ${message}`);
  process.exitCode = 1;
}

async function listMessageActionRunnerEntries() {
  let entries;
  try {
    entries = await fs.readdir(distDir, { withFileTypes: true });
  } catch {
    fail("dist directory is missing; run the build first");
    return [];
  }

  const runnerEntries = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^message-action-runner-[A-Za-z0-9_-]+\.js$/u.test(name))
    .toSorted((left, right) => left.localeCompare(right));

  const loadableEntries = [];
  for (const name of runnerEntries) {
    const filePath = path.join(distDir, name);
    const source = await fs.readFile(filePath, "utf8");
    if (
      source.includes("loadMessageActionGatewayRuntimeForTests") ||
      source.includes("message.gateway.runtime.js")
    ) {
      loadableEntries.push(name);
    }
  }
  return loadableEntries;
}

async function main() {
  try {
    await fs.access(stableGatewayRuntimePath);
  } catch {
    fail("dist/message.gateway.runtime.js stable alias is missing");
    return;
  }

  try {
    await import(pathToFileURL(stableGatewayRuntimePath).href);
  } catch (err) {
    fail(`dist/message.gateway.runtime.js could not be imported: ${err?.message ?? err}`);
    return;
  }

  const runnerEntries = await listMessageActionRunnerEntries();
  if (runnerEntries.length === 0) {
    fail("no built message-action-runner entry exposing the gateway runtime boundary was found");
    return;
  }

  for (const entry of runnerEntries) {
    const runnerUrl = pathToFileURL(path.join(distDir, entry)).href;
    let runner;
    try {
      runner = await import(runnerUrl);
    } catch (err) {
      fail(`${entry} could not be imported: ${err?.message ?? err}`);
      return;
    }

    // Modules export the same object as both `testing` and `__testing`; prefer
    // `testing` so this script needs no dangling-underscore lint exception. The
    // `__testing` fallback covers a dist built before that alias existed, since
    // this script reads dist and can run against a stale bundle.
    const loader = (runner?.testing ?? runner?.["__testing"])
      ?.loadMessageActionGatewayRuntimeForTests;
    if (typeof loader !== "function") {
      continue;
    }

    try {
      await loader();
    } catch (err) {
      fail(`${entry} could not lazy-load message.gateway.runtime.js: ${err?.message ?? err}`);
      return;
    }
  }
}

await main();
