import { gatewayDatabaseWorkerTestFiles } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayDatabaseWorkersVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(gatewayDatabaseWorkerTestFiles, {
    dir: ".",
    env,
    fileParallelism: true,
    intersectIncludeFile: true,
    isolate: false,
    name: "gateway-database-workers",
    setupFiles: ["test/setup.cron-non-pressure.ts"],
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: true,
  });
}

export default createGatewayDatabaseWorkersVitestConfig();
