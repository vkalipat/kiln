import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)));
const html = (path: string) => extname(path) === ".md"
  ? Bun.markdown.html(readFileSync(path, "utf8"), { headings: { ids: true } }) : readFileSync(path, "utf8");

export function inspectDocumentation(root: string, publishedFiles: string[]) {
  root = resolve(root);
  const published = new Set(publishedFiles);
  const documents = publishedFiles.filter(path => /\.(md|html)$/.test(path)
    && (path === "README.md" || /^(docs|site|plugins)\//.test(path)) && existsSync(resolve(root, path)));
  const problems: string[] = [], external = new Set<string>();
  const rendered = new Map<string, string>();
  let localLinks = 0;
  const render = (path: string) => {
    if (!rendered.has(path)) rendered.set(path, html(resolve(root, path)).replace(/<!--[\s\S]*?-->/g, ""));
    return rendered.get(path)!;
  };
  for (const source of documents) {
    for (const match of render(source).matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gis)) {
      const href = decode(match[2]!);
      if (!href || /^(mailto:|tel:|data:)/i.test(href)) continue;
      let target = href;
      const owned = href.match(/^https:\/\/(?:github\.com\/vkalipat\/kiln\/(?:blob|tree)\/main|raw\.githubusercontent\.com\/vkalipat\/kiln\/main)\/(.*)$/);
      if (owned) target = "/" + owned[1];
      else if (/^https?:\/\//i.test(href)) { external.add(href); continue; }
      else if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) {
        problems.push(`${source}: unsupported link ${href}`); continue;
      }
      localLinks++;
      try {
        const hash = target.indexOf("#");
        const fragment = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1));
        const pathname = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split("?")[0]!);
        const destination = pathname ? resolve(pathname.startsWith("/") ? root : dirname(resolve(root, source)), pathname.replace(/^\//, "")) : resolve(root, source);
        let key = relative(root, destination);
        if (key.startsWith("../") || !existsSync(destination)) { problems.push(`${source}: missing target ${href}`); continue; }
        const directory = statSync(destination).isDirectory();
        if (!(directory ? [...published].some(path => path.startsWith(key + "/")) : published.has(key))) {
          problems.push(`${source}: target is not published ${href}`); continue;
        }
        if (!fragment) continue;
        if (directory) {
          key += "/README.md";
          if (!published.has(key)) { problems.push(`${source}: no document for fragment ${href}`); continue; }
        }
        if (/\.(md|html)$/.test(key)) {
          const ids = new Set([...render(key).matchAll(/\b(?:id|name)\s*=\s*(["'])(.*?)\1/gis)].map(item => decode(item[2]!)));
          if (!ids.has(fragment) && !ids.has(fragment.replace(/^user-content-/, ""))) problems.push(`${source}: missing anchor ${href}`);
        } else if (!/^L\d+(?:-L?\d+)?$/.test(fragment)) problems.push(`${source}: unsupported file fragment ${href}`);
      } catch { problems.push(`${source}: invalid link ${href}`); }
    }
  }
  return { documents: documents.length, localLinks, externalLinks: [...external].sort(), problems };
}

export async function inspectExternalLinks(links: string[]) {
  const results: Array<{ url: string; status: number | null; state: "ok" | "broken" | "unverified" }> = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < links.length) {
      const url = links[cursor++]!;
      try {
        // Documentation URLs only. Examples for local services are not public link checks.
        const parsed = new URL(url);
        if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
          results.push({ url, status: null, state: "unverified" }); continue;
        }
        let response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000), redirect: "follow" });
        if ([403, 405, 501].includes(response.status)) {
          await response.body?.cancel();
          response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "follow" });
        }
        await response.body?.cancel();
        results.push({ url, status: response.status, state: response.ok ? "ok" : [404, 410].includes(response.status) ? "broken" : "unverified" });
      } catch { results.push({ url, status: null, state: "unverified" }); }
    }
  }));
  return results.sort((a, b) => a.url.localeCompare(b.url));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (files.exitCode !== 0) throw new Error("Documentation checks require a Git checkout");
  const report = inspectDocumentation(root, files.stdout.toString().split("\0").filter(Boolean));
  const external = process.argv.includes("--external") ? await inspectExternalLinks(report.externalLinks) : undefined;
  console.log(JSON.stringify({ ...report, ...(external ? { external } : {}) }, null, 2));
  if (report.problems.length || external?.some(result => result.state === "broken")) process.exitCode = 1;
}
