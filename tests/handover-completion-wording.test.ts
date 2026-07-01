import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkHandoverCompletionWording,
  GENERATED_BY,
  type HandoverDeps,
  type HandoverPointer,
} from "../src/handover/index";

const NOW = "2026-06-12T00:00:00.000Z";
const repoRoot = "/repo";
const pointerPath = join(repoRoot, ".ut-tdd", "handover", "CURRENT.json");
const residualAuditPath = join(
  repoRoot,
  ".ut-tdd",
  "audit",
  "A-133-upstream-vmodel-coverage-audit.md",
);
const handoverDoc = join(repoRoot, "docs", "handover", "session-handover-2026-06-12.md");

function mockDeps(): HandoverDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    repoRoot,
    now: () => NOW,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, content) => files.set(path, content),
    listDir: (dir) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`))
        .map((path) => path.slice(dir.length + 1)),
  };
}

function pointer(over: Partial<HandoverPointer> = {}): HandoverPointer {
  return {
    active_plan: "PLAN-L7-44-harness-db-projection",
    status: "completed",
    latest_doc: "docs/handover/session-handover-2026-06-12.md",
    digest_summary: { commits: 1, files: 1, failures: 0 },
    updated_at: NOW,
    generated_by: GENERATED_BY,
    doc_entry_count: 1,
    ...over,
  };
}

function residualAudit(status: string): string {
  return `# A-133

## Residual Feature Buckets

| Bucket | Sources | Required Forward Route | Current state | Target PLAN / Decision | Status |
|---|---|---|---|---|---|
| R1 | FR-L1-19 | L3/L7 | carry | PLAN-L3-04 | \`${status}\` |

## Next
`;
}

describe("handover completion wording guard", () => {
  it("warns when residual rows are non-closed and latest handover says no next action", () => {
    const deps = mockDeps();
    deps.files.set(pointerPath, JSON.stringify(pointer()));
    deps.files.set(residualAuditPath, residualAudit("scheduled"));
    deps.files.set(
      handoverDoc,
      "# Session Handover\n\n- L7 工程表は完了。次に着手する作業はなし。\n",
    );

    const warnings = checkHandoverCompletionWording(deps);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("residual rows remain non-closed");
    expect(warnings[0]).toContain("scheduled");
  });

  it("does not warn once residual rows are closed", () => {
    const deps = mockDeps();
    deps.files.set(pointerPath, JSON.stringify(pointer()));
    deps.files.set(residualAuditPath, residualAudit("closed"));
    deps.files.set(
      handoverDoc,
      "# Session Handover\n\n- L7 工程表は完了。次に着手する作業はなし。\n",
    );

    expect(checkHandoverCompletionWording(deps)).toEqual([]);
  });

  it("scans only CURRENT.json latest_doc", () => {
    const deps = mockDeps();
    deps.files.set(
      pointerPath,
      JSON.stringify(pointer({ latest_doc: "docs/handover/current.md" })),
    );
    deps.files.set(residualAuditPath, residualAudit("scheduled"));
    deps.files.set(handoverDoc, "# Session Handover\n\n- no next action\n");
    deps.files.set(join(repoRoot, "docs", "handover", "current.md"), "# Session Handover\n");

    expect(checkHandoverCompletionWording(deps)).toEqual([]);
  });
});
