import { state, $, api, escapeHtml, formatTime, toast } from "./shared.js";

let selectedEventPage = 1;
let eventPageRequestId = 0;

function eventRows(events) {
  return events.map((event) => `
    <div class="event-item"><span class="event-dot"></span><div><div class="event-title"><strong>${escapeHtml(event.message)}</strong><time>${escapeHtml(formatTime(event.createdAt))}</time></div><p>${escapeHtml(event.accountLabel || event.accountId || event.jobId || "系统")}</p></div></div>
  `).join("") || '<div class="empty">暂无审计事件。</div>';
}

function renderEventsPage() {
  const { events, page, pageSize, total, totalPages } = state.eventPage;
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  $("#eventRange").textContent = `第 ${first}–${last} 条，共 ${total} 条`;
  $("#eventPageInfo").textContent = `第 ${page} / ${totalPages} 页`;
  $("#eventPrevPage").disabled = page <= 1;
  $("#eventNextPage").disabled = page >= totalPages;
  $("#eventList").innerHTML = eventRows(events);
}

export async function refreshEventsPage() {
  const requestId = ++eventPageRequestId;
  const page = await api(`/api/events?page=${selectedEventPage}&pageSize=10`);
  if (requestId !== eventPageRequestId) return;
  state.eventPage = page;
  selectedEventPage = page.page;
  renderEventsPage();
}

export function bindEventControls() {
  $("#eventPrevPage").addEventListener("click", () => {
    if (selectedEventPage <= 1) return;
    selectedEventPage -= 1;
    refreshEventsPage().catch((error) => toast(`翻页失败：${error.message}`, true));
  });
  $("#eventNextPage").addEventListener("click", () => {
    if (selectedEventPage >= state.eventPage.totalPages) return;
    selectedEventPage += 1;
    refreshEventsPage().catch((error) => toast(`翻页失败：${error.message}`, true));
  });
}
