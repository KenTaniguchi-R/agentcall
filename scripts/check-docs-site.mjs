import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "docs/site");
const config = JSON.parse(readFileSync(join(site, "docs.json"), "utf8"));
const errors = [];

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function navigationPages(value) {
  if (Array.isArray(value)) return value.flatMap(navigationPages);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "pages" && Array.isArray(child)
    ? child.filter((page) => typeof page === "string")
    : navigationPages(child));
}

for (const page of navigationPages(config.navigation)) {
  if (page.includes("..") || page.startsWith("/")) errors.push(`navigation escapes docs/site: ${page}`);
  const target = join(site, `${page}.mdx`);
  try { statSync(target); } catch { errors.push(`navigation target does not exist: ${page}`); }
}

const mdxFiles = filesUnder(site).filter((path) => extname(path) === ".mdx");
const internalLink = /(?:href=["']|\]\()([^"')]+)(?:["']|\))/g;

function linksIn(source) {
  return [...source.matchAll(internalLink)].map((match) => match[1]);
}

const parserFixture = linksIn('[page](/guide#section) <Card href="/setup?mode=fast">');
if (parserFixture.join("\n") !== "/guide#section\n/setup?mode=fast") {
  throw new Error("internal-link parser does not capture fragment and query URLs");
}

for (const path of mdxFiles) {
  const source = readFileSync(path, "utf8");
  for (const rawLink of linksIn(source)) {
    if (!rawLink || /^(?:https?:|mailto:)/.test(rawLink)) continue;
    const link = rawLink.split(/[?#]/, 1)[0];
    if (!link) continue;
    if (link.includes("..") || link.includes("superpowers") || link.includes("2026-07-16-security-review")) {
      errors.push(`${relative(site, path)} exposes non-site documentation: ${link}`);
      continue;
    }
    const normalized = link.replace(/^\//, "");
    const candidates = [join(site, normalized), join(site, `${normalized}.mdx`), join(site, normalized, "index.mdx")];
    if (!candidates.some((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } })) {
      errors.push(`${relative(site, path)} has a broken internal link: ${link}`);
    }
  }
}

for (const generator of ["generate-docs-site-cli.mjs", "generate-docs-site-protocol.mjs"]) {
  try {
    execFileSync(process.execPath, [join(root, "scripts", generator), "--check"], { cwd: root });
  } catch {
    errors.push(`${generator} reports stale generated content; run pnpm docs:generate and commit it`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Validated ${mdxFiles.length} pages and ${navigationPages(config.navigation).length} navigation entries.`);
