import fs from "node:fs";

const root = new URL("../", import.meta.url);
const documents = new Map([
  ["/api-docs/partner-api.md", { file: "PARTNER_API.md", type: "text/markdown; charset=utf-8" }],
  ["/api-docs/openapi.json", { file: "docs/partner-openapi.json", type: "application/json; charset=utf-8" }],
  ["/api-docs/task-example.json", { file: "docs/examples/partner-task.json", type: "application/json; charset=utf-8" }],
]);
export function documentationFile(pathname) {
  const document = documents.get(pathname);
  return document ? { ...document, content: fs.readFileSync(new URL(document.file, root)),
    filename: document.file.split("/").at(-1) } : null;
}

const escape = (value) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const links = new Map([
  ["docs/partner-openapi.json", "/api-docs/openapi.json"],
  ["docs/examples/partner-task.json", "/api-docs/task-example.json"],
]);
function inline(value) {
  // Only the checked-in document is rendered; raw HTML and arbitrary link protocols stay escaped.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let output = "", end = 0;
  for (const match of value.matchAll(pattern)) {
    output += escape(value.slice(end, match.index));
    if (match[1] !== undefined) output += `<code>${escape(match[1])}</code>`;
    else if (match[2] !== undefined) output += `<strong>${escape(match[2])}</strong>`;
    else {
      const target = links.get(match[4]);
      output += target ? `<a href="${target}">${escape(match[3])}</a>` : escape(match[3]);
    }
    end = match.index + match[0].length;
  }
  return output + escape(value.slice(end));
}

export function renderApiDocumentation() {
  const lines = fs.readFileSync(new URL("PARTNER_API.md", root), "utf8").split(/\r?\n/);
  const content = [], headings = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      content.push(`<div class="api-doc-code"><span>${escape(language || "text")}</span><pre><code>${escape(code.join("\n"))}</code></pre></div>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) { i++; continue; }
      const id = `api-doc-section-${i}`;
      if (level === 2) headings.push(`<a href="/api-docs#${id}">${escape(heading[2])}</a>`);
      content.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
      i++; continue;
    }
    if (line.startsWith("|") && /^\|[\s:|\-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (row, tag) => row.trim().replace(/^\||\|$/g, "").split("|")
        .map((cell) => `<${tag}>${inline(cell.trim())}</${tag}>`).join("");
      const rows = []; i += 2;
      while (i < lines.length && lines[i].startsWith("|")) rows.push(`<tr>${cells(lines[i++], "td")}</tr>`);
      content.push(`<div class="api-doc-table"><table><thead><tr>${cells(line, "th")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }
    const list = /^(?:([-*])|(\d+)\.)\s+/.exec(line);
    if (list) {
      const ordered = Boolean(list[2]);
      const pattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(pattern, ""))}</li>`);
      content.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|\||[-*] |\d+\. )/.test(lines[i])) paragraph.push(lines[i++]);
    content.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return `<details class="api-doc-toc" open><summary>文档目录</summary><nav aria-label="API 文档目录">${headings.join("")}</nav></details>
    <article class="api-doc-body">${content.join("\n")}</article>`;
}
