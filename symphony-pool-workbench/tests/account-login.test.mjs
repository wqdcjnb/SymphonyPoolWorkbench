import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {webcrypto} from 'node:crypto';

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

async function loginPage(respond, location = {}, pendingJobs = [], identity = {loginMethod:'cookie',cookieFingerprint:'fixture-id'}) {
  const elements = new Map();
  const calls = [], navigations = [], files = [], copies = [];
  let activation = true;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", hidden: false, disabled: false, listeners: {}, href: "#",
      addEventListener(name, listener) { this.listeners[name] = listener; },
      removeAttribute(name) { delete this[name]; },
      replaceChildren(){this.children=[];},append(child){this.children.push(child);},
    });
    return elements.get(selector);
  };
  vm.runInNewContext(source, {
    document: { querySelector: element,createElement:()=>({}) },
    window: { location: {
      pathname: "/accounts/test-account/login", protocol: "http:", hostname: "127.0.0.1",
      ...location,
      assign: connection => navigations.push(connection),
    },localStorage:{getItem:()=>null,setItem:()=>{}},setTimeout(){} },
    navigator: { userActivation: { get isActive() { return activation; } },clipboard:{writeText:async text=>copies.push(text)} },
    URLSearchParams, Blob,crypto:webcrypto,Uint8Array,
    URL: { createObjectURL: blob => { files.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    readableError: value => value,
    api: async (path, options) => {
      if (path.endsWith('/pending-verification')) return {jobs:pendingJobs};
      if (path.startsWith('/api/pool/identity/')) return identity;
      if (path==='/api/browser-sessions')return {managed:true,accounts:[{id:'test-account',label:'Test',local:true,running:true,resident:true}]};
      calls.push({ path, options });
      return respond(path, calls.length);
    },
  });
  await tick();
  return {
    calls, navigations, files, element, copies,
    setActivation: value => { activation = value; },
    click: selector => (element(selector).listeners.click||element(selector).onclick)({ preventDefault() {} }),
    change: (selector,value)=>{element(selector).value=value;return element(selector).listeners.change();},
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

test("verified task recovery keeps the window on challenge and reports actual job progress after resume", async () => {
  let challenged=true;
  const page=await loginPage(path=>{
    if(path.endsWith('/open'))return desktop('a');
    if(path.endsWith('/resume-after-verification')) {
      if(challenged)throw new Error('DOLA_HUMAN_VERIFICATION_REQUIRED');
      return {job:{status:'queued'}};
    }
    return {job:{status:'success'}};
  },{},[{id:'job-test',status:'reconciling'}]);
  assert.equal(page.element('#loginRecovery').hidden,false);
  assert.equal(page.element('#loginFinish').hidden,true);
  await page.click('#loginResume');
  assert.match(page.element('#recoveryStatus').textContent,/尚未恢复/);
  assert.equal(page.element('#loginActions').hidden,false);
  assert.equal(page.calls.filter(c=>c.path.endsWith('/close-login')).length,0);
  challenged=false;
  await page.click('#loginResume');
  assert.match(page.element('#recoveryStatus').textContent,/视频已保存/);
  assert.equal(page.element('#loginActions').hidden,true);
  assert.equal(page.element('#loginResume').hidden,true);
});

test('a resubmitted original request shows submission progress instead of claiming collection',async()=>{
  const page=await loginPage(path=>{
    if(path.endsWith('/open'))return desktop('a');
    if(path.endsWith('/resume-after-verification'))return {resubmitted:true,platformState:'resubmitting'};
    return {job:{status:'submitting',collectOnly:0}};
  },{},[{id:'job-test',status:'reconciling',errorCode:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'}]);
  await page.click('#loginResume');
  assert.match(page.element('#loginStatus').textContent,/验证已通过.*原请求已补提交排队/);
  assert.match(page.element('#recoveryStatus').textContent,/正在向平台提交原请求/);
  assert.equal(page.element('#loginResume').hidden,true);
});

test('a verified but unacknowledged task does not keep telling the operator to solve CAPTCHA',async()=>{
  const page=await loginPage(path=>{
    if(path.endsWith('/open'))return desktop('a');
    if(path.endsWith('/resume-after-verification'))return {platformState:'pending'};
    return {job:{status:'reconciling',errorCode:'DOUBAO_RESPONSE_PENDING'}};
  },{},[{id:'job-test',status:'reconciling',errorCode:'DOUBAO_VERIFIED_TASK_NOT_FOUND'}]);
  assert.doesNotMatch(page.element('#recoveryStatus').textContent,/请完成此账号的验证码/);
  await page.click('#loginResume');
  assert.match(page.element('#loginStatus').textContent,/验证已通过/);
  assert.match(page.element('#recoveryStatus').textContent,/DOUBAO_RESPONSE_PENDING/);
  assert.equal(page.element('#loginResume').hidden,false);
});

test("public HTTPS login uses the site's WSS endpoint in both the link and connection file", async () => {
  const page = await loginPage(() => desktop("a"), { protocol: "https:", hostname: "192.0.2.10", port: "" });
  assert.ok(page.element("#loginNative").href.startsWith(`xpra+wss://192.0.2.10:443/xpra/${"a".repeat(64)}?`));
  const file = await page.files[0].text();
  assert.match(file, /^mode=wss$/m);
  assert.match(file, /^port=443$/m);
  assert.match(file, new RegExp(`^path=xpra/${"a".repeat(64)}$`, "m"));
  assert.doesNotMatch(file, /6081/);
});

test('viewer close uses the connection file instead of an option rejected by the URL parser',async()=>{
  for(const location of [{},{protocol:'https:',hostname:'192.0.2.10',port:''}]){
    const page=await loginPage(()=>desktop('a'),location);
    const query=new URLSearchParams(page.element('#loginNative').href.split('?')[1]);
    assert.equal(query.has('window-close'),false);
    assert.match(await page.files[0].text(),/^window-close=disconnect$/m);
  }
});

test("HTTPS custom ports and the original SSH desktop tunnel both remain usable", async () => {
  const secure = await loginPage(() => desktop("a"), { protocol: "https:", hostname: "192.0.2.10", port: "9443" });
  assert.ok(secure.element("#loginNative").href.startsWith("xpra+wss://192.0.2.10:9443/xpra/"));
  const tunnel = await loginPage(() => desktop("b"), { port: "8790" });
  assert.ok(tunnel.element("#loginNative").href.startsWith(`xpra+ws://127.0.0.1:6081/${"b".repeat(64)}?`));
  assert.match(await tunnel.files[0].text(), /^port=6081$/m);
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

test("finishing login is serialized with reopening and keeps the resident browser", async () => {
  const pending = deferred();
  const page = await loginPage(path => path.endsWith("/verify") ? pending.promise : desktop("a"));
  const closing = page.click("#loginFinish");
  await page.click("#loginNative");
  assert.equal(page.calls.length, 2);
  assert.equal(page.navigations.length, 0);
  pending.resolve({ result:{ok:true,loggedIn:true} });
  await closing;
  assert.equal(page.element("#loginActions").hidden, false);
  assert.equal(page.calls.some(call=>call.path.endsWith('/close-login')),false);
  assert.match(page.element('#loginStatus').textContent,/后台运行/);
  await page.click("#loginRetry");
  assert.equal(page.element("#loginActions").hidden, false);
});

test('switching accounts detaches the selected viewer and navigates within the same page without closing a browser',async()=>{
  const page=await loginPage(()=>desktop('a'));
  await page.change('#loginAccountPicker','another');
  assert.equal(page.calls.at(-1).path,'/api/browser-viewer/detach');
  const viewer=JSON.parse(page.calls[0].options.body).viewerId;
  assert.match(viewer,/^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(page.calls.at(-1).options.body).viewerId,viewer);
  assert.equal(page.navigations.at(-1),'/accounts/another/login');
  assert.equal(page.calls.some(c=>c.path.endsWith('/close-login')),false);
});

test('hiding the viewer disconnects display only',async()=>{
  const page=await loginPage(()=>desktop('a'));
  await page.click('#loginDetach');
  assert.equal(page.calls.at(-1).path,'/api/browser-viewer/detach');
  assert.match(page.element('#loginStatus').textContent,/后台浏览器继续运行/);
  assert.equal(page.calls.some(c=>c.path.endsWith('/close-login')),false);
});

test('queued phone login shows the saved number and completes its matching login record',async()=>{
  const page=await loginPage(path=>path.endsWith('/finish')?{ok:true}:desktop('a'),{search:'?loginItem=queued-id'},[],{loginMethod:'phone_sms',identifier:'13800000000'});
  assert.match(page.element('#loginIdentity').textContent,/13800000000/);
  assert.equal(page.element('#copyLoginPhone').hidden,false);
  await page.click('#copyLoginPhone');assert.deepEqual(page.copies,['13800000000']);
  await page.click('#loginFinish');const finished=page.calls.find(c=>c.path==='/api/pool/login/finish');
  assert.deepEqual(JSON.parse(finished.options.body),{id:'queued-id',accountId:'test-account'});
  assert.equal(page.calls.some(c=>c.path.endsWith('/close-login')),false);
  assert.match(page.element('#loginStatus').textContent,/登录验收完成/);
});
