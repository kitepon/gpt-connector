import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { stringify } from "smol-toml";

type Addition = { path: string[]; value: unknown };
const prefixOf = (prefix: readonly (string | number)[], path: readonly string[]) => prefix.every((part, index) => path[index] === part);
const keyText = (path: readonly string[]) => path.map((part) => /^[\w-]+$/u.test(part) ? part : JSON.stringify(part)).join(".");

/** 不足keyだけを構文上の位置へ挿入し、既存値・コメント・整形を保持する。 */
export function addTomlValues(source: string, additions: readonly Addition[], newServer = false): string {
  let text = source;
  for (const addition of additions) {
    const ast = parseTOML(text);
    const tables = ast.body[0].body.filter((node): node is AST.TOMLTable => node.type === "TOMLTable");
    const inline: { path: string[]; node: AST.TOMLInlineTable }[] = [];
    const visit = (nodes: readonly AST.TOMLKeyValue[], prefix: string[]) => {
      for (const node of nodes) {
        const path = [...prefix, ...getStaticTOMLValue(node.key)];
        if (node.value.type === "TOMLInlineTable") {
          inline.push({ path, node: node.value });
          visit(node.value.body, path);
        }
      }
    };
    visit(ast.body[0].body.filter((node): node is AST.TOMLKeyValue => node.type === "TOMLKeyValue"), []);
    for (const table of tables) if (table.resolvedKey.every((part) => typeof part === "string")) visit(table.body, table.resolvedKey as string[]);
    const inlineParent = inline.filter((item) => prefixOf(item.path, addition.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const value = stringify({ value: addition.value }, { numbersAsFloat: true }).trim().slice("value = ".length);
    if (newServer && !inlineParent) {
      text += `${text && !text.endsWith("\n") ? "\n" : ""}[${keyText(addition.path.slice(0, -1))}]\n${keyText(addition.path.slice(-1))} = ${value}\n`;
      newServer = false;
      continue;
    }
    newServer = false;
    if (inlineParent) {
      const at = inlineParent.node.range[1] - 1;
      const previousToken = ast.tokens.filter((token) => token.range[1] <= at).at(-1);
      const separator = inlineParent.node.body.length > 0 && previousToken?.value !== "," ? ", " : " ";
      const inserted = `${separator}${keyText(addition.path.slice(inlineParent.path.length))} = ${value} `;
      text = text.slice(0, at) + inserted + text.slice(at);
    } else {
      const parent = tables.filter((table) => table.kind === "standard" && prefixOf(table.resolvedKey, addition.path)).sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
      const following = parent ? tables[tables.indexOf(parent) + 1] : tables[0];
      const at = following?.range[0] ?? text.length;
      const inserted = `${at > 0 && text[at - 1] !== "\n" ? "\n" : ""}${keyText(addition.path.slice(parent?.resolvedKey.length ?? 0))} = ${value}\n`;
      text = text.slice(0, at) + inserted + text.slice(at);
    }
  }
  return text;
}
