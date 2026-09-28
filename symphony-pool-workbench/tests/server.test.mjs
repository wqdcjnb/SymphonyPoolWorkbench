import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchServer } from "../server.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function get(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
  });
}

test("malformed URLs and foreign hosts are rejected without stopping the server", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-http-test-"));
  const port = await freePort();
  const app = createWorkbenchServer({ port, databasePath: path.join(tempRoot, "test.sqlite") });
  try {
    await app.listen();
    const malformed = await get(port, "/%ZZ");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "INVALID_URL");

    const foreignHost = await get(port, "/api/overview", { Host: "example.invalid" });
    assert.equal(foreignHost.status, 403);
    assert.equal(foreignHost.body.error, "HOST_NOT_ALLOWED");

    const health = await get(port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.service, "symphony-pool-workbench");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("public listening addresses are rejected", () => {
  assert.throws(() => createWorkbenchServer({ host: "0.0.0.0" }), /LOCAL_HOST_REQUIRED/);
});
