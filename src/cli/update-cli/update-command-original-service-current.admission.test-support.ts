import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

type AdmissionFixture = { state: OpenClawTestState; rootA: string; rootB: string };

export async function withCurrentF3Admission(
  fixture: () => AdmissionFixture,
  operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
  retained = true,
) {
  const { state, rootA, rootB } = fixture();
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
    env: state.env,
  };
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(rootB, retained ? { serviceRoot: rootA } : {});
    await operation(run);
  });
}
