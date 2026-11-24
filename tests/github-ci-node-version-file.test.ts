import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  analyzeGithubCiPolicy,
  type GithubWorkflowDoc,
  loadGithubCiPolicyDocs,
} from "../src/lint/github-ci-policy.ts";
import {
  analyzeToolchainPin,
  loadToolchainPinDocs,
  NODE_TOOLCHAIN_POLICY,
} from "../src/lint/toolchain-pin.ts";
import { CONSUMER_CI_WORKFLOW } from "../src/setup/consumer-ci-workflow.ts";

// repo 読みの入口を 1 箇所へ集約する (doctor test-repository-isolation の callsite 契約)。
const REPO_ROOT = process.cwd();
type Role = GithubWorkflowDoc["role"];
const LITERAL = `node-version: "${NODE_TOOLCHAIN_POLICY.nodeVersion}"`;
const FILE_FORM = "node-version-file: .node-version";
const REAL_DOCS = loadGithubCiPolicyDocs({
  repoRoot: REPO_ROOT,
  setupBuiltinWorkflow: CONSUMER_CI_WORKFLOW,
  runtimeProfile: "source",
});
// Pack policy fixture (tests/github-ci-policy.test.ts の PACK_WORKFLOW。非 export のため原文から切り出す)。
const PACK_FIXTURE = (/const PACK_WORKFLOW = `([\s\S]*?)\n`;/.exec(
  readFileSync(join(REPO_ROOT, "tests", "github-ci-policy.test.ts"), "utf8"),
) ?? [])[1] as string;
const SOURCE_ROLES: Role[] = ["runtime", "attestation_runtime", "pack_template"];
const CONSUMER_ROLES: Role[] = ["source_template", "setup_builtin"];

// Green 後の形: source workflow と Pack template は .node-version を参照し、consumer template は literal を保つ。
function greenDocs(): GithubWorkflowDoc[] {
  return REAL_DOCS.map((doc) =>
    doc.role === "runtime" || doc.role === "attestation_runtime" || doc.role === "pack_template"
      ? { ...doc, content: doc.content.split(LITERAL).join(FILE_FORM) }
      : doc,
  );
}

function mutate(role: Role, change: (content: string) => string): GithubWorkflowDoc[] {
  return greenDocs().map((doc) =>
    doc.role === role ? { ...doc, content: change(doc.content) } : doc,
  );
}

function replaceNth(content: string, needle: string, index: number, to: string): string {
  const parts = content.split(needle);
  expect(parts.length - 1).toBeGreaterThan(index);
  return parts.reduce(
    (acc, part, i) => (i === 0 ? part : `${acc}${i - 1 === index ? to : needle}${part}`),
    "",
  );
}

// 実ファイルを無加工で検査する。source workflow / attestation / Pack template は .node-version 参照、
// consumer template (実ファイルと CONSUMER_CI_WORKFLOW) は NODE_TOOLCHAIN_POLICY の literal を保つ。
function expectRealShape(roles: Role[]): void {
  for (const doc of REAL_DOCS.filter((d) => roles.includes(d.role))) {
    if (SOURCE_ROLES.includes(doc.role)) {
      expect(doc.content, `${doc.file} literal`).not.toContain(LITERAL);
      expect(doc.content, `${doc.file} file form`).toContain(FILE_FORM);
    } else {
      expect(doc.content, `${doc.file} consumer literal`).toContain(LITERAL);
      expect(doc.content, `${doc.file} no file form`).not.toContain(FILE_FORM);
    }
  }
}

function expectGreenShape(): void {
  expect(analyzeGithubCiPolicy(greenDocs()).violations).toEqual([]);
}

function expectViolation(docs: GithubWorkflowDoc[]): void {
  expect(analyzeGithubCiPolicy(docs).ok).toBe(false);
}

describe("Issue #1873 node-version-file Red oracles", () => {
  it.fails("CANDIDATE-U-CIPOL-042: runtime legs use node-version-file and reject literal or wrong path", () => {
    expectRealShape(["runtime"]);
    expectGreenShape();
    expectViolation(mutate("runtime", (c) => replaceNth(c, FILE_FORM, 1, LITERAL)));
    expectViolation(
      mutate("runtime", (c) => replaceNth(c, FILE_FORM, 2, "node-version-file: .nvmrc")),
    );
  });

  it.fails("CANDIDATE-U-CIPOL-043: aggregate setup-node uses node-version-file", () => {
    expectRealShape(["runtime"]);
    expectGreenShape();
    expectViolation(mutate("runtime", (c) => replaceNth(c, FILE_FORM, 4, LITERAL)));
  });

  it.fails("CANDIDATE-U-CIPOL-044: node-version and node-version-file together are a violation", () => {
    expectRealShape(["runtime"]);
    expectGreenShape();
    expectViolation(
      mutate("runtime", (c) => replaceNth(c, FILE_FORM, 0, `${FILE_FORM}\n          ${LITERAL}`)),
    );
  });

  it.fails("CANDIDATE-U-CIPOL-045: attestation and Pack template both use node-version-file", () => {
    expectRealShape(["attestation_runtime", "pack_template"]);
    expect(PACK_FIXTURE, "Pack policy fixture literal").not.toContain(LITERAL);
    expect(PACK_FIXTURE, "Pack policy fixture file form").toContain(FILE_FORM);
    expectGreenShape();
    expectViolation(mutate("attestation_runtime", (c) => c.split(FILE_FORM).join(LITERAL)));
    expectViolation(mutate("pack_template", (c) => c.split(FILE_FORM).join(LITERAL)));
  });

  it.fails("CANDIDATE-U-CIPOL-046: consumer template literal must equal NODE_TOOLCHAIN_POLICY.nodeVersion", () => {
    expectRealShape(CONSUMER_ROLES);
    expectGreenShape();
    for (const role of CONSUMER_ROLES) {
      expectViolation(mutate(role, (c) => c.split(LITERAL).join('node-version: "24.99.9"')));
      expectViolation(mutate(role, (c) => c.split(LITERAL).join(FILE_FORM)));
    }
  });

  it.fails("CANDIDATE-U-CIPOL-047: version chain keeps workflow green and flags a stale pin", () => {
    expectRealShape(["runtime"]);
    expectGreenShape();
    const pin = analyzeToolchainPin({ ...loadToolchainPinDocs(REPO_ROOT), nodeVersion: "24.99.9" });
    expect(pin.violations.map((v) => v.rule)).toContain("node-version-mismatch");
  });

  it.fails("CANDIDATE-U-CIPOL-048: setup-node must come after checkout in each job", () => {
    expectRealShape(["runtime"]);
    expectGreenShape();
    expectViolation(
      mutate("runtime", (content) => {
        const wf = parseYaml(content) as { jobs: Record<string, { steps: unknown[] }> };
        const steps = wf.jobs["harness-check-linux"]?.steps ?? [];
        const checkout = steps.findIndex((s) => JSON.stringify(s).includes("actions/checkout"));
        const setup = steps.findIndex((s) => JSON.stringify(s).includes("actions/setup-node"));
        expect(checkout).toBeGreaterThanOrEqual(0);
        expect(setup).toBeGreaterThan(checkout);
        [steps[checkout], steps[setup]] = [steps[setup], steps[checkout]];
        return stringifyYaml(wf);
      }),
    );
  });
});
