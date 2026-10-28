import "./doctor-maintenance.settlement.test-support.js";
import { expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const settlement = await import("./doctor-maintenance.settlement.test-support.js");
const { begin, boundary, root } = settlement;

it("restores the stopped Gateway before reporting a settled state-owner release failure", async () => {
  const failure = new Error("settled state-owner release failed");
  boundary.release.mockRejectedValueOnce(failure);
  const maintenance = await begin();

  await expect(maintenance!.finish({})).rejects.toBe(failure);
  expect(boundary.close).toHaveBeenCalledOnce();
  expect(boundary.resume).toHaveBeenCalledOnce();
  expect(boundary.restart).toHaveBeenCalledOnce();
  expect(boundary.health).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "prints the Gateway start recovery when restoration fails (restart fails: %s)",
  async (restartFails) => {
    const failure = new Error("settled state-owner release failed");
    boundary.release.mockRejectedValueOnce(failure);
    if (restartFails) {
      boundary.restart.mockRejectedValueOnce(new Error("synthetic service start failure"));
    }
    const runtimeError = vi.fn();
    const maintenance = await beginDoctorMaintenance({
      root,
      options: { repair: true, nonInteractive: true },
      runtime: { log: boundary.log, error: runtimeError, exit: vi.fn() },
    });

    await expect(maintenance!.finish({})).rejects.toThrow(
      restartFails ? "synthetic service start failure" : failure.message,
    );
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledTimes(restartFails ? 0 : 1);
    const printed = runtimeError.mock.calls.map(([message]) => String(message));
    if (restartFails) {
      expect(printed).toContainEqual(expect.stringContaining("openclaw gateway start"));
      expect(printed).toContainEqual(expect.stringContaining("synthetic service start failure"));
    } else {
      expect(printed).not.toContainEqual(expect.stringContaining("openclaw gateway start"));
    }
  },
);
