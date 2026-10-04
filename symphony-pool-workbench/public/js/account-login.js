import { api, readableError } from "./shared.js";

const accountId = decodeURIComponent(window.location.pathname.split("/")[2] || "");
const status = document.querySelector("#loginStatus");
const retry = document.querySelector("#loginRetry");
const actions = document.querySelector("#loginActions");
const native = document.querySelector("#loginNative");
const download = document.querySelector("#loginDownload");
const finish = document.querySelector("#loginFinish");
let fileUrl;
let busy = false;
document.querySelector("#loginAccount").textContent = `账号：${accountId}`;
document.title = `${accountId} · Xpra 登录`;

async function openLogin() {
  if (busy) return null;
  busy = true;
  retry.hidden = true;
  actions.hidden = true;
  native.removeAttribute("href");
  download.removeAttribute("href");
  status.textContent = "正在准备此账号的 Chrome 窗口…";
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/open`, { method: "POST", body: "{}" });
    if (!result.desktop) {
      status.textContent = "此账号的浏览器窗口已打开，可关闭本标签页。";
      return;
    }
    const { protocol, port, token, accountId: desktopAccount } = result.desktop;
    if (protocol !== "xpra" || desktopAccount !== accountId || !Number.isInteger(port) || port < 1 || port > 65535
      || !/^[a-f0-9]{64}$/.test(token)) throw new Error("PROFILE_DESKTOP_FAILED");
    const transport = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname;
    const clientOptions = new URLSearchParams({ splash: "no", opengl: "no", clipboard: "yes",
      "clipboard-direction": "both", notifications: "no", title: "@title@ - @session-name@" });
    native.href = `xpra+${transport}://${host}:${port}/${token}?${clientOptions}`;
    const config = ["# Symphony account login", `mode=${transport}`, `host=${host}`, `port=${port}`,
      `path=${token}`, "autoconnect=true", "clipboard=yes", "clipboard-direction=both",
      "splash=no", "opengl=no", "video-decoders=openh264", "audio=no",
      "speaker=disabled", "microphone=disabled", "webcam=no", "printing=no", "file-transfer=no",
      "open-files=no", "open-url=no", "notifications=no", "title=@title@ — @session-name@", ""].join("\n");
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(new Blob([config], { type: "application/x-xpra" }));
    download.href = fileUrl;
    download.download = `${accountId}.xpra`;
    actions.hidden = false;
    finish.disabled = false;
    status.textContent = "窗口已准备好。点击“直接打开 Xpra”，在独立 Chrome 窗口中登录。";
    return native.href;
  } catch (error) {
    status.textContent = `打开失败：${readableError(error.message)}`;
    retry.hidden = false;
    return null;
  } finally {
    busy = false;
  }
}
native.addEventListener("click", async (event) => {
  event.preventDefault();
  // Closing Chrome also ends its Xpra session. Resolve a live connection on
  // every click; the link prepared when this page loaded may have expired.
  const connection = await openLogin();
  if (!connection) return;
  // A slow server start can outlast Chrome's user activation. Keep a ready,
  // explicit next click instead of silently attempting a blocked app launch.
  if (navigator.userActivation?.isActive === false) {
    status.textContent = "窗口已重新准备好。请再点一次“直接打开 Xpra”进入。";
    return;
  }
  status.textContent = "正在请求打开 Xpra；如浏览器询问是否打开应用，请选择打开。";
  window.location.assign(connection);
});
finish.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  finish.disabled = true;
  status.textContent = "正在保存浏览器档案并结束登录窗口…";
  try {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/close-login`, { method: "POST", body: "{}" });
    actions.hidden = true;
    retry.hidden = false;
    status.textContent = "登录窗口已结束，账号档案已保留。返回账号池，点击“只读验收”。";
  } catch (error) {
    status.textContent = `结束失败：${readableError(error.message)}`;
  } finally {
    busy = false;
    finish.disabled = false;
  }
});
retry.addEventListener("click", openLogin);
openLogin();
