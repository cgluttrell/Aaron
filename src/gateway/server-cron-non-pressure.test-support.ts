import { vi } from "vitest";

export const CRON_WAIT_TIMEOUT_MS = 10_000;
export type RunCronIsolatedAgentTurnMock = (params: { abortSignal?: AbortSignal }) => Promise<{
  status: "ok";
  summary: string;
}>;

// Cron routing suites do not exercise host cgroup admission.
vi.mock("../process/dispatch-pressure-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/dispatch-pressure-guard.js")>()),
  decideDispatchPressure: () => ({ status: "allow" as const, reason: "below_threshold" as const }),
}));
