import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderApiDocumentation } from "./api-docs.mjs";

const viewsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "views");
const pageTitles = {
  accounts: "账号池",
  jobs: "工作台",
  events: "审计事件",
  "api-docs": "API 文档",
};
const layout = fs.readFileSync(path.join(viewsRoot, "layout.html"), "utf8");
const sections = Object.fromEntries(Object.keys(pageTitles).map((page) => [
  page,
  fs.readFileSync(path.join(viewsRoot, "pages", `${page}.html`), "utf8"),
]));

export function pageForPath(pathname) {
  const route = pathname.replace(/\/+$/, "") || "/";
  if (route === "/" || route === "/index.html") return "jobs";
  const page = route.slice(1);
  return Object.hasOwn(pageTitles, page) ? page : null;
}

export function renderPage(pathname, apiBaseUrl) {
  const page = pageForPath(pathname);
  if (!page) return null;

  const content = Object.entries(sections).map(([name, template]) => {
    const html = template.replace("{{apiDocumentation}}", name === "api-docs"
      ? renderApiDocumentation({ baseUrl: apiBaseUrl }) : "");
    return name === page ? html.replace('class="panel-section"', 'class="panel-section active-section"') : html;
  }).join("\n");

  return layout
    .replace("{{sections}}", content)
    .replace("{{page}}", page)
    .replace("{{title}}", pageTitles[page])
    .replace(`class="nav-item" href="/${page}"`, `class="nav-item active" aria-current="page" href="/${page}"`);
}
