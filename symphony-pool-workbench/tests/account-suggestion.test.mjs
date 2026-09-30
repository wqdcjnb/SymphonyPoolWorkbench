import assert from "node:assert/strict";
import test from "node:test";
import { suggestAccount } from "../public/js/account-suggestion.js";

test("new account suggestions continue each platform's highest number", () => {
  const accounts = [
    { id: "xzkj-pc-01-symphony-01", label: "Custom name" },
    { id: "xzkj-pc-01-symphony-02", label: "Symphony TK 二号账号" },
    { id: "xzkj-pc-01-doubao-01", label: "豆包一号账号" },
    { id: "xzkj-pc-01-doubao-02", label: "Another name" },
    { id: "xzkj-pc-02-doubao-07", label: "Other computer" },
  ];
  assert.deepEqual(suggestAccount(accounts, "tiktok", "xzkj-pc-01"), {
    id: "xzkj-pc-01-symphony-03", label: "Symphony TK 三号账号",
  });
  assert.deepEqual(suggestAccount(accounts, "doubao", "xzkj-pc-01"), {
    id: "xzkj-pc-01-doubao-03", label: "豆包三号账号",
  });
  assert.deepEqual(suggestAccount(accounts, "doubao", "xzkj-pc-02"), {
    id: "xzkj-pc-02-doubao-08", label: "豆包八号账号",
  });
});

test("suggestions advance past gaps and retain two-digit account suffixes", () => {
  const accounts = [
    { id: "pc-doubao-01" },
    { id: "pc-doubao-09" },
    { id: "pc-doubao-note" },
  ];
  assert.deepEqual(suggestAccount(accounts, "doubao", "pc"), {
    id: "pc-doubao-10", label: "豆包十号账号",
  });
  assert.deepEqual(suggestAccount([], "tiktok", "pc"), {
    id: "pc-symphony-01", label: "Symphony TK 一号账号",
  });
});
