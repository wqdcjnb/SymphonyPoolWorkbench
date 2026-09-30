const pageTitles = {
  accounts: "账号池",
  jobs: "工作台",
  events: "审计事件",
  "api-docs": "API 文档",
};

function pageFromPath(pathname) {
  const page = pathname.replace(/^\/+|\/+$/g, "");
  return Object.hasOwn(pageTitles, page) ? page : "jobs";
}

function activate(page) {
  document.querySelectorAll(".panel-section").forEach((section) => {
    section.classList.toggle("active-section", section.id === page);
  });
  document.querySelectorAll(".nav-item[data-route]").forEach((link) => {
    const active = link.dataset.route === page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.body.dataset.page = page;
  document.title = `${pageTitles[page]} · Symphony 号池工作台`;
}

export function initRouter() {
  activate(pageFromPath(window.location.pathname));
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey || link.origin !== window.location.origin) return;
    event.preventDefault();
    const page = link.dataset.route;
    if (`${window.location.pathname}${window.location.search}` !== `/${page}`) {
      window.history.pushState({ page }, "", `/${page}`);
    }
    activate(page);
    window.scrollTo(0, 0);
  });
  window.addEventListener("popstate", () => activate(pageFromPath(window.location.pathname)));
}
