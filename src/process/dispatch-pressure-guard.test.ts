import { beforeEach, describe, expect, it } from "vitest";
import {
  decideDispatchPressure,
  resetDispatchPressureGuardForTest,
} from "./dispatch-pressure-guard.js";

function reader(files: Record<string, string>) {
  return (file: string) => {
    const value = files[file];
    if (value === undefined) {
      throw new Error(`missing test cgroup file: ${file}`);
    }
    return value;
  };
}

describe("dispatch pressure guard", () => {
  beforeEach(() => {
    resetDispatchPressureGuardForTest();
  });

  it("defers when cgroup memory is above the safe usage threshold", () => {
    const decision = decideDispatchPressure(
      { workKind: "cron_isolated_agent", workId: "job-pressure" },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(900),
          "/cgroup/gateway/memory.max": String(1000),
        }),
      },
    );

    expect(decision.status).toBe("defer");
    expect(decision.status === "defer" ? decision.reason : "").toBe("cgroup_memory_threshold");
    expect(decision.status === "defer" ? decision.threshold.usageRatio : 0).toBe(0.85);
  });

  it("defers when cgroup memory grows too quickly inside the sample window", () => {
    const readTextFile = reader({
      "/cgroup/gateway/memory.current": String(100),
      "/cgroup/gateway/memory.max": String(1000),
    });
    expect(
      decideDispatchPressure(
        { workKind: "gateway_agent", workId: "agent-1" },
        { cgroupDir: "/cgroup/gateway", readTextFile, nowMs: () => 1_000 },
      ).status,
    ).toBe("allow");

    const decision = decideDispatchPressure(
      { workKind: "gateway_agent", workId: "agent-2" },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(190),
          "/cgroup/gateway/memory.max": String(1000),
        }),
        nowMs: () => 31_000,
      },
    );

    expect(decision.status).toBe("defer");
    expect(decision.status === "defer" ? decision.reason : "").toBe("cgroup_memory_growth");
    expect(decision.status === "defer" ? decision.sample.growthBytes : 0).toBe(90);
  });

  it("allows an explicit Chris-approved urgent override and preserves the pressure sample", () => {
    const decision = decideDispatchPressure(
      {
        workKind: "cron_isolated_agent",
        workId: "job-urgent",
        override: { approvedBy: "Chris", reason: "restore customer-facing automation" },
      },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(950),
          "/cgroup/gateway/memory.max": String(1000),
        }),
      },
    );

    expect(decision.status).toBe("override");
    expect(decision.status === "override" ? decision.override.approvedBy : "").toBe("Chris");
    expect(decision.status === "override" ? decision.sample?.currentBytes : 0).toBe(950);
  });
});
