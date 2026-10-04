import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/js/account-login.js", import.meta.url), "utf8")
  .replace(/^import[^\n]+\n/, "");
const desktop = token => ({ desktop: {
  protocol: "xpra", accountId: "test-account", port: 6081, token: token.repeat(64),
} });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function loginPage(respond) {
  const elements = new Map();
  const calls = [], navigations = [];
  let activation = true;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", hidden: false, disabled: false, listeners: {}, href: "#",
      addEventListener(name, listener) { this.listeners[name] = listener; },
      removeAttribute(name) { delete this[name]; },
    });
    return elements.get(selector);
  };
  vm.runInNewContext(source, {
    document: { querySelector: element },
    window: { location: {
      pathname: "/accounts/test-account/login", protocol: "http:", hostname: "127.0.0.1",
      assign: connection => navigations.push(connection),
    } },
    navigator: { userActivation: { get isActive() { return activation; } } },
    URLSearchParams, Blob,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    readableError: value => value,
    api: async (path, options) => {
      calls.push({ path, options });
      return respond(path, calls.length);
    },
  });
  await tick();
  return {
    calls, navigations, element,
    setActivation: value => { activation = value; },
    click: selector => element(selector).listeners.click({ preventDefault() {} }),
  };
}

test("reopening from the original login page resolves a fresh session after the window closes", async () => {
  const page = await loginPage((_, index) => desktop(["a", "b", "c"][index - 1]));
  assert.match(page.element("#loginNative").href, new RegExp("a".repeat(64)));
  await page.click("#loginNative");
  await page.click("#loginNative");
  assert.equal(page.calls.length, 3);
  assert.ok(page.calls.every(call => call.path === "/api/accounts/test-account/open" && call.options.method === "POST"));
  assert.equal(page.navigations.length, 2);
  assert.match(page.navigations[0], new RegExp("b".repeat(64)));
  assert.match(page.navigations[1], new RegExp("c".repeat(64)));
  assert.equal(page.element("#loginActions").hidden, false);
});

test("repeated clicks while a new session starts cannot launch the old connection or duplicate the request", async () => {
  const pending = deferred();
  const page = await loginPage((_, index) => index === 1 ? desktop("a") : pending.promise);
  const opening = page.click("#loginNative");
  await page.click("#loginNative");
  assert.equal(page.calls.length, 2);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.element("#loginNative").href, undefined);
  pending.resolve(desktop("b"));
  await opening;
  assert.equal(page.navigations.length, 1);
  assert.match(page.navigations[0], new RegExp("b".repeat(64)));
});

test("a slow start that outlasts browser activation gives a visible next click", async () => {
  const page = await loginPage(() => desktop("b"));
  page.setActivation(false);
  await page.click("#loginNative");
  assert.equal(page.navigations.length, 0);
  assert.match(page.element("#loginStatus").textContent, /再点一次/);
  assert.equal(page.element("#loginActions").hidden, false);
  page.setActivation(true);
  await page.click("#loginNative");
  assert.equal(page.navigations.length, 1);
});

test("a failed reopen never falls back to an expired connection", async () => {
  const page = await loginPage((_, index) => {
    if (index > 1) throw new Error("PROFILE_IN_USE");
    return desktop("a");
  });
  await page.click("#loginNative");
  assert.equal(page.navigations.length, 0);
  assert.equal(page.element("#loginNative").href, undefined);
  assert.equal(page.element("#loginRetry").hidden, false);
  assert.match(page.element("#loginStatus").textContent, /PROFILE_IN_USE/);
});

test("closing is serialized with reopening and the same page can prepare another session afterwards", async () => {
  const pending = deferred();
  const page = await loginPage(path => path.endsWith("/close-login") ? pending.promise : desktop("a"));
  const closing = page.click("#loginFinish");
  await page.click("#loginNative");
  assert.equal(page.calls.length, 2);
  assert.equal(page.navigations.length, 0);
  pending.resolve({ ok: true });
  await closing;
  assert.equal(page.element("#loginActions").hidden, true);
  await page.click("#loginRetry");
  assert.equal(page.element("#loginActions").hidden, false);
});
