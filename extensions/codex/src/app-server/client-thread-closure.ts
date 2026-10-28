import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";

const MAX_CLOSED_THREAD_RECEIPTS = 256;
const THREAD_TERMINAL_NOTIFICATION_METHODS = new Set([
  "thread/archived",
  "thread/deleted",
  "thread/closed",
]);
const closureState = defineCodexBuildState("openclaw.codexAppServerClosedThreads", () => ({
  closedThreadsByClient: new WeakMap<CodexAppServerClient, Set<string>>(),
  observedClients: new WeakSet<CodexAppServerClient>(),
}))();

function recordCodexAppServerThreadClosed(client: CodexAppServerClient, threadId: string): void {
  const receipts = closureState.closedThreadsByClient.get(client) ?? new Set<string>();
  receipts.delete(threadId);
  receipts.add(threadId);
  while (receipts.size > MAX_CLOSED_THREAD_RECEIPTS) {
    const oldestThreadId = receipts.values().next().value;
    if (oldestThreadId === undefined) {
      break;
    }
    receipts.delete(oldestThreadId);
  }
  closureState.closedThreadsByClient.set(client, receipts);
}

export function isCodexAppServerThreadTerminalNotification(method: string): boolean {
  return THREAD_TERMINAL_NOTIFICATION_METHODS.has(method);
}

export function ensureCodexAppServerThreadClosureTracking(client: CodexAppServerClient): void {
  if (closureState.observedClients.has(client)) {
    return;
  }
  closureState.observedClients.add(client);
  client.addNotificationHandler((notification) => {
    const threadId =
      notification.params && typeof notification.params === "object"
        ? Reflect.get(notification.params, "threadId")
        : undefined;
    if (
      isCodexAppServerThreadTerminalNotification(notification.method) &&
      typeof threadId === "string"
    ) {
      recordCodexAppServerThreadClosed(client, threadId);
    }
  });
  client.addCloseHandler(() => closureState.closedThreadsByClient.delete(client));
}

export function clearCodexAppServerThreadClosed(
  client: CodexAppServerClient,
  threadId: string,
): void {
  closureState.closedThreadsByClient.get(client)?.delete(threadId);
}

export function wasCodexAppServerThreadClosed(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return closureState.closedThreadsByClient.get(client)?.has(threadId) === true;
}
