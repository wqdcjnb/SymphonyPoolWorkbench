import { state, $, api, toast } from "./shared.js";
import { renderAccounts, bindAccountControls } from "./accounts.js";
import { renderJobAccount, refreshJobsPage, bindJobControls } from "./jobs.js";
import { refreshEventsPage, bindEventControls } from "./events.js";
import { initRouter } from "./router.js";

async function refresh() {
  const payload = await api("/api/overview");
  Object.assign(state, payload);
  renderAccounts();
  renderJobAccount();
  await Promise.all([refreshJobsPage(), refreshEventsPage()]);
}

initRouter();
bindAccountControls(refresh);
bindJobControls(refresh);
bindEventControls();
$("#refreshButton").addEventListener("click", () => refresh()
  .then(() => toast("数据已刷新"))
  .catch((error) => toast(error.message, true)));

refresh().catch((error) => toast(`工作台加载失败：${error.message}`, true));
window.setInterval(() => {
  if (state.busyAccountIds.length || state.jobs.some((job) => job.status === "queued")) {
    refresh().catch(() => {});
  } else if (document.body.dataset.page === "jobs") {
    refreshJobsPage().catch(() => {});
  }
}, 5000);
