import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";

type ReceiptDatabase = { db: DatabaseSync; path: string; agentId: string };
// Structural subset of OpenClawAgentDatabaseValidation; this leaf must not import the cache.
type ValidationReceipt = {
  agentId: string;
  identity: string;
  receiptId: string;
  valid: SharedArrayBuffer;
  canonicalReady: SharedArrayBuffer;
};

export function createValidationReceipt(
  database: ReceiptDatabase,
  canonicalReady: boolean,
): ValidationReceipt {
  const { identity } = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity !== "string") {
    throw new Error("Only persistent agent databases retain integrity validation");
  }
  const validation = {
    agentId: database.agentId,
    identity,
    receiptId: randomUUID(),
    valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    canonicalReady: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  if (canonicalReady) {
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 1);
  }
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  return validation;
}

// Validation proof is keyed by the physical file, but registry rows keep the
// lexical spelling an opener used. Each receipt remembers the spellings admitted
// under it, so a validated reopen through a new alias still registers that alias.
// The set lives and dies with its receipt: revocation mints a new receipt.
const admittedSpellings = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseValidationSpellings"),
  () => new WeakMap<object, Set<string>>(),
);

export function recordValidationReceiptSpelling(receipt: object, pathname: string): void {
  const spellings = admittedSpellings.get(receipt) ?? new Set<string>();
  spellings.add(path.resolve(pathname));
  admittedSpellings.set(receipt, spellings);
}

export function hasValidationReceiptSpelling(receipt: object, pathname: string): boolean {
  return admittedSpellings.get(receipt)?.has(path.resolve(pathname)) === true;
}
