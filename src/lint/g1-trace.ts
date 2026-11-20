import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthoringSourceAbsolutePath, resolveDesignRoot } from "../shared/design-root.ts";
import { analyzeConsumerG1Trace } from "./consumer-trace.ts";
import type { LintResult } from "./lint-result.ts";

export interface G1TraceDocs {
  business: string;
  functional: string;
  screen: string;
}

export interface G1TraceResult {
  orphanBusiness: string[];
  orphanScreen: string[];
  orphanP0Fr: string[];
  totals: {
    business: number;
    screen: number;
    p0Fr: number;
  };
}

export function loadG1TraceDocs(repoRoot: string = process.cwd()): G1TraceDocs {
  const readRequired = (path: string): string => {
    const absolute = resolveAuthoringSourceAbsolutePath(repoRoot, path);
    if (!existsSync(absolute)) throw new Error(`required doc not created: ${path}`);
    return readFileSync(absolute, "utf8");
  };
  return {
    business: readRequired("docs/design/harness/L1-requirements/business-requirements.md"),
    functional: readRequired("docs/design/harness/L1-requirements/functional-requirements.md"),
    screen: readRequired("docs/design/harness/L1-requirements/screen-requirements.md"),
  };
}

function section(content: string, start: RegExp, end: RegExp): string {
  const m = content.match(start);
  if (!m || m.index === undefined) return "";
  const rest = content.slice(m.index + m[0].length);
  const e = rest.search(end);
  return e < 0 ? rest : rest.slice(0, e);
}

function ids(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(pattern)) out.add(m[1]);
  return out;
}

function screenIds(text: string): Set<string> {
  return ids(text, /\b((?:PM|HM|GD)-\d{2})\b/g);
}

export function extractG1BusinessIds(business: string): Set<string> {
  const out = new Set<string>();
  for (const line of business.split(/\r?\n/)) {
    const firstCell = line.match(
      /^[ \t]*\|[ \t]*(?:\*\*((?:BR|UX)-\d{2})\*\*|((?:BR|UX)-\d{2}))[ \t]*\|/,
    );
    const legacyIdCell = line.match(/^[ \t]*\|[ \t]*\*\*ID\*\*[ \t]*\|[ \t]*(BR-\d{2})[ \t]*\|/);
    const id = firstCell?.[1] ?? firstCell?.[2] ?? legacyIdCell?.[1];
    if (id) out.add(id);
  }
  return out;
}

export function extractG1ScreenIds(screen: string): Set<string> {
  const overview = section(screen, /^##\s*§1\b[^\n]*\n/m, /^##\s*§2\b/m);
  return screenIds(overview);
}

export function extractG1P0FrIds(functional: string): Set<string> {
  const out = new Set<string>();
  for (const line of functional.split(/\r?\n/)) {
    const id = line.match(/\|\s*\*\*(FR-L1-\d{2})\*\*\s*\|/)?.[1];
    if (id && /\|\s*P0\s*\|/.test(line)) out.add(id);
  }
  return out;
}

export function extractG1BusinessTrace(screen: string): Map<string, Set<string>> {
  const trace = new Map<string, Set<string>>();
  const allScreens = extractG1ScreenIds(screen);
  const r1 = section(screen, /^###\s*§5\.1\b[^\n]*\n/m, /^###\s*§5\.3\b/m);
  for (const line of r1.split(/\r?\n/)) {
    const firstCell = line.match(
      /^[^\S\r\n]*\|[^\S\r\n]*(?:\*\*((?:BR|UX)-\d{2})\*\*|((?:BR|UX)-\d{2}))[^\S\r\n]*\|/,
    );
    const id = firstCell?.[1] ?? firstCell?.[2];
    if (id) trace.set(id, line.includes("全画面") ? new Set(allScreens) : screenIds(line));
  }
  return trace;
}

export function extractG1ScreenTrace(screen: string): Map<string, Set<string>> {
  const trace = new Map<string, Set<string>>();
  const r2 = section(screen, /^###\s*§5\.5\b[^\n]*\n/m, /^###\s*§5\.6\b/m);
  for (const line of r2.split(/\r?\n/)) {
    const id = line.match(/\|\s*\*\*((?:PM|HM|GD)-\d{2})\*\*\s*\|/)?.[1];
    if (!id) continue;
    const refs = ids(line, /\b((?:BR|UX|FR-L1)-\d{2})\b/g);
    trace.set(id, refs);
  }
  return trace;
}

export function extractG1P0FrTrace(screen: string): Map<string, Set<string>> {
  const trace = new Map<string, Set<string>>();
  const r3 = section(screen, /^###\s*§5\.3\b[^\n]*\n/m, /^###\s*§5\.4\b/m);
  for (const line of r3.split(/\r?\n/)) {
    const id = line.match(/\|\s*\*\*(FR-L1-\d{2})\*\*/)?.[1];
    if (id) trace.set(id, screenIds(line));
  }
  return trace;
}

export function analyzeG1Trace(docs: G1TraceDocs = loadG1TraceDocs()): G1TraceResult {
  const business = extractG1BusinessIds(docs.business);
  const screens = extractG1ScreenIds(docs.screen);
  const p0Fr = extractG1P0FrIds(docs.functional);
  const businessTrace = extractG1BusinessTrace(docs.screen);
  const screenTrace = extractG1ScreenTrace(docs.screen);
  const p0FrTrace = extractG1P0FrTrace(docs.screen);

  const orphanBusiness = [...business].filter((id) => (businessTrace.get(id)?.size ?? 0) === 0);
  const orphanScreen = [...screens].filter((id) => (screenTrace.get(id)?.size ?? 0) === 0);
  const orphanP0Fr = [...p0Fr].filter((id) => (p0FrTrace.get(id)?.size ?? 0) === 0);

  return {
    orphanBusiness,
    orphanScreen,
    orphanP0Fr,
    totals: {
      business: business.size,
      screen: screens.size,
      p0Fr: p0Fr.size,
    },
  };
}

export function g1TraceOk(result: G1TraceResult): boolean {
  return (
    result.orphanBusiness.length === 0 &&
    result.orphanScreen.length === 0 &&
    result.orphanP0Fr.length === 0
  );
}

export function g1TraceMessages(result: G1TraceResult): string[] {
  if (g1TraceOk(result)) {
    return [
      `g1-trace - OK (business=${result.totals.business}, screens=${result.totals.screen}, p0Fr=${result.totals.p0Fr})`,
    ];
  }
  const parts: string[] = [];
  if (result.orphanBusiness.length > 0)
    parts.push(`orphanBusiness=${result.orphanBusiness.join(",")}`);
  if (result.orphanScreen.length > 0) parts.push(`orphanScreen=${result.orphanScreen.join(",")}`);
  if (result.orphanP0Fr.length > 0) parts.push(`orphanP0Fr=${result.orphanP0Fr.join(",")}`);
  return [`g1-trace - violation: ${parts.join("; ")}`];
}

export function lintG1Trace(repoRoot: string): LintResult {
  if (resolveDesignRoot(repoRoot) !== "docs/design/harness") {
    const { ok, messages } = analyzeConsumerG1Trace((relativePath) => {
      const absolute = join(repoRoot, relativePath);
      return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    });
    return { ok, messages };
  }
  try {
    const result = analyzeG1Trace(loadG1TraceDocs(repoRoot));
    return { ok: g1TraceOk(result), messages: g1TraceMessages(result) };
  } catch (e) {
    return {
      ok: false,
      messages: [`g1-trace - violation: required docs could not be read (${String(e)})`],
    };
  }
}
