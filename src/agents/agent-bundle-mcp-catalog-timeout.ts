import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

// Tool materialization awaits catalog listing. Bound it for servers without an
// explicit request timeout, with room for a cold remote (OAuth, HTTP) listing.
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 10_000;
let bundleMcpCatalogListTimeoutMs: number | undefined;

export function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  const record = asOptionalObjectRecord(rawServer);
  const configured = ["requestTimeoutMs", "timeout"].some(
    (key) => asPositiveFiniteNumber(record?.[key]) !== undefined,
  );
  return (
    bundleMcpCatalogListTimeoutMs ??
    (configured ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS)
  );
}

export function setBundleMcpCatalogListTimeoutMsForTest(timeoutMs?: number): void {
  bundleMcpCatalogListTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}
