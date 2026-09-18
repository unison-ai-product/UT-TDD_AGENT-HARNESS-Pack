import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ORACLE_ID = /(?<![A-Z0-9-])(?:U|IT|ST|P|M)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2,3}(?![A-Z0-9-])/g;
const TEST_CALLS = new Set(["describe", "it", "test"]);
const LABEL_MODIFIERS = new Set(["only", "skip", "todo"]);

export interface OracleCitationSite {
  id: string;
  path: string;
  line: number;
  kind: "static-test-label";
}

function skipString(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  if (text[start + 1] === "/") {
    const end = text.indexOf("\n", start + 2);
    return end < 0 ? text.length : end;
  }
  if (text[start + 1] === "*") {
    const end = text.indexOf("*/", start + 2);
    return end < 0 ? text.length : end + 2;
  }
  return start + 1;
}

function skipRegex(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (/[A-Za-z]/u.test(text[index] ?? "")) index += 1;
      return index;
    }
    if (char === "\n" || char === "\r") return start + 1;
  }
  return start + 1;
}

function startsRegex(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(text[index] ?? "")) index -= 1;
  if (index < 0) return true;
  if (/[([{,:;=!?&|+*%^~<>-]/u.test(text[index] ?? "")) return true;
  const prefix = text.slice(0, index + 1);
  return /\b(?:return|case|throw|else|do|yield|await)\s*$/u.test(prefix);
}

function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 1;
  let index = start + 1;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    if (char === "/" && startsRegex(text, index)) {
      index = skipRegex(text, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index, char);
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    index += 1;
  }
  return index;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  for (;;) {
    while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    return index;
  }
}

function readLiteral(text: string, start: number): { value: string; index: number } | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = skipString(text, start, quote);
  if (end > text.length || text[end - 1] !== quote) return null;
  const value = text.slice(start + 1, end - 1);
  if (quote === "`" && value.includes("${")) return null;
  return { value, index: start };
}

/** test call の chain を辿り、実行 label の最初の静的文字列だけを返す。 */
function readTestLabel(text: string, start: number): { value: string; index: number } | null {
  let cursor = skipWhitespace(text, start);
  for (;;) {
    if (text[cursor] === ".") {
      cursor = skipWhitespace(text, cursor + 1);
      const method = /^[A-Za-z_$][\w$]*/u.exec(text.slice(cursor));
      if (!method) return null;
      cursor = skipWhitespace(text, cursor + method[0].length);
      if (text[cursor] !== "(") return null;
      if (LABEL_MODIFIERS.has(method[0])) {
        return readLiteral(text, skipWhitespace(text, cursor + 1));
      }
      cursor = balancedEnd(text, cursor);
      cursor = skipWhitespace(text, cursor);
      continue;
    }
    if (text[cursor] !== "(") return null;
    const argument = skipWhitespace(text, cursor + 1);
    const direct = readLiteral(text, argument);
    if (direct) return direct;
    const chained = skipWhitespace(text, balancedEnd(text, cursor));
    if (text[chained] !== "(") return null;
    return readLiteral(text, skipWhitespace(text, chained + 1));
  }
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function scanTestLabels(text: string, relativePath: string): OracleCitationSite[] {
  const sites: OracleCitationSite[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    if (char === "/" && startsRegex(text, index)) {
      index = skipRegex(text, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index, char);
      continue;
    }
    if (/[A-Za-z_$]/u.test(char ?? "")) {
      const match = /^[A-Za-z_$][\w$]*/u.exec(text.slice(index));
      const name = match?.[0] ?? "";
      if (TEST_CALLS.has(name) && (index === 0 || !/[\w$.]/u.test(text[index - 1] ?? ""))) {
        const label = readTestLabel(text, index + name.length);
        if (label) {
          ORACLE_ID.lastIndex = 0;
          for (const match of label.value.matchAll(ORACLE_ID)) {
            sites.push({
              id: match[0],
              path: relativePath,
              line: lineAt(text, label.index),
              kind: "static-test-label",
            });
          }
        }
      }
      index += name.length;
      continue;
    }
    index += 1;
  }
  return sites;
}

/** tests の実行 label に限定した oracle citation を provenance 付きで収集する。 */
export function collectOracleCitationSites(repoRoot: string): OracleCitationSite[] {
  const sites: OracleCitationSite[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        const relativePath = full.slice(repoRoot.length + 1).replaceAll("\\", "/");
        sites.push(...scanTestLabels(readFileSync(full, "utf8"), relativePath));
      }
    }
  };
  walk(join(repoRoot, "tests"));
  return sites;
}
