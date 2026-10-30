import type { CodexAppServerClient } from "./client.js";
import {
  createIsolatedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";

/** Temporary probes own isolated processes but only borrow shared-client leases. */
export async function releaseCodexProbeClient(
  client: CodexAppServerClient,
  factory: CodexAppServerClientFactory,
): Promise<void> {
  if (factory === createIsolatedCodexAppServerClient) {
    await client.closeAndWait();
  } else {
    releaseLeasedSharedCodexAppServerClient(client);
  }
}
