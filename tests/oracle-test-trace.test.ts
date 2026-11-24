// PLAN-REVERSE-41 塊B: oracle 宣言 ⇔ 実テスト citation の突合 (IMP-128、forward-citation 規律)。
// test-design 宣言 oracle (U-*/IT-*/ST-*/P-*/M-*) が tests/ に ID citation を持つか。NEW は fail、
// 既存 89 は baseline、検出範囲拡張 (issue #165 / PLAN-L7-480) の 344 は widened baseline。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeOracleTestTrace,
  checkOracleBaselineRatchet,
  collectOracleCitationSites,
  collectOracleDeclarationSites,
  collectOracleIds,
  loadOracleTestTraceInput,
  ORACLE_ID_DUPLICATE_BASELINE,
  type OracleBaselineRatchetInput,
  type OracleBaselineRatchetResult,
  OracleTestTraceLoadError,
  type OracleTraceAuthority,
  type OracleTraceGitPath,
} from "../src/lint/oracle-test-trace.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/** test-design fixture を作り、規定パターンでの宣言収集だけを隔離検証する。 */
function declarationFixture(markdown: string): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-oidgate-"));
  mkdirSync(join(root, "docs", "test-design"), { recursive: true });
  writeFileSync(join(root, "docs", "test-design", "L7.md"), markdown, "utf8");
  return root;
}

/** tests fixture を作り、label と本文/fixture の分類を隔離検証する。 */
function citationFixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-citation-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "sample.test.ts"), source, "utf8");
  return root;
}

type BaselineValues = {
  legacy: unknown[];
  widened: unknown[];
  citations: unknown[];
};

function baselineJson(overrides: Partial<BaselineValues> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    legacy: [],
    widened: [],
    citations: [],
    ...overrides,
  });
}

function observeBaselineLoadFailure(
  subjectRoot: string,
  authority: OracleTraceAuthority,
  assert: (reads: string[], caught: unknown) => void,
): void {
  try {
    const reads: string[] = [];
    let caught: unknown;
    try {
      loadOracleTestTraceInput(subjectRoot, {
        authority: {
          readText(path) {
            reads.push(path);
            return authority.readText(path);
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    assert(reads, caught);
  } finally {
    removeTestTree(subjectRoot);
  }
}

function baselineSubjectFixture(): string {
  const root = declarationFixture("");
  mkdirSync(join(root, "tests"), { recursive: true });
  return root;
}

function fixedBaselineAuthority(text: string | null): OracleTraceAuthority {
  return { readText: () => ({ ok: true, value: text }) };
}

function failedBaselineAuthority(): OracleTraceAuthority {
  return { readText: () => ({ ok: false, reason: "authority_read_failed" }) };
}

const RATC_MERGE_SHA = "a".repeat(40);
const RATC_BASE_SHA = "b".repeat(40);
const RATC_JSON_PATH = "docs/governance/oracle-test-trace-baseline.json" as const;
// Immutable migration-foot baseline: this is historical input for the ratchet's unit Git port only,
// not a fallback/current baseline authority. Keep the ratchet fixture available after Green retires
// the three source files; the repository path below is only where `git show` is run.
const RATC_HISTORICAL_FIXTURE_COMMIT = "25bde95e623bce25e75fd285af204bc780412b79";
const RATC_OLD_SOURCE_PATHS = [
  "src/lint/oracle-test-trace-baseline.ts",
  "src/lint/oracle-test-trace-widened-baseline.ts",
  "src/lint/oracle-test-citation-baseline.ts",
] as const;
const RATC_OLD_EXPORTS = [
  "ORACLE_TEST_TRACE_BASELINE",
  "ORACLE_TEST_TRACE_WIDENED_BASELINE",
  "ORACLE_TEST_CITATION_BASELINE",
] as const;

function gitShowOldBaselineSources(): readonly [string, string, string] {
  return RATC_OLD_SOURCE_PATHS.map((path) =>
    execFileSync("git", ["show", `${RATC_HISTORICAL_FIXTURE_COMMIT}:${path}`], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
  ) as unknown as readonly [string, string, string];
}

function parseExportedSet(source: string, exportName: string): string[] {
  const marker = `export const ${exportName}: ReadonlySet<string> = new Set([`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\n]);", start);
  if (start < 0 || end < 0) throw new Error(`Could not parse Git source export ${exportName}`);
  return [...source.slice(start + marker.length, end).matchAll(/^\s*"([^"]+)"[,]?\s*$/gm)].map(
    (match) => match[1],
  );
}

const RATC_OLD_SOURCE_BLOBS = gitShowOldBaselineSources();
const RATC_OLD_SETS = {
  legacy: parseExportedSet(RATC_OLD_SOURCE_BLOBS[0], RATC_OLD_EXPORTS[0]),
  widened: parseExportedSet(RATC_OLD_SOURCE_BLOBS[1], RATC_OLD_EXPORTS[1]),
  citations: parseExportedSet(RATC_OLD_SOURCE_BLOBS[2], RATC_OLD_EXPORTS[2]),
};
if (
  RATC_OLD_SETS.legacy.length !== 89 ||
  RATC_OLD_SETS.widened.length !== 317 ||
  RATC_OLD_SETS.citations.length !== 582
) {
  throw new Error("Git baseline source fixture cardinality drifted from the migration contract");
}
if (
  new Set(RATC_OLD_SETS.legacy).size !== RATC_OLD_SETS.legacy.length ||
  new Set(RATC_OLD_SETS.widened).size !== RATC_OLD_SETS.widened.length ||
  new Set(RATC_OLD_SETS.citations).size !== RATC_OLD_SETS.citations.length ||
  RATC_OLD_SETS.legacy.some((id) => RATC_OLD_SETS.widened.includes(id)) ||
  !RATC_OLD_SETS.legacy.includes("U-ASSETDRIFT-001") ||
  !RATC_OLD_SETS.citations.includes("U-ADAPTER-005") ||
  !RATC_OLD_SETS.legacy.includes("U-RDRIFT-004") ||
  !RATC_OLD_SETS.citations.includes("U-RDRIFT-004")
) {
  throw new Error(
    "Git baseline source fixture does not match the ratchet selectors/overlap contract",
  );
}

type RatchetBaseline = { legacy: string[]; widened: string[]; citations: string[] };
type RatchetBlob =
  | { ok: true; value: string | null }
  | { ok: false; reason: "git_object_read_failed" };
type RatchetBlobOverride = readonly [string, OracleTraceGitPath, RatchetBlob];

function baselineFromOldSources(): RatchetBaseline {
  return {
    legacy: [...RATC_OLD_SETS.legacy],
    widened: [...RATC_OLD_SETS.widened],
    citations: [...RATC_OLD_SETS.citations],
  };
}

function ratchetBaselineJson(value: RatchetBaseline): string {
  return baselineJson(value);
}

function updateRatchetBaseline(
  changes: Partial<Record<keyof RatchetBaseline, { add?: string[]; remove?: string[] }>>,
): RatchetBaseline {
  const result = baselineFromOldSources();
  for (const axis of ["legacy", "widened", "citations"] as const) {
    const change = changes[axis];
    if (change === undefined) continue;
    result[axis] = result[axis].filter((id) => !change.remove?.includes(id));
    result[axis].push(...(change.add ?? []));
  }
  return result;
}

type RatchetObservation = {
  result: OracleBaselineRatchetResult;
  firstParentCalls: string[];
  blobCalls: Array<readonly [string, OracleTraceGitPath]>;
  authorityReadCount: number;
};

type RatchetFixtureOptions = {
  eventName?: string | null;
  mergeSha?: string | null;
  firstParentResult?:
    | { ok: true; value: string | null }
    | { ok: false; reason: "git_first_parent_read_failed" };
  baseJson?: string | null;
  headJson?: string | null;
  includeOldSourceBlobs?: boolean;
  blobOverrides?: readonly RatchetBlobOverride[];
};

function runRatchetFixture(options: RatchetFixtureOptions = {}): RatchetObservation {
  const blobs = new Map<string, RatchetBlob>();
  const key = (sha: string, path: OracleTraceGitPath) => `${sha}:${path}`;
  const baseJson =
    options.baseJson === undefined
      ? ratchetBaselineJson(baselineFromOldSources())
      : options.baseJson;
  const headJson =
    options.headJson === undefined
      ? ratchetBaselineJson(baselineFromOldSources())
      : options.headJson;
  blobs.set(key(RATC_BASE_SHA, RATC_JSON_PATH), { ok: true, value: baseJson });
  blobs.set(key(RATC_MERGE_SHA, RATC_JSON_PATH), { ok: true, value: headJson });
  if (options.includeOldSourceBlobs) {
    RATC_OLD_SOURCE_PATHS.forEach((path, index) => {
      blobs.set(key(RATC_BASE_SHA, path), { ok: true, value: RATC_OLD_SOURCE_BLOBS[index] });
    });
  }
  for (const [sha, path, response] of options.blobOverrides ?? []) {
    blobs.set(key(sha, path), response);
  }

  const firstParentCalls: string[] = [];
  const blobCalls: Array<readonly [string, OracleTraceGitPath]> = [];
  let authorityReadCount = 0;
  const eventName = Object.hasOwn(options, "eventName") ? options.eventName : "pull_request";
  const mergeSha = Object.hasOwn(options, "mergeSha") ? options.mergeSha : RATC_MERGE_SHA;
  const input = {
    authority: {
      readText() {
        authorityReadCount += 1;
        return { ok: false, reason: "authority_read_failed" as const };
      },
    },
    ci: {
      eventName,
      mergeSha,
      git: {
        readFirstParent(sha: string) {
          firstParentCalls.push(sha);
          return options.firstParentResult ?? { ok: true as const, value: RATC_BASE_SHA };
        },
        readTextAt(sha: string, path: OracleTraceGitPath) {
          blobCalls.push([sha, path]);
          return blobs.get(key(sha, path)) ?? { ok: true as const, value: null };
        },
      },
    },
  } as unknown as OracleBaselineRatchetInput;
  const result = checkOracleBaselineRatchet(input);
  return { result, firstParentCalls, blobCalls, authorityReadCount };
}

function expectRatchetResultAndReads(
  observation: RatchetObservation,
  expectedResult: OracleBaselineRatchetResult,
  expectedParents: readonly string[],
  expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[],
): void {
  expect(observation.result).toEqual(expectedResult);
  expect(observation.firstParentCalls).toEqual(expectedParents);
  expect(observation.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
    expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
  );
  expect(observation.authorityReadCount).toBe(0);
}

function expectMigrationJsonMatchesOldSources(text: string): void {
  const value = JSON.parse(text) as RatchetBaseline & { schemaVersion: number };
  expect(value.schemaVersion).toBe(2);
  expect(value.legacy.length).toBe(89);
  expect(value.widened.length).toBe(317);
  expect(value.citations.length).toBe(582);
  expect([...value.legacy].sort()).toEqual([...RATC_OLD_SETS.legacy].sort());
  expect([...value.widened].sort()).toEqual([...RATC_OLD_SETS.widened].sort());
  expect([...value.citations].sort()).toEqual([...RATC_OLD_SETS.citations].sort());
}

function expectAnalyzerClean(result: ReturnType<typeof analyzeOracleTestTrace>): void {
  expect(result.orphans).toEqual([]);
  expect(result.duplicates).toEqual([]);
  expect(result.staleDuplicateBaseline).toEqual([]);
  expect(result.undeclaredCitations).toEqual([]);
  expect(result.staleCitationBaseline).toEqual([]);
  expect(result.ok).toBe(true);
}

function forwardDebtForAxis(
  axis: "legacy" | "widened",
  declared: readonly string[],
  referenced: ReadonlySet<string>,
  baseline: RatchetBaseline,
): string[] {
  return declared
    .filter(
      (id) =>
        !referenced.has(id) &&
        (axis === "legacy" ? !baseline.widened.includes(id) : !baseline.legacy.includes(id)),
    )
    .sort();
}

function citationSites(ids: readonly string[]) {
  return ids.map((id, index) => ({
    id,
    path: "tests/debt.test.ts",
    line: index + 1,
    kind: "static-test-label" as const,
  }));
}

function forwardAxisAnalyzerFixture(
  axis: "legacy" | "widened",
  head: RatchetBaseline,
  referenced: ReadonlySet<string>,
) {
  const declared = [...new Set([...head.legacy, ...head.widened])];
  return {
    derived: forwardDebtForAxis(axis, declared, referenced, head),
    analysis: analyzeOracleTestTrace({
      declared,
      referenced: new Set(referenced),
      baseline: new Set(head.legacy),
      widenedBaseline: new Set(head.widened),
    }),
  };
}

function citationAxisAnalyzerFixture(head: RatchetBaseline) {
  const sites = citationSites(head.citations);
  return {
    derived: [...new Set(sites.map((site) => site.id))].sort(),
    analysis: analyzeOracleTestTrace({
      declared: [],
      referenced: new Set(),
      baseline: new Set(),
      widenedBaseline: new Set(),
      citationSites: sites,
      citationBaseline: new Set(head.citations),
    }),
  };
}

describe("oracle baseline authority decode (U-OIDBASE-002/003)", () => {
  it("U-OIDBASE-002: 欠落したJSON authorityはtyped missing errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(subjectRoot, fixedBaselineAuthority(null), (reads, caught) => {
      expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
      expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
      expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
        "baseline_asset_missing",
      );
    });
  });

  it("U-OIDBASE-002: authority reader I/O失敗はtyped errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(subjectRoot, failedBaselineAuthority(), (reads, caught) => {
      expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
      expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
      expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
        "authority_read_failed",
      );
    });
  });

  it("U-OIDBASE-002: malformed JSONはtyped decode errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(subjectRoot, fixedBaselineAuthority("{"), (reads, caught) => {
      expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
      expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
      expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
        "baseline_json_malformed",
      );
    });
  });

  it("U-OIDBASE-002: schemaVersion不一致はschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: 1, legacy: [], widened: [], citations: [] }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: schemaVersion欠落はschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(JSON.stringify({ legacy: [], widened: [], citations: [] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: legacy欠落はschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(JSON.stringify({ schemaVersion: 2, widened: [], citations: [] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: widened欠落はschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(JSON.stringify({ schemaVersion: 2, legacy: [], citations: [] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: citations欠落はschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(JSON.stringify({ schemaVersion: 2, legacy: [], widened: [] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: schemaVersionの型違いはschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: "2", legacy: [], widened: [], citations: [] }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: legacyの型違いはschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: 2, legacy: "U-ZZBASE-001", widened: [], citations: [] }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: widenedの型違いはschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: 2, legacy: [], widened: "U-ZZBASE-001", citations: [] }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: 未知fieldはschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: 2, legacy: [], widened: [], citations: [], extra: true }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-002: citationsの型違いはschema errorで拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(
        JSON.stringify({ schemaVersion: 2, legacy: [], widened: [], citations: "U-ZZBASE-001" }),
      ),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_schema_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-003: legacy内の不正ID tokenは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ legacy: ["not-an-oracle-id"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-003: widened内の不正ID tokenは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ widened: ["not-an-oracle-id"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-003: citations内の不正ID tokenは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ citations: ["not-an-oracle-id"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_invalid",
        );
      },
    );
  });

  it("U-OIDBASE-003: legacy内の重複IDは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ legacy: ["U-ZZBASE-001", "U-ZZBASE-001"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_duplicate",
        );
      },
    );
  });

  it("U-OIDBASE-003: widened内の重複IDは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ widened: ["U-ZZBASE-001", "U-ZZBASE-001"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_duplicate",
        );
      },
    );
  });

  it("U-OIDBASE-003: citations内の重複IDは集合化前に拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ citations: ["U-ZZBASE-001", "U-ZZBASE-001"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_id_duplicate",
        );
      },
    );
  });

  it("U-OIDBASE-003: legacyとwidenedの重複は拒否される", () => {
    const subjectRoot = baselineSubjectFixture();
    observeBaselineLoadFailure(
      subjectRoot,
      fixedBaselineAuthority(baselineJson({ legacy: ["U-ZZBASE-001"], widened: ["U-ZZBASE-001"] })),
      (reads, caught) => {
        expect(reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
        expect(caught).toBeInstanceOf(OracleTestTraceLoadError);
        expect((caught as OracleTestTraceLoadError | undefined)?.reason).toBe(
          "baseline_sets_overlap",
        );
      },
    );
  });

  it("U-OIDBASE-003: citationsとlegacyのcross-set overlapは許可される", () => {
    const subjectRoot = baselineSubjectFixture();
    try {
      const input = loadOracleTestTraceInput(subjectRoot, {
        authority: fixedBaselineAuthority(
          baselineJson({ legacy: ["U-RDRIFT-004"], citations: ["U-RDRIFT-004"] }),
        ),
      });
      expect(input.citationBaseline).toBeDefined();
      expect([...input.baseline]).toEqual(["U-RDRIFT-004"]);
      expect([...(input.citationBaseline as ReadonlySet<string>)]).toEqual(["U-RDRIFT-004"]);
    } finally {
      removeTestTree(subjectRoot);
    }
  });

  it("U-OIDBASE-003: citationsとwidenedのcross-set overlapは許可される", () => {
    const subjectRoot = baselineSubjectFixture();
    try {
      const input = loadOracleTestTraceInput(subjectRoot, {
        authority: fixedBaselineAuthority(
          baselineJson({ widened: ["U-RDRIFT-004"], citations: ["U-RDRIFT-004"] }),
        ),
      });
      expect(input.citationBaseline).toBeDefined();
      expect([...input.widenedBaseline]).toEqual(["U-RDRIFT-004"]);
      expect([...(input.citationBaseline as ReadonlySet<string>)]).toEqual(["U-RDRIFT-004"]);
    } finally {
      removeTestTree(subjectRoot);
    }
  });

  it("U-OIDBASE-008: explicit authorityはsubject rootやprocess cwdに依存しない", () => {
    const subjectRoot = baselineSubjectFixture();
    let cwdOne: string | undefined;
    let cwdTwo: string | undefined;

    try {
      cwdOne = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-cwd-one-"));
      cwdTwo = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-cwd-two-"));
      const subjectJsonPath = join(
        subjectRoot,
        "docs",
        "governance",
        "oracle-test-trace-baseline.json",
      );
      const subjectDesignPath = join(subjectRoot, "docs", "test-design", "L7.md");
      mkdirSync(join(subjectRoot, "docs", "governance"), { recursive: true });
      mkdirSync(join(cwdOne, "docs", "governance"), { recursive: true });
      mkdirSync(join(cwdTwo, "docs", "governance"), { recursive: true });
      mkdirSync(join(cwdOne, "docs", "test-design"), { recursive: true });
      mkdirSync(join(cwdTwo, "docs", "test-design"), { recursive: true });
      mkdirSync(join(cwdOne, "tests"), { recursive: true });
      mkdirSync(join(cwdTwo, "tests"), { recursive: true });
      writeFileSync(subjectJsonPath, baselineJson({ legacy: ["U-ZZSUBJECT-001"] }), "utf8");
      writeFileSync(
        subjectDesignPath,
        [
          "| U-ID | 対象 | oracle |",
          "|---|---|---|",
          "| `U-ZZSUBJECT-001` | subject | expected |",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(cwdOne, "docs", "governance", "oracle-test-trace-baseline.json"),
        baselineJson({ legacy: ["U-ZZCWD-ONE-001"] }),
        "utf8",
      );
      writeFileSync(
        join(cwdOne, "docs", "test-design", "L7.md"),
        [
          "| U-ID | 対象 | oracle |",
          "|---|---|---|",
          "| `U-ZZCWD-ONE-001` | cwd | expected |",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(cwdTwo, "docs", "governance", "oracle-test-trace-baseline.json"),
        baselineJson({ legacy: ["U-ZZCWD-TWO-001"] }),
        "utf8",
      );
      writeFileSync(
        join(cwdTwo, "docs", "test-design", "L7.md"),
        [
          "| U-ID | 対象 | oracle |",
          "|---|---|---|",
          "| `U-ZZCWD-TWO-001` | cwd | expected |",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(subjectRoot, "tests", "subject.test.ts"),
        'it("U-ZZSUBJECT-001: subject", () => {});',
        "utf8",
      );
      writeFileSync(
        join(cwdOne, "tests", "cwd.test.ts"),
        'it("U-ZZCWD-ONE-001: cwd", () => {});',
        "utf8",
      );
      writeFileSync(
        join(cwdTwo, "tests", "cwd.test.ts"),
        'it("U-ZZCWD-TWO-001: cwd", () => {});',
        "utf8",
      );
      const moduleUrl = pathToFileURL(
        join(process.cwd(), "src", "lint", "oracle-test-trace.ts"),
      ).href;
      const authorityText = baselineJson({ legacy: ["U-ZZAUTH-001"] });
      const script = `
      const { loadOracleTestTraceInput } = await import(${JSON.stringify(moduleUrl)});
      const subjectRoot = ${JSON.stringify(subjectRoot)};
      const reads = [];
      const input = loadOracleTestTraceInput(subjectRoot, {
        authority: {
          readText(path) {
            reads.push(path);
            return { ok: true, value: ${JSON.stringify(authorityText)} };
          },
        },
      });
      console.log(JSON.stringify({
        baseline: [...input.baseline],
        declared: input.declared,
        referenced: [...input.referenced],
        reads,
      }));
    `;

      const resultAt = (cwd: string) =>
        JSON.parse(
          execFileSync(process.execPath, ["--input-type=module", "-e", script], {
            cwd,
            encoding: "utf8",
          }),
        ) as { baseline: string[]; declared: string[]; referenced: string[]; reads: string[] };
      const first = resultAt(cwdOne);
      const second = resultAt(cwdTwo);
      expect(first).toEqual(second);
      expect(first.baseline).toEqual(["U-ZZAUTH-001"]);
      expect(first.declared).toEqual(["U-ZZSUBJECT-001"]);
      expect(first.referenced).toContain("U-ZZSUBJECT-001");
      expect(first.declared).not.toContain("U-ZZCWD-ONE-001");
      expect(first.declared).not.toContain("U-ZZCWD-TWO-001");
      expect(first.reads).toEqual(["docs/governance/oracle-test-trace-baseline.json"]);
    } finally {
      removeTestTree(subjectRoot);
      if (cwdOne !== undefined) removeTestTree(cwdOne);
      if (cwdTwo !== undefined) removeTestTree(cwdTwo);
    }
  });
});

describe("trusted-base baseline ratchet bootstrap (CANDIDATE-U-OIDBASE-001/011/012)", () => {
  const jsonPairReads = [
    [RATC_BASE_SHA, RATC_JSON_PATH],
    [RATC_MERGE_SHA, RATC_JSON_PATH],
  ] as const;
  const bootstrapReads = [
    [RATC_BASE_SHA, RATC_JSON_PATH],
    ...RATC_OLD_SOURCE_PATHS.map((path) => [RATC_BASE_SHA, path] as const),
    [RATC_MERGE_SHA, RATC_JSON_PATH],
  ] as const;

  it("CANDIDATE-U-OIDBASE-001: initial migration accepts old TS blobs only when every set matches head JSON", () => {
    const headJson = ratchetBaselineJson(baselineFromOldSources());
    const observed = runRatchetFixture({
      baseJson: null,
      headJson,
      includeOldSourceBlobs: true,
    });
    expectRatchetResultAndReads(observed, { ok: true }, [RATC_MERGE_SHA], bootstrapReads);
    expectMigrationJsonMatchesOldSources(headJson);
    expect(RATC_OLD_SOURCE_BLOBS[0]).toContain("export const ORACLE_TEST_TRACE_BASELINE");
    expect(RATC_OLD_SOURCE_BLOBS[1]).toContain("export const ORACLE_TEST_TRACE_WIDENED_BASELINE");
    expect(RATC_OLD_SOURCE_BLOBS[2]).toContain("export const ORACLE_TEST_CITATION_BASELINE");
  });

  it("CANDIDATE-U-OIDBASE-011: 正規bootstrap構造は旧89/317/582件と全要素一致で受理される", () => {
    const headJson = ratchetBaselineJson(baselineFromOldSources());
    const observed = runRatchetFixture({
      baseJson: null,
      headJson,
      includeOldSourceBlobs: true,
    });
    expect(observed.result).toEqual({ ok: true });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      bootstrapReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
    const value = JSON.parse(headJson) as RatchetBaseline & { schemaVersion: number };
    expect(value.schemaVersion).toBe(2);
    expect(value.legacy.length).toBe(89);
    expect(value.widened.length).toBe(317);
    expect(value.citations.length).toBe(582);
    expect([...value.legacy].sort()).toEqual([...RATC_OLD_SETS.legacy].sort());
    expect([...value.widened].sort()).toEqual([...RATC_OLD_SETS.widened].sort());
    expect([...value.citations].sort()).toEqual([...RATC_OLD_SETS.citations].sort());
  });

  it("CANDIDATE-U-OIDBASE-011: bootstrapに必要な旧blobの欠落はbase invalidで拒否される", () => {
    const observed = runRatchetFixture({
      baseJson: null,
      headJson: ratchetBaselineJson(baselineFromOldSources()),
      includeOldSourceBlobs: true,
      blobOverrides: [[RATC_BASE_SHA, RATC_OLD_SOURCE_PATHS[0], { ok: true, value: null }]],
    });
    expect(observed.result).toEqual({ ok: false, reason: "bootstrap_base_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const actualBlobCalls = observed.blobCalls.map(([sha, path]) => `${sha}:${path}`);
    const allowedBlobCalls = new Set(bootstrapReads.map(([sha, path]) => `${sha}:${path}`));
    expect(actualBlobCalls.every((call) => allowedBlobCalls.has(call))).toBe(true);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_JSON_PATH}`);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_OLD_SOURCE_PATHS[0]}`);
    expect(observed.authorityReadCount).toBe(0);
  });

  it("CANDIDATE-U-OIDBASE-011: 非正規の旧export shapeはbase invalidで拒否される", () => {
    const observed = runRatchetFixture({
      baseJson: null,
      headJson: ratchetBaselineJson(baselineFromOldSources()),
      includeOldSourceBlobs: true,
      blobOverrides: [
        [
          RATC_BASE_SHA,
          RATC_OLD_SOURCE_PATHS[0],
          { ok: true, value: "export const WRONG = new Set([]);" },
        ],
      ],
    });
    expect(observed.result).toEqual({ ok: false, reason: "bootstrap_base_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const actualBlobCalls = observed.blobCalls.map(([sha, path]) => `${sha}:${path}`);
    const allowedBlobCalls = new Set(bootstrapReads.map(([sha, path]) => `${sha}:${path}`));
    expect(actualBlobCalls.every((call) => allowedBlobCalls.has(call))).toBe(true);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_JSON_PATH}`);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_OLD_SOURCE_PATHS[0]}`);
    expect(observed.authorityReadCount).toBe(0);
  });

  it("CANDIDATE-U-OIDBASE-011: old source blob Git I/O failure returns an object read failure", () => {
    const observed = runRatchetFixture({
      baseJson: null,
      headJson: ratchetBaselineJson(baselineFromOldSources()),
      includeOldSourceBlobs: true,
      blobOverrides: [
        [RATC_BASE_SHA, RATC_OLD_SOURCE_PATHS[0], { ok: false, reason: "git_object_read_failed" }],
      ],
    });
    expect(observed.result).toEqual({ ok: false, reason: "git_object_read_failed" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const actualBlobCalls = observed.blobCalls.map(([sha, path]) => `${sha}:${path}`);
    const allowedBlobCalls = new Set(bootstrapReads.map(([sha, path]) => `${sha}:${path}`));
    expect(actualBlobCalls.every((call) => allowedBlobCalls.has(call))).toBe(true);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_JSON_PATH}`);
    expect(actualBlobCalls).toContain(`${RATC_BASE_SHA}:${RATC_OLD_SOURCE_PATHS[0]}`);
    expect(observed.authorityReadCount).toBe(0);
  });

  it("CANDIDATE-U-OIDBASE-011: 有効旧blobに対する同件数要素差分はvalue mismatch", () => {
    const mismatched = updateRatchetBaseline({
      legacy: { remove: ["U-ASSETDRIFT-001"], add: ["U-ZZBASE-901"] },
    });
    const headJson = ratchetBaselineJson(mismatched);
    const observed = runRatchetFixture({ baseJson: null, headJson, includeOldSourceBlobs: true });
    expectRatchetResultAndReads(
      observed,
      { ok: false, reason: "bootstrap_value_mismatch" },
      [RATC_MERGE_SHA],
      bootstrapReads,
    );
    expect(headJson).not.toEqual(ratchetBaselineJson(baselineFromOldSources()));
    expect(JSON.parse(headJson).legacy.length).toBe(89);
    expect(JSON.parse(headJson).legacy).not.toContain("U-ASSETDRIFT-001");
    expect(JSON.parse(headJson).legacy).toContain("U-ZZBASE-901");
  });

  it.fails("CANDIDATE-U-OIDBASE-012: accept a normal JSON pair and reject old-bootstrap-only input", () => {
    const normalPair = runRatchetFixture({ includeOldSourceBlobs: true });
    expectRatchetResultAndReads(normalPair, { ok: true }, [RATC_MERGE_SHA], jsonPairReads);

    const oldBootstrapOnly = runRatchetFixture({
      baseJson: null,
      headJson: ratchetBaselineJson(baselineFromOldSources()),
      includeOldSourceBlobs: true,
    });
    expectRatchetResultAndReads(
      oldBootstrapOnly,
      { ok: false, reason: "git_baseline_missing" },
      [RATC_MERGE_SHA],
      [[RATC_BASE_SHA, RATC_JSON_PATH]],
    );
  });
});

describe("three independent subset axes (U-OIDBASE-005 / U-OIDBASE-006)", () => {
  const jsonPairReads = [
    [RATC_BASE_SHA, RATC_JSON_PATH],
    [RATC_MERGE_SHA, RATC_JSON_PATH],
  ] as const;

  it("U-OIDBASE-005: legacy debtと対応derived IDの同時縮小を受理する", () => {
    const id = "U-ASSETDRIFT-001";
    const head = updateRatchetBaseline({ legacy: { remove: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: true });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);

    const fixture = forwardAxisAnalyzerFixture("legacy", head, new Set([id]));
    expect(fixture.derived).toEqual([...head.legacy].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("U-OIDBASE-005: widened debtと対応derived IDの同時縮小を受理する", () => {
    const id = RATC_OLD_SETS.widened[0];
    const head = updateRatchetBaseline({ widened: { remove: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: true });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);

    const fixture = forwardAxisAnalyzerFixture("widened", head, new Set([id]));
    expect(fixture.derived).toEqual([...head.widened].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("U-OIDBASE-005: citation siteとhead citation debtの同時縮小を受理する", () => {
    const id = "U-ADAPTER-005";
    const head = updateRatchetBaseline({ citations: { remove: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: true });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
    const fixture = citationAxisAnalyzerFixture(head);
    expect(fixture.derived).toEqual([...head.citations].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("U-OIDBASE-006: derived equality passでもbase外legacy growthは拒否する", () => {
    const id = "U-ZZBASE-901";
    const head = updateRatchetBaseline({ legacy: { add: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: false, reason: "baseline_growth" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);

    const fixture = forwardAxisAnalyzerFixture("legacy", head, new Set());
    expect(fixture.derived).toEqual([...head.legacy].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("U-OIDBASE-006: derived equality passでもbase外widened growthは拒否する", () => {
    const id = "U-ZZBASE-901";
    const head = updateRatchetBaseline({ widened: { add: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: false, reason: "baseline_growth" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);

    const fixture = forwardAxisAnalyzerFixture("widened", head, new Set());
    expect(fixture.derived).toEqual([...head.widened].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("U-OIDBASE-006: derived equality passでもbase外citation growthは拒否する", () => {
    const id = "U-ZZBASE-901";
    const head = updateRatchetBaseline({ citations: { add: [id] } });
    const observed = runRatchetFixture({ headJson: ratchetBaselineJson(head) });
    expect(observed.result).toEqual({ ok: false, reason: "baseline_growth" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
    const fixture = citationAxisAnalyzerFixture(head);
    expect(fixture.derived).toEqual([...head.citations].sort());
    expect(fixture.analysis.orphans).toEqual([]);
    expect(fixture.analysis.duplicates).toEqual([]);
    expect(fixture.analysis.staleDuplicateBaseline).toEqual([]);
    expect(fixture.analysis.undeclaredCitations).toEqual([]);
    expect(fixture.analysis.staleCitationBaseline).toEqual([]);
    expect(fixture.analysis.ok).toBe(true);
  });

  it("legacy debt shrinkのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const id = "U-ASSETDRIFT-001";
    const head = updateRatchetBaseline({ legacy: { remove: [id] } });
    const fixture = forwardAxisAnalyzerFixture("legacy", head, new Set([id]));
    expect(fixture.derived).toEqual([...head.legacy].sort());
    expectAnalyzerClean(fixture.analysis);
  });

  it("widened debt shrinkのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const id = RATC_OLD_SETS.widened[0];
    const head = updateRatchetBaseline({ widened: { remove: [id] } });
    const fixture = forwardAxisAnalyzerFixture("widened", head, new Set([id]));
    expect(fixture.derived).toEqual([...head.widened].sort());
    expectAnalyzerClean(fixture.analysis);
  });

  it("citation debt shrinkのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const head = updateRatchetBaseline({ citations: { remove: ["U-ADAPTER-005"] } });
    const fixture = citationAxisAnalyzerFixture(head);
    expect(fixture.derived).toEqual([...head.citations].sort());
    expectAnalyzerClean(fixture.analysis);
  });

  it("legacy debt growthのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const head = updateRatchetBaseline({ legacy: { add: ["U-ZZBASE-901"] } });
    const fixture = forwardAxisAnalyzerFixture("legacy", head, new Set());
    expect(fixture.derived).toEqual([...head.legacy].sort());
    expectAnalyzerClean(fixture.analysis);
  });

  it("widened debt growthのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const head = updateRatchetBaseline({ widened: { add: ["U-ZZBASE-901"] } });
    const fixture = forwardAxisAnalyzerFixture("widened", head, new Set());
    expect(fixture.derived).toEqual([...head.widened].sort());
    expectAnalyzerClean(fixture.analysis);
  });

  it("citation debt growthのfixtureではderived equalityとanalyzer cleanが独立して成立する", () => {
    const head = updateRatchetBaseline({ citations: { add: ["U-ZZBASE-901"] } });
    const fixture = citationAxisAnalyzerFixture(head);
    expect(fixture.derived).toEqual([...head.citations].sort());
    expectAnalyzerClean(fixture.analysis);
  });
});

describe("trusted PR pair fail-close reasons (U-OIDBASE-007)", () => {
  const jsonPairReads = [
    [RATC_BASE_SHA, RATC_JSON_PATH],
    [RATC_MERGE_SHA, RATC_JSON_PATH],
  ] as const;

  it("U-OIDBASE-007: pull_request以外のeventはPR context invalid", () => {
    const observed = runRatchetFixture({ eventName: "push" });
    expect(observed.result).toEqual({ ok: false, reason: "pr_context_invalid" });
    expect(observed.firstParentCalls).toEqual([]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: event name欠落はPR context invalid", () => {
    const observed = runRatchetFixture({ eventName: undefined });
    expect(observed.result).toEqual({ ok: false, reason: "pr_context_invalid" });
    expect(observed.firstParentCalls).toEqual([]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: merge SHA欠落はPR context invalid", () => {
    const observed = runRatchetFixture({ mergeSha: undefined });
    expect(observed.result).toEqual({ ok: false, reason: "pr_context_invalid" });
    expect(observed.firstParentCalls).toEqual([]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: merge SHA不正形式はPR context invalid", () => {
    const observed = runRatchetFixture({ mergeSha: "not-a-40-hex-sha" });
    expect(observed.result).toEqual({ ok: false, reason: "pr_context_invalid" });
    expect(observed.firstParentCalls).toEqual([]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: missing first parent returns its dedicated failure reason", () => {
    const observed = runRatchetFixture({ firstParentResult: { ok: true, value: null } });
    expect(observed.result).toEqual({ ok: false, reason: "git_first_parent_missing" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: first-parent Git I/O failure returns its dedicated failure reason", () => {
    const observed = runRatchetFixture({
      firstParentResult: { ok: false, reason: "git_first_parent_read_failed" },
    });
    expect(observed.result).toEqual({ ok: false, reason: "git_first_parent_read_failed" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const expectedBlobs: readonly (readonly [string, OracleTraceGitPath])[] = [];
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: base JSON Git I/O failureはobject read failure", () => {
    const observed = runRatchetFixture({
      blobOverrides: [
        [RATC_BASE_SHA, RATC_JSON_PATH, { ok: false, reason: "git_object_read_failed" }],
      ],
    });
    expect(observed.result).toEqual({ ok: false, reason: "git_object_read_failed" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const expectedBlobs = [[RATC_BASE_SHA, RATC_JSON_PATH]] as const;
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: malformed base JSONはtrusted baseline invalid", () => {
    const observed = runRatchetFixture({ baseJson: "{" });
    expect(observed.result).toEqual({ ok: false, reason: "trusted_baseline_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const expectedBlobs = [[RATC_BASE_SHA, RATC_JSON_PATH]] as const;
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: schema不正なbase JSONはtrusted baseline invalid", () => {
    const observed = runRatchetFixture({
      baseJson: JSON.stringify({ schemaVersion: 1, legacy: [], widened: [], citations: [] }),
    });
    expect(observed.result).toEqual({ ok: false, reason: "trusted_baseline_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    const expectedBlobs = [[RATC_BASE_SHA, RATC_JSON_PATH]] as const;
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      expectedBlobs.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: head JSON欠落はgit baseline missing", () => {
    const observed = runRatchetFixture({ headJson: null });
    expect(observed.result).toEqual({ ok: false, reason: "git_baseline_missing" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: head JSON Git I/O failureはobject read failure", () => {
    const observed = runRatchetFixture({
      blobOverrides: [
        [RATC_MERGE_SHA, RATC_JSON_PATH, { ok: false, reason: "git_object_read_failed" }],
      ],
    });
    expect(observed.result).toEqual({ ok: false, reason: "git_object_read_failed" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: malformed head JSONはtrusted baseline invalid", () => {
    const observed = runRatchetFixture({ headJson: "{" });
    expect(observed.result).toEqual({ ok: false, reason: "trusted_baseline_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });

  it("U-OIDBASE-007: schema不正なhead JSONはtrusted baseline invalid", () => {
    const observed = runRatchetFixture({
      headJson: JSON.stringify({ schemaVersion: 1, legacy: [], widened: [], citations: [] }),
    });
    expect(observed.result).toEqual({ ok: false, reason: "trusted_baseline_invalid" });
    expect(observed.firstParentCalls).toEqual([RATC_MERGE_SHA]);
    expect(observed.blobCalls.map(([sha, path]) => `${sha}:${path}`).sort()).toEqual(
      jsonPairReads.map(([sha, path]) => `${sha}:${path}`).sort(),
    );
    expect(observed.authorityReadCount).toBe(0);
  });
});

describe("analyzeOracleTestTrace (U-OTT-001..003)", () => {
  const base = {
    referenced: new Set(["U-FOO-001"]),
    baseline: new Set(["U-BAR-002"]),
    widenedBaseline: new Set<string>(),
  };

  it("U-OTT-001: 宣言済だが未 citation かつ baseline 外 = orphan (NEW fail-close)", () => {
    const r = analyzeOracleTestTrace({ declared: ["U-NEW-009"], ...base });
    expect(r.orphans).toContain("U-NEW-009");
    expect(r.ok).toBe(false);
  });

  it("U-OTT-002: tests に citation 済 oracle は orphan でない", () => {
    const r = analyzeOracleTestTrace({ declared: ["U-FOO-001"], ...base });
    expect(r.orphans).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("U-OTT-003: baseline 済 oracle は orphan でない (known-debt)", () => {
    const r = analyzeOracleTestTrace({ declared: ["U-BAR-002"], ...base });
    expect(r.orphans).toHaveLength(0);
  });
});

describe("宣言 provenance の一意性 (Issue #206)", () => {
  const base = {
    declared: [],
    referenced: new Set<string>(),
    baseline: new Set<string>(),
    widenedBaseline: new Set<string>(),
  };

  it("同一ID・別説明は baseline 外なら fail-close する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      declarationSites: [
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 10, description: "入力を拒否する" },
        {
          id: "U-NEW-001",
          path: "docs/test-design/a.md",
          line: 11,
          description: "入力を永続化する",
        },
      ],
    });
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]?.id).toBe("U-NEW-001");
    expect(r.ok).toBe(false);
  });

  it("同一ID・同一説明の再掲は重複扱いしない", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      declarationSites: [
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 10, description: "同じ契約" },
        { id: "U-NEW-001", path: "docs/test-design/b.md", line: 20, description: "同じ契約" },
      ],
    });
    expect(r.duplicates).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("既存衝突の baseline に無い説明の追加は fail-close する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      duplicateBaseline: new Set(["U-NEW-001\t既存契約"]),
      declarationSites: [
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 10, description: "既存契約" },
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 11, description: "新規契約" },
      ],
    });
    expect(r.duplicates[0]?.descriptions).toContain("新規契約");
    expect(r.staleDuplicateBaseline).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("既存衝突が解消され baseline 行だけ残る場合は stale として fail-close する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      duplicateBaseline: new Set(["U-NEW-001\t解消済み契約", "U-NEW-001\t残置契約"]),
      declarationSites: [
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 10, description: "解消済み契約" },
      ],
    });
    expect(r.staleDuplicateBaseline).toEqual(["U-NEW-001\t残置契約"]);
    expect(r.ok).toBe(false);
  });

  it("baseline にない単独説明は重複ではなく stale/更新要求として扱う", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      duplicateBaseline: new Set(["U-NEW-001\t旧契約"]),
      declarationSites: [
        { id: "U-NEW-001", path: "docs/test-design/a.md", line: 10, description: "新契約" },
      ],
    });
    expect(r.duplicates).toEqual([]);
    expect(r.staleDuplicateBaseline).toEqual(["U-NEW-001\t旧契約"]);
    expect(r.ok).toBe(false);
  });
});

describe("宣言 site 収集 (Issue #206)", () => {
  it("退役表中の既存ID参照は宣言にせず、正確なIDセル宣言は orphan に残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-retired-id-"));
    try {
      mkdirSync(join(root, "docs", "test-design"), { recursive: true });
      writeFileSync(
        join(root, "docs", "test-design", "L7.md"),
        [
          "### Confirmed test design",
          "| ID | Description | Result |",
          "|---|---|---|",
          "| `U-ZZCANON-901` | canonical declaration | reject |",
          "",
          "### Retired references",
          "| Former oracle | Reason |",
          "|---|---|",
          "| 既存 `U-ZZRETIRE-901` | retired, not a declaration |",
        ].join("\n"),
        "utf8",
      );

      const { declared, declarationSites } = collectOracleIds(root);
      expect([...declared].sort()).toEqual(["U-ZZCANON-901"]);
      expect(declarationSites.map((site) => site.id)).toEqual(["U-ZZCANON-901"]);
      const result = analyzeOracleTestTrace({
        declared: [...declared],
        referenced: new Set(),
        baseline: new Set(),
        widenedBaseline: new Set(),
        declarationSites,
      });
      expect(result.orphans).toEqual(["U-ZZCANON-901"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ST-ID / AC 複合セルは ST oracle を宣言として収集する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-system-oracle-"));
    try {
      mkdirSync(join(root, "docs", "test-design"), { recursive: true });
      writeFileSync(
        join(root, "docs", "test-design", "L9.md"),
        [
          "### System red oracles",
          "| ST-ID / AC | system fixture / fault | positive expected | negative expected |",
          "|---|---|---|---|",
          "| `ST-ZZSYS-901` / `AC-ZZSYS-901` | fault fixture | deny | accept |",
        ].join("\n"),
        "utf8",
      );

      const { declared, declarationSites } = collectOracleIds(root);
      expect([...declared]).toEqual(["ST-ZZSYS-901"]);
      expect(declarationSites.map((site) => site.id)).toEqual(["ST-ZZSYS-901"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("正確なIDセルだけを宣言として収集し、family range の再引用を除外する", () => {
    const root = declarationFixture(
      [
        "| U-ID | 対象 | oracle |",
        "|---|---|---|",
        "| `U-DECL-001` | `service` | 入力を拒否する |",
        "| `docs/design/x.md` | U-DECL-001..003 | `tests/x.test.ts` |",
      ].join("\n"),
    );
    const sites = collectOracleDeclarationSites(root);
    expect(sites).toEqual([
      {
        id: "U-DECL-001",
        path: "docs/test-design/L7.md",
        line: 3,
        description: "`service` | 入力を拒否する",
      },
    ]);
  });

  it("正確なIDセルがあり説明側に別IDを再引用しても宣言siteを落とさない", () => {
    const root = declarationFixture(
      [
        "### §5 Confirmed IT Case Design (G5 Freeze)",
        "| IT-ID | Given | When | Then |",
        "|---|---|---|---|",
        "| `U-DECL-004` | fixture (U-DECL-005 参照) | 入力 | 拒否 |",
      ].join("\n"),
    );
    expect(collectOracleDeclarationSites(root)).toEqual([
      {
        id: "U-DECL-004",
        path: "docs/test-design/L7.md",
        line: 4,
        description: "fixture (U-DECL-005 参照) | 入力 | 拒否",
      },
    ]);
  });

  it("candidate/概要表は confirmed/freeze の同一ID行があれば構造的再掲として除外する", () => {
    const root = declarationFixture(
      [
        "### arbitrary summary heading",
        "| IT-ID (候補) | 対象 | シナリオ |",
        "|---|---|---|",
        "| `IT-DECL-001` | draft | 概要 |",
        "## arbitrary confirmed heading",
        "| IT-ID | Given | When | Then |",
        "|---|---|---|---|",
        "| `IT-DECL-001` | request | execute | reject |",
      ].join("\n"),
    );
    expect(collectOracleDeclarationSites(root)).toEqual([
      {
        id: "IT-DECL-001",
        path: "docs/test-design/L7.md",
        line: 8,
        description: "request | execute | reject",
      },
    ]);
  });

  it("canonical宣言同士の別説明は重複として残す", () => {
    const root = declarationFixture(
      [
        "## Confirmed A",
        "| ID | Given | When | Then |",
        "|---|---|---|---|",
        "| `U-DECL-006` | request | execute | reject |",
        "## Confirmed B",
        "| ID | Given | When | Then |",
        "|---|---|---|---|",
        "| `U-DECL-006` | request | execute | persist |",
      ].join("\n"),
    );
    const sites = collectOracleDeclarationSites(root);
    const r = analyzeOracleTestTrace({
      declared: ["U-DECL-006"],
      referenced: new Set(["U-DECL-006"]),
      baseline: new Set(),
      widenedBaseline: new Set(),
      declarationSites: sites,
    });
    expect(r.duplicates).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it("resource kernel の概要/freeze 表も列スキーマで構造的再掲を除外する", () => {
    const root = declarationFixture(
      [
        "## renamed overview",
        "| ID | boundary / fault injection | expected |",
        "|---|---|---|",
        "| `IT-DECL-007` | wire fault | reject |",
        "## renamed freeze",
        "| ID | lane | 対象OS / required capability | fixture | 観測点 (保存する fact) | negative expected | created count (control/workload) |",
        "|---|---|---|---|---|---|---|",
        "| `IT-DECL-007` | mock | OS非依存 | fx | fault | side effect | control 1 / workload 0 |",
      ].join("\n"),
    );
    expect(collectOracleDeclarationSites(root)).toEqual([
      {
        id: "IT-DECL-007",
        path: "docs/test-design/L7.md",
        line: 8,
        description: "mock | OS非依存 | fx | fault | side effect | control 1 / workload 0",
      },
    ]);
  });

  it("構造的 mirror の概要表内で同一IDを二重定義した場合は抑制しない", () => {
    const root = declarationFixture(
      [
        "## summary",
        "| IT-ID (候補) | 対象 | シナリオ |",
        "|---|---|---|",
        "| `IT-DECL-009` | first | contract A |",
        "| `IT-DECL-009` | second | contract B |",
        "## confirmed",
        "| IT-ID | Given | When | Then |",
        "|---|---|---|---|",
        "| `IT-DECL-009` | request | execute | reject |",
      ].join("\n"),
    );
    const sites = collectOracleDeclarationSites(root);
    expect(sites).toHaveLength(3);
    const r = analyzeOracleTestTrace({
      declared: ["IT-DECL-009"],
      referenced: new Set(["IT-DECL-009"]),
      baseline: new Set(),
      widenedBaseline: new Set(),
      declarationSites: sites,
    });
    expect(r.duplicates[0]?.id).toBe("IT-DECL-009");
    expect(r.ok).toBe(false);
  });

  it("未知の表スキーマは見出しが addendum でも折り畳まず、別 oracle を可視化する", () => {
    const root = declarationFixture(
      [
        "## summary",
        "| U-ID | 対象関数 | DbC oracle |",
        "|---|---|---|",
        "| `U-DECL-008` | `summaryFn` | 概要契約 |",
        "## addendum",
        "| U-ID | Target | Oracle |",
        "|---|---|---|",
        "| `U-DECL-008` | `addendumFn` | 別契約 |",
      ].join("\n"),
    );
    const sites = collectOracleDeclarationSites(root);
    expect(sites).toHaveLength(2);
    const r = analyzeOracleTestTrace({
      declared: ["U-DECL-008"],
      referenced: new Set(["U-DECL-008"]),
      baseline: new Set(),
      widenedBaseline: new Set(),
      declarationSites: sites,
    });
    expect(r.duplicates[0]?.id).toBe("U-DECL-008");
    expect(r.ok).toBe(false);
  });
});

describe("token 境界と検出範囲 (issue #165 / PLAN-L7-480、U-OIDGATE-001..004)", () => {
  it("U-OIDGATE-001: CANDIDATE-* の suffix を oracle として抽出しない (token 境界)", () => {
    // main に実在する 8 件の代表 + 過去に混入した形 (PR #258 で 6 件 baseline 汚染)。
    const root = declarationFixture(
      [
        "| `CANDIDATE-M-SP-002` | 未実装 oracle | RED |",
        "| `CANDIDATE-U-FOO-001` | 未実装 oracle | RED |",
        "| `CANDIDATE-P-FSM-001` | 未実装 oracle | RED |",
      ].join("\n"),
    );
    expect(collectOracleIds(root).declared.size).toBe(0);
  });

  it("U-OIDGATE-002: 2 桁番号 / ST prefix の宣言も収集し、未 citation なら orphan", () => {
    // fixture は架空 ID を使う (実在 ID を書くと素朴 ID マッチがこのファイルを citation と
    // 数え、実 oracle が ratchet 圧の外へ漏れる — blind review minor 指摘)。
    const root = declarationFixture(
      "| `ST-ZZDATA-01` | 2 桁 oracle | exit 1 |\n| `U-ZZFUNC-01` | 〃 | 〃 |",
    );
    const { declared } = collectOracleIds(root);
    expect([...declared].sort()).toEqual(["ST-ZZDATA-01", "U-ZZFUNC-01"]);
    const r = analyzeOracleTestTrace({
      declared: [...declared],
      referenced: new Set(),
      baseline: new Set(),
      widenedBaseline: new Set(),
    });
    expect(r.orphans).toEqual(["ST-ZZDATA-01", "U-ZZFUNC-01"]);
    expect(r.ok).toBe(false);
  });

  it("U-OIDGATE-003: 多 segment 名も収集し、右境界の部分抽出をしない", () => {
    // fixture は架空 ID (実在 ID を書くと素朴 ID マッチがこのファイルを citation と数え、
    // 実 oracle が ratchet 圧の外へ漏れる)。右境界が \b のままだと `...-005-L7` 型から
    // `-005` までを部分抽出する (PR #263 Minor 1)。末尾 segment が非数字の全体は ID として
    // 成立しないため、全体・部分とも抽出 0 が正しい。
    const root = declarationFixture(
      "| `U-ZZMULTI-D3C-001` | 多 segment | RED |\n| `U-ZZVTR-005-L7` | 右境界 fixture | — |",
    );
    const declared = [...collectOracleIds(root).declared].sort();
    expect(declared).toEqual(["U-ZZMULTI-D3C-001"]);
    expect(declared).not.toContain("U-ZZVTR-005");
    // 収集後の orphan 経路 (spec CANDIDATE-OIDGATE-003 の oracle 本文) まで通す。
    const r = analyzeOracleTestTrace({
      declared,
      referenced: new Set(),
      baseline: new Set(),
      widenedBaseline: new Set(),
    });
    expect(r.orphans).toEqual(["U-ZZMULTI-D3C-001"]);
  });

  it("U-OIDGATE-004: widened baseline 収載 ID は orphan にしない (ratchet)", () => {
    const r = analyzeOracleTestTrace({
      declared: ["ST-ZZDATA-01"],
      referenced: new Set(),
      baseline: new Set(),
      widenedBaseline: new Set(["ST-ZZDATA-01"]),
    });
    expect(r.orphans).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("derived ratchet 検証 (U-OIDGATE-005..007)", () => {
  it("U-OIDGATE-005: widened baseline は実 repo からの再導出集合と完全一致 (件数でなく要素)", () => {
    // 定数 size 比較は中身を保証しない (PR #258 で CANDIDATE 由来 6 件が混入したまま件数だけ
    // 合致した実例)。集合一致なら (a) 新規 orphan の混入と (b) stale 行の両方が同時に落ちる。
    // baseline 収載 oracle を citation したら、この test が baseline の縮小を機械強制する。
    const input = loadOracleTestTraceInput(process.cwd());
    const { declared, referenced } = collectOracleIds(process.cwd());
    const derived = [...declared]
      .filter((id) => !referenced.has(id) && !input.baseline.has(id))
      .sort();
    expect(derived).toEqual([...input.widenedBaseline].sort());

    // 同じ件数でも要素置換は完全集合比較で検出する。実 loader に authority を注入し、
    // valid な新 ID との置換を通して集合内容が比較されることを確認する。
    const citationBaseline = input.citationBaseline;
    expect(citationBaseline).toBeDefined();
    const originalWidened = [...input.widenedBaseline].sort();
    const replacedId = originalWidened[0];
    expect(replacedId).toBeDefined();
    const replacementId = "U-ZZBASE-901";
    expect(input.baseline.has(replacementId)).toBe(false);
    expect(input.widenedBaseline.has(replacementId)).toBe(false);
    const mutatedWidened = originalWidened.filter((id) => id !== replacedId);
    mutatedWidened.push(replacementId);
    const mutatedAuthorityJson = baselineJson({
      legacy: [...input.baseline],
      widened: mutatedWidened,
      citations: [...(citationBaseline as ReadonlySet<string>)],
    });
    const authorityReads: string[] = [];
    const mutatedInput = loadOracleTestTraceInput(process.cwd(), {
      authority: {
        readText(path) {
          authorityReads.push(path);
          return { ok: true, value: mutatedAuthorityJson };
        },
      },
    });
    expect(authorityReads).toEqual([RATC_JSON_PATH]);
    const mutatedDerived = [...declared]
      .filter((id) => !referenced.has(id) && !mutatedInput.baseline.has(id))
      .sort();
    expect(mutatedInput.widenedBaseline.size).toBe(input.widenedBaseline.size);
    expect(mutatedDerived).toHaveLength(mutatedInput.widenedBaseline.size);
    expect(mutatedDerived).not.toEqual([...mutatedInput.widenedBaseline].sort());
  });

  it("U-OIDGATE-006: baseline に citation 済み ID が混ざると derived 集合との不一致で stale 検出される", () => {
    // 実機構を通す: 実 repo の derived 集合に対し、citation 済みの実宣言 oracle を 1 件
    // widened baseline へ混入させると、U-OIDGATE-005 と同じ集合一致検証が必ず fail する
    // (blind review blocking 是正 — リテラル同士の比較では production コードを検証しない)。
    const input = loadOracleTestTraceInput(process.cwd());
    const { declared, referenced } = collectOracleIds(process.cwd());
    const derived = [...declared]
      .filter((id) => !referenced.has(id) && !input.baseline.has(id))
      .sort();
    const cited = [...declared].find((id) => referenced.has(id) && !input.widenedBaseline.has(id));
    expect(cited).toBeDefined();
    const stale = [...new Set([...input.widenedBaseline, cited as string])].sort();
    expect(derived).not.toEqual(stale);
  });

  it("U-OIDGATE-007: 既存 89 件 baseline は本変更で不変 (別集合 ratchet)", () => {
    const input = loadOracleTestTraceInput(process.cwd());
    expect(input.baseline.size).toBe(89);
    // 拡張債務が既存 baseline へ混入していないことの負の回帰網。
    for (const id of input.widenedBaseline) {
      expect(input.baseline.has(id)).toBe(false);
    }
  });
});

describe("逆向き test-label citation (Issue #259 / U-OIDGATE-008..015)", () => {
  const base = {
    declared: [],
    referenced: new Set<string>(),
    baseline: new Set<string>(),
    widenedBaseline: new Set<string>(),
  };

  it("U-OIDGATE-008: static label だけを収集し、本文の fake ID は無視する", () => {
    const root = citationFixture(
      [
        'it("U-ZZCITE-001: static label", () => {',
        '  const fixture = "U-ZZBODY-001";',
        "});",
        '// it("U-ZZCOMMENT-001: comment", () => {});',
      ].join("\n"),
    );
    expect(collectOracleCitationSites(root)).toEqual([
      {
        id: "U-ZZCITE-001",
        path: "tests/sample.test.ts",
        line: 1,
        kind: "static-test-label",
      },
    ]);
  });

  it("U-OIDGATE-009: chained label は収集し、data provider の ID は無視する", () => {
    const root = citationFixture(
      [
        'it.each([["U-ZZDATA-001"]])(\n  "U-ZZCITE-002: chained label",\n  () => {},\n);',
        'describe.skipIf(false)("U-ZZCITE-003: skipIf label", () => {});',
      ].join("\n"),
    );
    expect(collectOracleCitationSites(root).map((site) => site.id)).toEqual([
      "U-ZZCITE-002",
      "U-ZZCITE-003",
    ]);
  });

  it("U-OIDGATE-014: regex literal 内の引用符で後続 static label を消費しない", () => {
    const root = citationFixture(
      [
        'expect(csv).not.toMatch(/,"=cmd/);',
        'it("U-ZZCITE-004: label after regex", () => {});',
      ].join("\n"),
    );
    expect(collectOracleCitationSites(root).map((site) => site.id)).toEqual(["U-ZZCITE-004"]);
  });

  it("U-OIDGATE-015: skip/only/todo modifier の静的 label を収集する", () => {
    const root = citationFixture(
      [
        'it.skip("U-ZZCITE-005: skipped", () => {});',
        'describe.only("U-ZZCITE-006: focused", () => {});',
        'test.todo("U-ZZCITE-007: todo");',
      ].join("\n"),
    );
    expect(collectOracleCitationSites(root).map((site) => site.id)).toEqual([
      "U-ZZCITE-005",
      "U-ZZCITE-006",
      "U-ZZCITE-007",
    ]);
  });

  it("U-OIDGATE-010: 未宣言の新規 label citation は fail-close する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      citationSites: [
        { id: "U-ZZNEW-001", path: "tests/new.test.ts", line: 8, kind: "static-test-label" },
      ],
      citationBaseline: new Set(),
    });
    expect(r.undeclaredCitations.map((site) => site.id)).toEqual(["U-ZZNEW-001"]);
    expect(r.ok).toBe(false);
  });

  it("U-OIDGATE-011: 既存未宣言 label は baseline との集合一致で ratchet する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      citationSites: [
        { id: "U-ZZDEBT-001", path: "tests/debt.test.ts", line: 4, kind: "static-test-label" },
      ],
      citationBaseline: new Set(["U-ZZDEBT-001"]),
    });
    expect(r.undeclaredCitations).toEqual([]);
    expect(r.staleCitationBaseline).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-OIDGATE-012: 宣言済みになった baseline は stale として fail-close する", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      declared: ["U-ZZDEBT-002"],
      citationSites: [
        { id: "U-ZZDEBT-002", path: "tests/debt.test.ts", line: 5, kind: "static-test-label" },
      ],
      citationBaseline: new Set(["U-ZZDEBT-002"]),
    });
    expect(r.staleCitationBaseline).toEqual(["U-ZZDEBT-002"]);
    expect(r.ok).toBe(false);
  });

  it("U-OIDGATE-013: baseline 外の新規だけを citation finding にする", () => {
    const r = analyzeOracleTestTrace({
      ...base,
      citationSites: [
        { id: "U-ZZDEBT-003", path: "tests/debt.test.ts", line: 6, kind: "static-test-label" },
        { id: "U-ZZNEW-002", path: "tests/new.test.ts", line: 7, kind: "static-test-label" },
      ],
      citationBaseline: new Set(["U-ZZDEBT-003"]),
    });
    expect(r.undeclaredCitations.map((site) => site.id)).toEqual(["U-ZZNEW-002"]);
    expect(r.ok).toBe(false);
  });
});

describe("loadOracleTestTraceInput real repo (U-OTT-004/005)", () => {
  it("U-OTT-004: 実 repo の orphan は 0 (両 baseline 適用後、NEW oracle は fail-close 回帰網)", () => {
    const r = analyzeOracleTestTrace(loadOracleTestTraceInput(process.cwd()));
    expect(r.orphans).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.staleDuplicateBaseline).toEqual([]);
    expect(r.undeclaredCitations).toEqual([]);
    expect(r.staleCitationBaseline).toEqual([]);
  });

  it("U-OTT-005: baseline は既知の衝突 4 件のスナップショット (縮小のみ可)", () => {
    // 概要/候補と confirmed/freeze の構造的再掲は列スキーマで除外する一方、
    // U-PHOVER-002 の同一ID・別 oracle は既知債務として台帳に残す。
    expect(ORACLE_ID_DUPLICATE_BASELINE.size).toBe(4);
    expect(
      [...ORACLE_ID_DUPLICATE_BASELINE].filter((key) => key.startsWith("U-PHOVER-002\t")),
    ).toHaveLength(2);
  });

  it("U-OTT-006: 既存の citation baseline 89 件は本変更で不変", () => {
    expect(loadOracleTestTraceInput(process.cwd()).baseline.size).toBe(89);
  });

  it("U-OIDGATE-011: 実 repo の未宣言 test-label 集合は citation baseline と一致する", () => {
    const declared = new Set(collectOracleDeclarationSites(process.cwd()).map((site) => site.id));
    const { citationSites } = collectOracleIds(process.cwd());
    const { citationBaseline } = loadOracleTestTraceInput(process.cwd());
    expect(citationBaseline).toBeDefined();
    const derived = [
      ...new Set(citationSites.filter((site) => !declared.has(site.id)).map((site) => site.id)),
    ].sort();
    expect(derived).toEqual([...(citationBaseline as ReadonlySet<string>)].sort());
  });
});
