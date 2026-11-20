import { afterEach, describe, expect, it, vi } from "vitest";

const readTrace = vi.hoisted(() => ({
  active: false,
  calls: [] as Array<{ api: "existsSync" | "readdirSync" | "readFileSync"; path: string }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const tracePath = (path: unknown): string =>
    typeof path === "string" || Buffer.isBuffer(path) ? String(path).replaceAll("\\", "/") : "";
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (readTrace.active) readTrace.calls.push({ api: "existsSync", path: tracePath(path) });
      return actual.existsSync(path);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (readTrace.active) readTrace.calls.push({ api: "readdirSync", path: tracePath(args[0]) });
      return actual.readdirSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (readTrace.active) readTrace.calls.push({ api: "readFileSync", path: tracePath(args[0]) });
      return actual.readFileSync(...args);
    },
  };
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeG1Trace,
  extractG1BusinessIds,
  extractG1BusinessTrace,
  extractG1P0FrIds,
  extractG1ScreenIds,
  g1TraceMessages,
  g1TraceOk,
  loadG1TraceDocs,
} from "../src/lint/g1-trace.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const REQUIRED_DOCS = [
  ["business", "docs/design/harness/L1-requirements/business-requirements.md"],
  ["functional", "docs/design/harness/L1-requirements/functional-requirements.md"],
  ["screen", "docs/design/harness/L1-requirements/screen-requirements.md"],
] as const;
const temporaryRoots: string[] = [];

function fixtureRoot(sourceDocs: ReturnType<typeof loadG1TraceDocs>, plan?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ut-g1-trace-"));
  temporaryRoots.push(root);
  for (const [key, relativePath] of REQUIRED_DOCS) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sourceDocs[key], "utf8");
  }
  if (plan !== undefined) {
    const plansPath = join(root, "docs", "plans");
    mkdirSync(plansPath, { recursive: true });
    writeFileSync(join(plansPath, "PLAN-L3-01-fixture.md"), plan, "utf8");
  }
  return root;
}

function observeLoader(root: string): {
  docs: ReturnType<typeof loadG1TraceDocs>;
  calls: typeof readTrace.calls;
} {
  readTrace.calls = [];
  readTrace.active = true;
  try {
    return { docs: loadG1TraceDocs(root), calls: [...readTrace.calls] };
  } finally {
    readTrace.active = false;
  }
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

afterEach(() => {
  readTrace.active = false;
  readTrace.calls = [];
  for (const root of temporaryRoots.splice(0)) removeTestTree(root);
});

describe("G1-trace coverage (business/screen/functional)", () => {
  const docs = loadG1TraceDocs();
  const result = analyzeG1Trace(docs);

  it("extracts the fixed G1 business and screen sets", () => {
    const business = extractG1BusinessIds(docs.business);
    const screens = extractG1ScreenIds(docs.screen);
    expect(business.size).toBe(13);
    expect(business.has("BR-21")).toBe(true);
    expect(business.has("BR-22")).toBe(true);
    expect(screens.size).toBe(15);
    expect(screens.has("PM-01")).toBe(true);
    expect(screens.has("PM-06")).toBe(true); // 設計書ビューア (2026-06-22 PO 指示で追加)
    expect(screens.has("HM-08")).toBe(true);
    expect(screens.has("GD-01")).toBe(true);
  });

  it("accepts plain and bold first-cell IDs without over-extracting references", () => {
    const business = extractG1BusinessIds(
      [
        "| BR-01 | plain business requirement |",
        "| **BR-02** | bold business requirement |",
        "| UX-03 | plain UX requirement |",
        "| **UX-04** | bold UX requirement |",
        "| **ID** | BR-21 |",
        "prose refers to BR-05",
        "| related requirement | BR-06 |",
        "| description | **UX-07** |",
        "| related requirement | **ID** | BR-08 |",
        "| BR-1 | invalid short ID |",
        "| BR-001 | invalid long ID |",
        "| XBR-09 | invalid prefix |",
        "| **BR-10 | unbalanced emphasis |",
        "|",
        "**BR-11** | ID on the next line |",
        "|",
        "**ID** | BR-12 | legacy marker on the next line |",
      ].join("\n"),
    );

    expect([...business]).toEqual(["BR-01", "BR-02", "UX-03", "UX-04", "BR-21"]);
  });

  it("traces plain and bold business IDs in the leading table cell", () => {
    const screen = [
      "## §1 Screen overview",
      "| PM-01 | Main screen |",
      "## §2 Details",
      "### §5.1 BR/UX to screen trace",
      "| BR-01 | PM-01 |",
      "| **UX-02** | PM-01 |",
      "| related requirement | BR-03 |",
      "| description | **BR-04** |",
      "| **BR-05 | PM-01 |",
      "| BR-006 | PM-01 |",
      "### §5.3 Functional trace",
      "### §5.5 Screen trace",
      "| **PM-01** | BR-01 |",
      "### §5.6 Details",
    ].join("\n");
    const trace = extractG1BusinessTrace(screen);

    expect([...trace.keys()]).toEqual(["BR-01", "UX-02"]);
    expect([...(trace.get("BR-01") ?? [])]).toEqual(["PM-01"]);
    expect([...(trace.get("UX-02") ?? [])]).toEqual(["PM-01"]);
  });

  it("analyzes a plain-authored BR trace with the existing screen-table format", () => {
    const plainDocs = {
      business: ["| BR-01 | Plain requirement |"].join("\n"),
      functional: "",
      screen: [
        "## §1 Screen overview",
        "| PM-01 | Main screen |",
        "## §2 Details",
        "### §5.1 BR/UX to screen trace",
        "| BR-01 | PM-01 |",
        "### §5.3 Functional trace",
        "### §5.5 Screen trace",
        "| **PM-01** | BR-01 |",
        "### §5.6 Details",
      ].join("\n"),
    };

    const result = analyzeG1Trace(plainDocs);
    expect(result.totals.screen).toBe(1);
    expect(result.orphanBusiness).toEqual([]);
    expect(g1TraceOk(result)).toBe(true);
  });

  it("preserves Unicode horizontal whitespace around a leading business ID", () => {
    const trace = extractG1BusinessTrace(
      [
        "## §1 Screen overview",
        "| PM-01 | Main screen |",
        "## §2 Details",
        "### §5.1 BR/UX to screen trace",
        "|　**BR-01**　| PM-01 |",
        "### §5.3 Functional trace",
      ].join("\n"),
    );

    expect([...trace.keys()]).toEqual(["BR-01"]);
    expect([...(trace.get("BR-01") ?? [])]).toEqual(["PM-01"]);
  });

  it("extracts only P0 functional requirements for blocking FR screen trace", () => {
    const p0Fr = extractG1P0FrIds(docs.functional);
    expect(p0Fr.size).toBe(19);
    expect(p0Fr.has("FR-L1-01")).toBe(true);
    expect(p0Fr.has("FR-L1-45")).toBe(true);
    expect(p0Fr.has("FR-L1-46")).toBe(false);
  });

  it("passes the current repo with no G1 trace orphan", () => {
    expect(result.orphanBusiness).toEqual([]);
    expect(result.orphanScreen).toEqual([]);
    expect(result.orphanP0Fr).toEqual([]);
    expect(g1TraceOk(result)).toBe(true);
  });

  it("U-CTRACE-001: missing BR-22 screen trace is one harness-fixture orphanBusiness", () => {
    const brokenScreen = docs.screen.replace("| **BR-22** |", "| **BR-XX** |");
    expect(brokenScreen).not.toBe(docs.screen);
    const root = fixtureRoot({ ...docs, screen: brokenScreen });
    const loaded = loadG1TraceDocs(root);
    const analyzed = analyzeG1Trace(loaded);

    expect(analyzed.orphanBusiness).toEqual(["BR-22"]);
    expect(analyzed.orphanScreen).toEqual([]);
    expect(analyzed.orphanP0Fr).toEqual([]);
    expect(g1TraceOk(analyzed)).toBe(false);
  });

  it("U-CTRACE-001: retires plans from loaded docs", () => {
    const loaded = loadG1TraceDocs();
    expect("plans" in loaded).toBe(false);
  });

  it("U-CTRACE-001: retires missingL3Requires from trace result", () => {
    const analyzed = analyzeG1Trace(docs);
    expect("missingL3Requires" in analyzed).toBe(false);
  });

  it("U-CTRACE-001: retires totals.l3Plans from trace result", () => {
    const analyzed = analyzeG1Trace(docs);
    expect("l3Plans" in analyzed.totals).toBe(false);
  });

  it("U-CTRACE-001: preserves the exact non-PLAN OK message", () => {
    expect(g1TraceMessages(result)).toEqual(["g1-trace - OK (business=13, screens=15, p0Fr=19)"]);
  });

  const incompletePlan = [
    "related_l1_screen: docs/design/harness/L1-requirements/screen-requirements.md",
    "PLAN-L1-02-functional-requirements",
    "PLAN-L1-03-screen-requirements",
  ].join("\n");

  const loaderCases = [
    { label: "incomplete PLAN", plan: incompletePlan },
    { label: "no PLAN", plan: undefined },
  ];

  it.each(loaderCases)("U-CTRACE-001: $label preserves required G1 reads and trace", ({ plan }) => {
    const observed = observeLoader(fixtureRoot(docs, plan));
    const analyzed = analyzeG1Trace(observed.docs);
    const requiredReads = REQUIRED_DOCS.map(([, relativePath]) =>
      observed.calls.filter(
        (call) => call.api === "readFileSync" && normalized(call.path).endsWith(relativePath),
      ),
    );

    expect(requiredReads.map((reads) => reads.length)).toEqual([1, 1, 1]);
    expect(analyzed.orphanBusiness).toEqual([]);
    expect(analyzed.orphanScreen).toEqual([]);
    expect(analyzed.orphanP0Fr).toEqual([]);
    expect(analyzed.totals.business).toBe(13);
    expect(analyzed.totals.screen).toBe(15);
    expect(analyzed.totals.p0Fr).toBe(19);
  });

  it.each(loaderCases)("U-CTRACE-001: $label never probes docs/plans", ({ plan }) => {
    const observed = observeLoader(fixtureRoot(docs, plan));
    const planCalls = observed.calls.filter((call) =>
      /(?:^|\/)docs\/plans(?:\/|$)/.test(normalized(call.path)),
    );
    expect(planCalls).toEqual([]);
  });

  it("U-CTRACE-001: valid trace is equivalent with no, complete, or incomplete PLAN", () => {
    const completePlan = [
      "related_l1_screen: docs/design/harness/L1-requirements/screen-requirements.md",
      "PLAN-L1-01-business-requirements",
      "PLAN-L1-02-functional-requirements",
      "PLAN-L1-03-screen-requirements",
    ].join("\n");
    const variants = [undefined, completePlan, incompletePlan].map((plan) => {
      const loaded = loadG1TraceDocs(fixtureRoot(docs, plan));
      const analyzed = analyzeG1Trace(loaded);
      return { ok: g1TraceOk(analyzed), analyzed, messages: g1TraceMessages(analyzed) };
    });

    expect(variants.map((variant) => variant.ok)).toEqual([true, true, true]);
    expect(variants[1]).toEqual(variants[0]);
    expect(variants[2]).toEqual(variants[0]);
  });

  it("fails a missing business to screen trace", () => {
    const broken = {
      ...docs,
      screen: docs.screen.replace("| **BR-22** |", "| **BR-XX** |"),
    };
    const r = analyzeG1Trace(broken);
    expect(r.orphanBusiness).toContain("BR-22");
    expect(g1TraceOk(r)).toBe(false);
  });

  it("fails a missing screen to business or functional trace", () => {
    const broken = {
      ...docs,
      screen: docs.screen.replace(
        "| **PM-01** | BR-01 / BR-06 / UX-02 |",
        "| **PM-XX** | BR-01 / BR-06 / UX-02 |",
      ),
    };
    expect(broken.screen).not.toBe(docs.screen);
    const r = analyzeG1Trace(broken);
    expect(r.orphanBusiness).toEqual([]);
    expect(r.orphanScreen).toEqual(["PM-01"]);
    expect(r.orphanP0Fr).toEqual([]);
    expect(g1TraceOk(r)).toBe(false);
  });

  it("fails a missing P0 functional requirement to screen trace", () => {
    const broken = {
      ...docs,
      screen: docs.screen.replace("| **FR-L1-01** (", "| **FR-L1-XX** ("),
    };
    expect(broken.screen).not.toBe(docs.screen);
    const r = analyzeG1Trace(broken);
    expect(r.orphanBusiness).toEqual([]);
    expect(r.orphanScreen).toEqual([]);
    expect(r.orphanP0Fr).toEqual(["FR-L1-01"]);
    expect(g1TraceOk(r)).toBe(false);
  });
});
