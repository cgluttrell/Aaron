export function runtimeFixture(
  version: string,
  sqliteVersion = "3.51.3",
  status: "supported" | "unsupported" = "supported",
) {
  return {
    status,
    version,
    sqliteVersion,
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
  };
}
