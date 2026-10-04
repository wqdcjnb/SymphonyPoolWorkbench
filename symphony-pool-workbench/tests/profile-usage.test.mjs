import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { profileInUse } from "../lib/profile-usage.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-usage-"));
  const profile = path.join(root, "account-profile");
  const procRoot = path.join(root, "proc");
  fs.mkdirSync(profile);
  fs.mkdirSync(procRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profile, procRoot, hostname: "test-host" };
}

function processFile(f, pid, args) {
  fs.mkdirSync(path.join(f.procRoot, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(f.procRoot, String(pid), "cmdline"), args.join("\0") + "\0");
}

test("Linux stale profile locks do not block deletion, even after a PID is reused", {
  skip: process.platform !== "linux",
}, (t) => {
  const f = fixture(t);
  fs.symlinkSync("test-host-123", path.join(f.profile, "SingletonLock"));
  fs.symlinkSync("/tmp/old-chrome/SingletonSocket", path.join(f.profile, "SingletonSocket"));
  assert.equal(profileInUse(f.profile, f), false);
  processFile(f, 123, ["/opt/node/bin/node", `--user-data-dir=${f.profile}`]);
  assert.equal(profileInUse(f.profile, f), false);
  processFile(f, 123, ["/opt/google/chrome/chrome", `--user-data-dir=${f.profile}-other`]);
  assert.equal(profileInUse(f.profile, f), false);
});

test("Linux live browser ownership requires the exact profile and survives a missing lock", {
  skip: process.platform !== "linux",
}, (t) => {
  const f = fixture(t);
  fs.symlinkSync("test-host-123", path.join(f.profile, "SingletonLock"));
  processFile(f, 123, ["/opt/google/chrome/chrome", `--user-data-dir=${f.profile}`]);
  assert.equal(profileInUse(f.profile, f), true);
  fs.unlinkSync(path.join(f.profile, "SingletonLock"));
  assert.equal(profileInUse(f.profile, f), true);
  processFile(f, 123, ["/usr/bin/chromium", "--user-data-dir", f.profile]);
  assert.equal(profileInUse(f.profile, f), true);
  processFile(f, 123, ["/usr/bin/chromium"]);
  assert.equal(profileInUse(f.profile, f), false);
});

test("unverifiable Linux profile ownership is kept distinct from an active browser", {
  skip: process.platform !== "linux",
}, (t) => {
  const f = fixture(t);
  const lock = path.join(f.profile, "SingletonLock");
  fs.symlinkSync("another-host-123", lock);
  assert.throws(() => profileInUse(f.profile, f), /ACCOUNT_PROFILE_STATE_UNKNOWN/);
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, "unexpected lock format");
  assert.throws(() => profileInUse(f.profile, f), /ACCOUNT_PROFILE_STATE_UNKNOWN/);
  fs.unlinkSync(lock);
  assert.throws(() => profileInUse(f.profile, { ...f, procRoot: path.join(f.root, "missing") }),
    /ACCOUNT_PROFILE_STATE_UNKNOWN/);
});

test("Windows preserves its existing lock-file guard", (t) => {
  const f = fixture(t);
  const options = { ...f, platform: "win32" };
  assert.equal(profileInUse(f.profile, options), false);
  fs.writeFileSync(path.join(f.profile, "SingletonLock"), "browser lock");
  assert.equal(profileInUse(f.profile, options), true);
});
