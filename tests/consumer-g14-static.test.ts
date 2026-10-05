import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as rightArmStatic from "../src/gate/right-arm-static.ts";
import { evaluateStaticGate } from "../src/gate/static.ts";

const roots: string[] = [];

interface MutableJsonRecord extends Record<string, unknown> {
  artifacts?: MutableJsonRecord;
  commands?: MutableJsonRecord[];
  coverage?: MutableJsonRecord[];
  exit_criteria?: MutableJsonRecord;
  items?: MutableJsonRecord[];
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-g14-"));
  roots.push(root);
  write(
    root,
    "docs/design/L1-consumer/functional-requirements.md",
    "---\ndoc_type_id: DOC-L1-FUNCTIONAL-REQUIREMENTS\n---\n\n**FR-L1-01**\n**BR-01**\n",
  );
  write(
    root,
    "docs/plans/PLAN-L0-01-consumer-charter.md",
    "---\nplan_id: PLAN-L0-01-consumer-charter\n---\n",
  );
  write(root, "docs/plans/PLAN-CONSUMER-01.md", "---\nplan_id: PLAN-CONSUMER-01\n---\n");
  const template = readFileSync(
    join(process.cwd(), "docs/templates/vmodel/L14-operational-test-design.md"),
    "utf8",
  );
  const content = template
    .replace("status: draft", "status: confirmed")
    .replace("plan: docs/plans/PLAN-<id>.md", "plan: docs/plans/PLAN-CONSUMER-01.md")
    .replace(
      "| <記入> | <記入> | <記入> | <記入> | <記入> |",
      "| OT-CONSUMER-01 | OT | 日常運用の手順 | 失敗 0 | FR-L1-01 |\n| OT-CONSUMER-02 | VALUE | 導入価値の検証 | KPI 達成 | BR-01 / PLAN-L0-01-consumer-charter |",
    );
  write(root, "docs/test-design/L14-operational-test-design.md", content);
  write(root, "tests/fixtures/g14-consumer/operational-results.txt", "passed\n");
  write(root, "tests/fixtures/g14-consumer/value-results.txt", "passed\n");
  write(root, "tests/fixtures/g14-consumer/command-output.txt", "passed\n");
  write(
    root,
    ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
    json({
      items: [
        { summary: "onboarding 手順の短縮", routed_to: "PLAN-CONSUMER-01" },
        {
          summary: "doctor 出力の整理",
          routed_to: "https://github.com/example/consumer/issues/12",
        },
      ],
    }),
  );
  write(
    root,
    ".ut-tdd/evidence/g14-operational/ok.json",
    json({
      schema_version: "g14-operational-evidence-v1",
      gate: "G14",
      profile: "consumer-operational-minimum",
      plan_id: "PLAN-CONSUMER-01",
      selected_ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
      mandatory_ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
      deferred_ot_ids: [],
      commands: [
        {
          command_id: "cmd-consumer-operational",
          command: "npm test",
          runner: "node",
          scope: "consumer",
          exit_code: 0,
          output_digest: `sha256:${"a".repeat(64)}`,
          evidence_path: "tests/fixtures/g14-consumer/command-output.txt",
          ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
        },
      ],
      coverage: [
        {
          ot_id: "OT-CONSUMER-01",
          status: "passed",
          evidence_paths: ["tests/fixtures/g14-consumer/operational-results.txt"],
          command_ids: ["cmd-consumer-operational"],
        },
        {
          ot_id: "OT-CONSUMER-02",
          status: "passed",
          evidence_paths: ["tests/fixtures/g14-consumer/value-results.txt"],
          command_ids: ["cmd-consumer-operational"],
        },
      ],
      defer: [],
      exit_criteria: {
        all_mandatory_passed: true,
        failed_mandatory_count: 0,
        stale_defer_count: 0,
        doctor_check: "g14-operational-workflow",
      },
      artifacts: {
        operational_results: "tests/fixtures/g14-consumer/operational-results.txt",
        value_results: "tests/fixtures/g14-consumer/value-results.txt",
        improvement_feedback: ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
      },
    }),
  );
  return root;
}

function evaluate(root: string) {
  return evaluateStaticGate({ gate: "G14", repoRoot: root });
}

function manifestPath(root: string): string {
  return join(root, ".ut-tdd/evidence/g14-operational/ok.json");
}

function feedbackPath(root: string): string {
  return join(root, ".ut-tdd/evidence/g14-operational/artifacts/feedback.json");
}

function updateJson(path: string, mutate: (value: MutableJsonRecord) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as MutableJsonRecord;
  mutate(value);
  writeFileSync(path, json(value), "utf8");
}

function requiredRecord(value: unknown): MutableJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture mutation expected an object");
  }
  return value as MutableJsonRecord;
}

function requiredRecords(value: unknown): MutableJsonRecord[] {
  if (!Array.isArray(value)) throw new Error("fixture mutation expected an array");
  return value.map(requiredRecord);
}

function requiredRecordAt(value: unknown, index: number): MutableJsonRecord {
  const record = requiredRecords(value)[index];
  if (!record) throw new Error("fixture mutation expected an array item");
  return record;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("consumer G14 right-arm static gate (U-RCDEV-035)", () => {
  it("accepts the frozen normal shape and keeps PO review explicitly pending", () => {
    const root = consumerFixture();
    const result = evaluate(root);
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages).toContain("right-arm-static - OK (G14, cases=2, manifests=1)");
    expect(result.messages.join("\n")).toContain("未判定 (review): PO");
  });

  it("uses the catalog's generic L14 test-design slot, not the contract engine-swap slot", () => {
    const root = consumerFixture();
    const result = evaluate(root);
    expect(result.passed).toBe(true);
    expect(
      existsSync(join(root, "docs/test-design/L14-vmodel-engine-swap-operational-test-design.md")),
    ).toBe(false);
  });

  it("pins the G14 detector constants to the DOC-L14-OPERATIONAL-TEST catalog row", () => {
    const catalog = readFileSync(
      join(process.cwd(), "docs/governance/vmodel-document-catalog.md"),
      "utf8",
    );
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L14-operational-test-design.md"),
      "utf8",
    );
    expect(rightArmStatic.G14_STATIC_SLOT).toEqual({
      docTypeId: "DOC-L14-OPERATIONAL-TEST",
      harnessPath: "docs/test-design/harness/L14-operational-test-design.md",
    });
    const row = catalog.split(/\r?\n/).find((line) => line.includes("`DOC-L14-OPERATIONAL-TEST`"));
    expect(row).toContain("`test-design`");
    expect(row).toContain("`docs/test-design/harness/L14-operational-test-design.md`");
    expect(template).toContain("### harness 追補: G14 検証ケース");
    expect(template).toContain(
      "`### harness 追補:` で始まる節は ZIP 由来ではなく、harness の gate 判定のために追加した節である。",
    );
  });

  it("fails closed when the case table shape or generic slot is wrong", () => {
    const root = consumerFixture();
    const slot = join(root, "docs/test-design/L14-operational-test-design.md");
    const original = readFileSync(slot, "utf8");
    writeFileSync(
      slot,
      original.replace("### harness 追補: G14 検証ケース", "### removed section"),
      "utf8",
    );
    expect(evaluate(root).messages.join("\n")).toContain(
      "missing section ### harness 追補: G14 検証ケース",
    );
    writeFileSync(slot, original.replace("| family |", "| family omitted |"), "utf8");
    const columnsFailure = evaluate(root).messages.join("\n");
    expect(columnsFailure).toContain("required case table columns");
    expect(columnsFailure).toContain("missing section");
    writeFileSync(
      slot,
      readFileSync(slot, "utf8").replace("DOC-L14-OPERATIONAL-TEST", "DOC-L14-WRONG"),
      "utf8",
    );
    expect(evaluate(root).messages.join("\n")).toContain("missing slot DOC-L14-OPERATIONAL-TEST");
  });

  it("does not substitute the contract engine-swap path for the frozen generic slot", () => {
    const root = consumerFixture();
    const generic = join(root, "docs/test-design/L14-operational-test-design.md");
    const engineSwap = join(
      root,
      "docs/test-design/L14-vmodel-engine-swap-operational-test-design.md",
    );
    writeFileSync(engineSwap, readFileSync(generic, "utf8"), "utf8");
    rmSync(generic);
    expect(evaluate(root).messages.join("\n")).toContain("missing slot DOC-L14-OPERATIONAL-TEST");
  });

  it.each([
    [
      "duplicate case ID",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(
          slot,
          readFileSync(slot, "utf8").replace("OT-CONSUMER-02", "OT-CONSUMER-01"),
          "utf8",
        );
      },
      "duplicate case id OT-CONSUMER-01",
    ],
    [
      "missing VALUE family",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(
          slot,
          readFileSync(slot, "utf8").replace(
            "| OT-CONSUMER-02 | VALUE |",
            "| OT-CONSUMER-02 | OT |",
          ),
          "utf8",
        );
      },
      "missing evidence family VALUE",
    ],
    [
      "unsupported family",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(
          slot,
          readFileSync(slot, "utf8").replace(
            "| OT-CONSUMER-02 | VALUE |",
            "| OT-CONSUMER-02 | SMOKE |",
          ),
          "utf8",
        );
      },
      "invalid evidence family SMOKE for OT-CONSUMER-02",
    ],
    [
      "VALUE without L0 citation",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(
          slot,
          readFileSync(slot, "utf8").replace("BR-01 / PLAN-L0-01-consumer-charter", "BR-01"),
          "utf8",
        );
      },
      "value case OT-CONSUMER-02 does not cite L0 (file the L0 charter as docs/plans/PLAN-L0-*.md and cite its plan_id)",
    ],
    [
      "missing L0 target",
      (root: string) => rmSync(join(root, "docs/plans/PLAN-L0-01-consumer-charter.md")),
      "trace target missing PLAN-L0-01-consumer-charter",
    ],
    [
      "non-L0 PLAN citation",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(
          slot,
          readFileSync(slot, "utf8").replace("PLAN-L0-01-consumer-charter", "PLAN-CONSUMER-01"),
          "utf8",
        );
      },
      "value case OT-CONSUMER-02 does not cite L0",
    ],
    [
      "untraced OT row",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(slot, readFileSync(slot, "utf8").replace("FR-L1-01", ""), "utf8");
      },
      "untraced case OT-CONSUMER-01",
    ],
    [
      "undefined citation",
      (root: string) => {
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(slot, readFileSync(slot, "utf8").replace("FR-L1-01", "FR-L1-99"), "utf8");
      },
      "trace target missing FR-L1-99",
    ],
    [
      "defined non-pair citation",
      (root: string) => {
        write(root, "docs/design/L3-consumer/nfr-grade.md", "| **NFR-01** | example |\n");
        const slot = join(root, "docs/test-design/L14-operational-test-design.md");
        writeFileSync(slot, readFileSync(slot, "utf8").replace("FR-L1-01", "NFR-01"), "utf8");
      },
      "untraced case OT-CONSUMER-01",
    ],
    [
      "missing mandatory row evidence",
      (root: string) =>
        updateJson(manifestPath(root), (value) => {
          value.mandatory_ot_ids = ["OT-CONSUMER-01"];
          value.selected_ot_ids = ["OT-CONSUMER-01"];
          requiredRecordAt(value.commands, 0).ot_ids = ["OT-CONSUMER-01"];
          value.coverage = requiredRecords(value.coverage).filter(
            (entry) => entry.ot_id === "OT-CONSUMER-01",
          );
        }),
      "missing row evidence OT-CONSUMER-02",
    ],
    [
      "missing required artifact",
      (root: string) =>
        updateJson(manifestPath(root), (value) => {
          delete requiredRecord(value.artifacts).value_results;
        }),
      "missing artifact value_results",
    ],
    [
      "missing feedback routed_to",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          delete requiredRecordAt(value.items, 0).routed_to;
        }),
      "improvement_feedback.items[0].routed_to is required",
    ],
    [
      "missing improvement decision",
      (root: string) => writeFileSync(feedbackPath(root), json({ items: [] }), "utf8"),
      "improvement_feedback.items is required",
    ],
    [
      "empty-improvement accepted",
      (root: string) =>
        writeFileSync(feedbackPath(root), json({ items: [], no_improvement: true }), "utf8"),
      "right-arm-static - OK (G14, cases=2, manifests=1)",
    ],
    [
      "mutually exclusive improvement shape",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          value.no_improvement = true;
        }),
      "improvement_feedback declares no_improvement with items",
    ],
    [
      "no_improvement must be boolean",
      (root: string) =>
        writeFileSync(feedbackPath(root), json({ items: [], no_improvement: "true" }), "utf8"),
      "improvement_feedback.no_improvement must be boolean",
    ],
    [
      "false no_improvement does not waive items",
      (root: string) =>
        writeFileSync(feedbackPath(root), json({ items: [], no_improvement: false }), "utf8"),
      "improvement_feedback.items is required",
    ],
    [
      "feedback summary is required",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          requiredRecordAt(value.items, 0).summary = "";
        }),
      "improvement_feedback.items[0].summary is required",
    ],
    [
      "feedback PLAN must exist",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          requiredRecordAt(value.items, 0).routed_to = "PLAN-L9-999-missing";
        }),
      "improvement_feedback.items[0] routed_to PLAN-L9-999-missing does not exist",
    ],
    [
      "feedback Issue must use Issue URL form",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          requiredRecordAt(value.items, 1).routed_to = "#12";
        }),
      "improvement_feedback.items[1] routed_to #12 is not a PLAN or Issue URL",
    ],
    [
      "feedback Issue URL must use issue path",
      (root: string) =>
        updateJson(feedbackPath(root), (value) => {
          requiredRecordAt(value.items, 1).routed_to =
            "https://github.com/example/consumer/pull/12";
        }),
      "improvement_feedback.items[1] routed_to https://github.com/example/consumer/pull/12 is not a PLAN or Issue URL",
    ],
    [
      "feedback must be a JSON object",
      (root: string) => writeFileSync(feedbackPath(root), "not json\n", "utf8"),
      "invalid artifact improvement_feedback: JSON object required",
    ],
  ] as const)("rejects or permits the frozen %s axis", (_name, mutate, expected) => {
    const root = consumerFixture();
    mutate(root);
    const result = evaluate(root);
    if (expected.startsWith("right-arm-static - OK")) expect(result.passed).toBe(true);
    else expect(result.messages.join("\n")).toContain(expected);
  });

  it("keeps trace misses and the L0-specific VALUE rule distinct", () => {
    const missingL0 = consumerFixture();
    rmSync(join(missingL0, "docs/plans/PLAN-L0-01-consumer-charter.md"));
    const missingL0Message = evaluate(missingL0).messages.join("\n");
    expect(missingL0Message).toContain("trace target missing PLAN-L0-01-consumer-charter");
    expect(missingL0Message).toContain("value case OT-CONSUMER-02 does not cite L0");
    expect(missingL0Message).toContain(
      "file the L0 charter as docs/plans/PLAN-L0-*.md and cite its plan_id",
    );

    const nonL0Plan = consumerFixture();
    const slot = join(nonL0Plan, "docs/test-design/L14-operational-test-design.md");
    writeFileSync(
      slot,
      readFileSync(slot, "utf8").replace("PLAN-L0-01-consumer-charter", "PLAN-CONSUMER-01"),
      "utf8",
    );
    const nonL0Message = evaluate(nonL0Plan).messages.join("\n");
    expect(nonL0Message).toContain("value case OT-CONSUMER-02 does not cite L0");
    expect(nonL0Message).toContain("trace target missing PLAN-CONSUMER-01");
  });

  it("allows defined non-pair IDs without misreporting them as missing targets", () => {
    const root = consumerFixture();
    write(root, "docs/design/L3-consumer/nfr-grade.md", "| **NFR-01** | example |\n");
    const slot = join(root, "docs/test-design/L14-operational-test-design.md");
    writeFileSync(slot, readFileSync(slot, "utf8").replace("FR-L1-01", "NFR-01"), "utf8");
    const message = evaluate(root).messages.join("\n");
    expect(message).toContain("untraced case OT-CONSUMER-01");
    expect(message).not.toContain("trace target missing NFR-01");
  });

  it("does not call the network to validate Issue URL routing", () => {
    const root = consumerFixture();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    expect(evaluate(root).passed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "schema_version",
      (value: MutableJsonRecord) => {
        value.schema_version = "g13-post-deploy-evidence-v1";
      },
      "invalid schema_version",
    ],
    [
      "gate",
      (value: MutableJsonRecord) => {
        value.gate = "G13";
      },
      "gate must be G14",
    ],
    [
      "command exit",
      (value: MutableJsonRecord) => {
        requiredRecordAt(value.commands, 0).exit_code = 1;
      },
      "exit_code is non-zero",
    ],
    [
      "command digest",
      (value: MutableJsonRecord) => {
        requiredRecordAt(value.commands, 0).output_digest = `sha256:${"a".repeat(63)}`;
      },
      "invalid digest",
    ],
    [
      "exit criteria type",
      (value: MutableJsonRecord) => {
        requiredRecord(value.exit_criteria).stale_defer_count = "0";
      },
      "stale_defer_count must be 0",
    ],
  ] as const)("validates G14 evidence manifest %s", (_name, mutate, expected) => {
    const root = consumerFixture();
    updateJson(manifestPath(root), mutate);
    expect(evaluate(root).messages.join("\n")).toContain(expected);
  });

  it("routes OT manifest fields independently from G13 smoke fields", () => {
    const root = consumerFixture();
    updateJson(manifestPath(root), (value) => {
      value.mandatory_smoke_ids = value.mandatory_ot_ids;
      delete value.mandatory_ot_ids;
    });
    const message = evaluate(root).messages.join("\n");
    expect(message).toContain("missing row evidence OT-CONSUMER-01");
    expect(message).toContain("missing row evidence OT-CONSUMER-02");
  });
});
