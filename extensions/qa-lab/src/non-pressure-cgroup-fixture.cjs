// Loaded only by the automation-management QA Gateway child. Its synthetic
// cgroup represents a healthy host, so unrelated CI load cannot defer the
// scheduled run this UI test is proving. The production guard still samples.
const fs = require("node:fs");
const readFileSync = fs.readFileSync;
const cgroupFiles = new Map([
  ["/proc/self/cgroup", "0::/qa-non-pressure\n"],
  ["/sys/fs/cgroup/qa-non-pressure/memory.current", "1000000\n"],
  ["/sys/fs/cgroup/qa-non-pressure/memory.max", "1000000000\n"],
  ["/sys/fs/cgroup/qa-non-pressure/memory.stat", "file 0\n"],
]);

fs.readFileSync = function (file, ...args) {
  const synthetic = cgroupFiles.get(String(file));
  return synthetic === undefined
    ? readFileSync.call(this, file, ...args)
    : args[0] === "utf8" || args[0]?.encoding === "utf8"
      ? synthetic
      : Buffer.from(synthetic);
};
