import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface G1TraceDocs {
  business: string;
  functional: string;
  screen: string;
  plans: { file: string; content: string }[];
}

export interface G1TraceResult {
  orphanBusiness: string[];
  orphanScreen: string[];
  orphanP0Fr: string[];
  missingL3Requires: { file: string; missing: string[] }[];
  totals: {
    business: number;
    screen: number;
    p0Fr: number;
    l3Plans: number;
  };
}

const REQUIRED_L3_REQUIRES = [
  "PLAN-L1-01-business-requirements",
  "PLAN-L1-02-functional-requirements",
  "PLAN-L1-03-screen-requirements",
] as const;

export function loadG1TraceDocs(repoRoot: string = process.cwd()): G1TraceDocs {
  const plansDir = resolve(repoRoot, "docs/plans");
  const plans = readdirSync(plansDir)
    .filter((f) => /^PLAN-L3-\d+-.+\.md$/.test(f))
    .map((f) => ({
      file: join("docs", "plans", f),
      content: readFileSync(resolve(plansDir, f), "utf8"),
    }));
  return {
    business: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/business-requirements.md"),
      "utf8",
    ),
    functional: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/functional-requirements.md"),
      "utf8",
    ),
    screen: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/screen-requirements.md"),
      "utf8",
    ),
    plans,
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
  const out = ids(business, /\|\s*\*\*((?:BR|UX)-\d{2})\*\*\s*\|/g);
  for (const m of business.matchAll(/\|\s*\*\*ID\*\*\s*\|\s*(BR-\d{2})\s*\|/g)) {
    out.add(m[1]);
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
    const id = line.match(/\|\s*\*\*((?:BR|UX)-\d{2})\*\*\s*\|/)?.[1];
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
  const g1AwareL3Plans = docs.plans.filter(
    (doc) =>
      doc.content.includes("PLAN-L1-03-screen-requirements") ||
      doc.content.includes("related_l1_screen"),
  );
  const missingL3Requires = g1AwareL3Plans
    .map((doc) => ({
      file: doc.file,
      missing: REQUIRED_L3_REQUIRES.filter((id) => !doc.content.includes(id)),
    }))
    .filter((v) => v.missing.length > 0);

  return {
    orphanBusiness,
    orphanScreen,
    orphanP0Fr,
    missingL3Requires,
    totals: {
      business: business.size,
      screen: screens.size,
      p0Fr: p0Fr.size,
      l3Plans: g1AwareL3Plans.length,
    },
  };
}

export function g1TraceOk(result: G1TraceResult): boolean {
  return (
    result.orphanBusiness.length === 0 &&
    result.orphanScreen.length === 0 &&
    result.orphanP0Fr.length === 0 &&
    result.missingL3Requires.length === 0
  );
}

export function g1TraceMessages(result: G1TraceResult): string[] {
  if (g1TraceOk(result)) {
    return [
      `g1-trace - OK (business=${result.totals.business}, screens=${result.totals.screen}, p0Fr=${result.totals.p0Fr}, l3Plans=${result.totals.l3Plans})`,
    ];
  }
  const parts: string[] = [];
  if (result.orphanBusiness.length > 0)
    parts.push(`orphanBusiness=${result.orphanBusiness.join(",")}`);
  if (result.orphanScreen.length > 0) parts.push(`orphanScreen=${result.orphanScreen.join(",")}`);
  if (result.orphanP0Fr.length > 0) parts.push(`orphanP0Fr=${result.orphanP0Fr.join(",")}`);
  for (const v of result.missingL3Requires) {
    parts.push(`${v.file}:missingRequires=${v.missing.join(",")}`);
  }
  return [`g1-trace - violation: ${parts.join("; ")}`];
}
