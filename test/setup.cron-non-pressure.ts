import { vi } from "vitest";

// Tests that need the real cgroup guard can call vi.unmock on this module at file top.
vi.mock("../src/process/dispatch-pressure-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process/dispatch-pressure-guard.js")>()),
  decideDispatchPressure: () => ({ status: "allow" as const, reason: "below_threshold" as const }),
}));
