import { decodeString } from "micromark-util-decode-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const htmlLinkAttributes = new Set(["href", "src", "srcset"]);

/** CommonMark／GFMの構文木からlink、image、definition、HTML属性の参照先を列挙する。 */
export function markdownLinkTargets(markdown) {
  if (typeof markdown !== "string") throw new TypeError("markdown must be a string");
  const targets = [];
  visit(markdownParser.parse(markdown));
  return targets;

  function visit(node) {
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition")
      && typeof node.url === "string"
    ) {
      targets.push(node.url);
    } else if (node.type === "html" && typeof node.value === "string") {
      targets.push(...htmlLinkTargets(node.value));
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }
}

export function relativeMarkdownLinkTargets(markdown) {
  const targets = [];
  for (const raw of markdownLinkTargets(markdown)) {
    let target = raw.trim();
    if (
      target.length === 0
      || target === "..."
      || target.startsWith("#")
      || target.startsWith("/")
      || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)
    ) {
      continue;
    }
    target = target.split(/[?#]/u, 1)[0];
    if (target.length === 0) continue;
    try {
      targets.push(decodeURIComponent(target));
    } catch {
      throw new TypeError(`Markdown target has invalid percent encoding: ${target}`);
    }
  }
  return targets;
}

export function missingPackedMarkdownTargets({ markdownPath, markdown, packedPaths }) {
  if (typeof markdownPath !== "string" || typeof markdown !== "string") {
    throw new TypeError("markdownPath and markdown must be strings");
  }
  const paths = packedPaths instanceof Set ? packedPaths : new Set(packedPaths);
  const missing = [];
  for (const target of relativeMarkdownLinkTargets(markdown)) {
    const resolved = normalizePackedPath(markdownPath, target);
    const insidePackage = resolved !== ".." && !resolved.startsWith("../");
    const present = insidePackage && (
      paths.has(resolved) || [...paths].some((packedPath) => packedPath.startsWith(`${resolved}/`))
    );
    if (!present) missing.push({ target, resolved });
  }
  return missing;
}

/** HTML属性の境界を順に読み、quoted value内を別属性として解釈しない。 */
function htmlLinkTargets(html) {
  const targets = [];
  let index = 0;
  while (index < html.length) {
    const opening = html.indexOf("<", index);
    if (opening < 0) break;
    if (html.startsWith("<!--", opening)) {
      const closing = html.indexOf("-->", opening + 4);
      index = closing < 0 ? html.length : closing + 3;
      continue;
    }

    let cursor = opening + 1;
    if (html[cursor] === "/" || html[cursor] === "!" || html[cursor] === "?") {
      index = tagEnd(html, cursor + 1);
      continue;
    }
    if (!/[A-Za-z]/u.test(html[cursor] ?? "")) {
      index = opening + 1;
      continue;
    }
    while (/[A-Za-z0-9:-]/u.test(html[cursor] ?? "")) cursor += 1;

    while (cursor < html.length) {
      while (/\s/u.test(html[cursor] ?? "")) cursor += 1;
      if (html[cursor] === ">") {
        cursor += 1;
        break;
      }
      if (html[cursor] === "/" && html[cursor + 1] === ">") {
        cursor += 2;
        break;
      }

      const nameStart = cursor;
      while (!/[\s=/>]/u.test(html[cursor] ?? "")) cursor += 1;
      const name = html.slice(nameStart, cursor).toLowerCase();
      if (name.length === 0) {
        cursor += 1;
        continue;
      }
      while (/\s/u.test(html[cursor] ?? "")) cursor += 1;
      if (html[cursor] !== "=") continue;
      cursor += 1;
      while (/\s/u.test(html[cursor] ?? "")) cursor += 1;

      let value;
      const quote = html[cursor];
      if (quote === "\"" || quote === "'") {
        const valueStart = ++cursor;
        while (cursor < html.length && html[cursor] !== quote) cursor += 1;
        if (cursor >= html.length) break;
        value = html.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (!/[\s>]/u.test(html[cursor] ?? "")) cursor += 1;
        value = html.slice(valueStart, cursor).replace(/\/$/u, "");
      }

      if (!htmlLinkAttributes.has(name)) continue;
      const decoded = decodeString(value);
      if (name === "srcset") targets.push(...srcsetTargets(decoded));
      else targets.push(decoded);
    }
    index = Math.max(cursor, opening + 1);
  }
  return targets;
}

/** WHATWGの候補収集に合わせ、URL内部のcommaを保ち、末尾commaだけを区切りとする。 */
function srcsetTargets(value) {
  const targets = [];
  let index = 0;
  while (index < value.length) {
    while (/[\s,]/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;

    const start = index;
    while (index < value.length && !/\s/u.test(value[index])) index += 1;
    let url = value.slice(start, index);
    let trailingComma = false;
    while (url.endsWith(",")) {
      trailingComma = true;
      url = url.slice(0, -1);
    }
    if (url.length > 0) targets.push(url);
    if (trailingComma) continue;

    let parentheses = 0;
    while (index < value.length) {
      if (value[index] === "(") parentheses += 1;
      else if (value[index] === ")" && parentheses > 0) parentheses -= 1;
      else if (value[index] === "," && parentheses === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return targets;
}

function tagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    if (quote !== null) {
      if (html[index] === quote) quote = null;
    } else if (html[index] === "\"" || html[index] === "'") {
      quote = html[index];
    } else if (html[index] === ">") {
      return index + 1;
    }
  }
  return html.length;
}

function normalizePackedPath(markdownPath, target) {
  const segments = `${markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1)}${target}`.split("/");
  const normalized = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && normalized.length > 0 && normalized.at(-1) !== "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/").replace(/\/$/u, "");
}
