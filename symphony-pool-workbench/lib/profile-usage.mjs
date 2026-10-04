import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const browserNames = new Set(["chrome", "chromium", "chromium-browser", "msedge", "chrome-headless-shell"]);
const vanished = new Set(["ENOENT", "ESRCH"]);

function entry(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (vanished.has(error.code)) return null; throw error; }
}

export function profileInUse(profile, { platform = process.platform, procRoot = "/proc",
  hostname = os.hostname() } = {}) {
  const lockPath = path.join(profile, "SingletonLock");
  const lock = entry(lockPath);
  if (platform !== "linux") return Boolean(lock || entry(path.join(profile, "SingletonSocket")));

  // A lock on a shared profile may belong to another host. Its local PID cannot prove it stale.
  let ownerPid;
  if (lock) {
    if (!lock.isSymbolicLink()) throw new Error("ACCOUNT_PROFILE_STATE_UNKNOWN");
    let target;
    try { target = fs.readlinkSync(lockPath); }
    catch (error) { if (!vanished.has(error.code)) throw error; }
    if (target !== undefined) {
      const owner = /^(.*)-([1-9]\d*)$/.exec(target);
      if (!owner || owner[1] !== hostname) throw new Error("ACCOUNT_PROFILE_STATE_UNKNOWN");
      ownerPid = owner[2];
    }
  }

  let processes;
  try { processes = fs.readdirSync(procRoot); }
  catch { throw new Error("ACCOUNT_PROFILE_STATE_UNKNOWN"); }
  const expected = path.resolve(profile);
  // Inspect live processes even without a lock: stale PIDs can be reused, and a live browser
  // must remain protected if its lock is missing. SingletonSocket alone is not proof of use.
  for (const pid of processes.filter((name) => /^[1-9]\d*$/.test(name))) {
    let args;
    try { args = fs.readFileSync(path.join(procRoot, pid, "cmdline"), "utf8").split("\0"); }
    catch (error) {
      if (vanished.has(error.code)) continue;
      const stat = entry(path.join(procRoot, pid));
      if (pid === ownerPid || (stat && stat.uid === process.getuid())) {
        throw new Error("ACCOUNT_PROFILE_STATE_UNKNOWN");
      }
      continue;
    }
    if (!browserNames.has(path.basename(args[0] || "").toLowerCase())) continue;
    const index = args.indexOf("--user-data-dir");
    const value = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16)
      ?? (index >= 0 ? args[index + 1] : undefined);
    if (value && path.isAbsolute(value) && path.resolve(value) === expected) return true;
  }
  return false;
}
