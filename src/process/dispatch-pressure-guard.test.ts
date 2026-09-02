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
          "/cgroup/gateway/memory.current": String(950),
          "/cgroup/gateway/memory.max": String(1000),
          "/cgroup/gateway/memory.stat": "anon 900\nfile 50\ninactive_file 50\n",
        }),
      },
    );

    expect(decision.status).toBe("defer");
    expect(decision.status === "defer" ? decision.reason : "").toBe("cgroup_memory_threshold");
    expect(decision.status === "defer" ? decision.threshold.usageRatio : 0).toBe(0.85);
    expect(decision.status === "defer" ? decision.sample.workingSetBytes : 0).toBe(900);
  });

  it("does not defer on reclaimable file cache when working set is below threshold", () => {
    const decision = decideDispatchPressure(
      { workKind: "cron_isolated_agent", workId: "job-cache" },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(950),
          "/cgroup/gateway/memory.max": String(1000),
          "/cgroup/gateway/memory.stat": "anon 450\nfile 500\ninactive_file 500\n",
        }),
      },
    );

    expect(decision.status).toBe("allow");
    expect(decision.status === "allow" ? decision.reason : "").toBe("below_threshold");
  });

  it("does not count active file cache as working set on an unbounded cgroup", () => {
    // Regression for T2273: 14.4 GB current with 12.2 GB page cache (11 GB of it active) and
    // 1.6 GB anon deferred every isolated dispatch for days. Only anon-like memory is pressure.
    const decision = decideDispatchPressure(
      { workKind: "cron_isolated_agent", workId: "job-active-cache" },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(14_400),
          "/cgroup/gateway/memory.max": "max",
          "/cgroup/gateway/memory.stat":
            "anon 1600\nfile 12200\nactive_file 11100\ninactive_file 1100\n",
        }),
        unboundedWorkingSetBytesLimit: 6_000,
      },
    );

    expect(decision.status).toBe("allow");
    expect(decision.status === "allow" ? decision.sample?.workingSetBytes : 0).toBe(2_200);
    expect(decision.status === "allow" ? decision.sample?.fileCacheBytes : 0).toBe(12_200);
  });

  it("defers on an absolute working-set threshold when the cgroup is unbounded", () => {
    const decision = decideDispatchPressure(
      { workKind: "cron_isolated_agent", workId: "job-unbounded" },
      {
        cgroupDir: "/cgroup/gateway",
        readTextFile: reader({
          "/cgroup/gateway/memory.current": String(7_000),
          "/cgroup/gateway/memory.max": "max",
          "/cgroup/gateway/memory.stat": "anon 6500\nfile 500\ninactive_file 500\n",
        }),
        unboundedWorkingSetBytesLimit: 6_000,
      },
    );

    expect(decision.status).toBe("defer");
    expect(decision.status === "defer" ? decision.reason : "").toBe(
      "cgroup_memory_absolute_threshold",
    );
    expect(decision.status === "defer" ? decision.sample.workingSetBytes : 0).toBe(6_500);
  });

  it("defers when cgroup working set grows too quickly inside the sample window", () => {
    const readTextFile = reader({
      "/cgroup/gateway/memory.current": String(100),
      "/cgroup/gateway/memory.max": String(1000),
      "/cgroup/gateway/memory.stat": "anon 80\nfile 20\ninactive_file 20\n",
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
          "/cgroup/gateway/memory.stat": "anon 170\nfile 20\ninactive_file 20\n",
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
          "/cgroup/gateway/memory.stat": "anon 950\nfile 0\ninactive_file 0\n",
        }),
      },
    );

    expect(decision.status).toBe("override");
    expect(decision.status === "override" ? decision.override.approvedBy : "").toBe("Chris");
    expect(decision.status === "override" ? decision.sample?.currentBytes : 0).toBe(950);
  });
});
