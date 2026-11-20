import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFullDoctorCheckDefinitions } from "../src/doctor/check-definitions.ts";
import { FULL_DOCTOR_OUTPUT_IDS } from "../src/doctor/profiles.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import { analyzeL14CloseAudit, loadL14CloseAuditDocs } from "../src/lint/l14-close-audit.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const snapshotRoot = headSnapshotRoot();

const retiredChecks = [
  "merged-plan-status",
  "plan-body-substance",
  "plan-completion-drift",
  "green-command-digest",
  "review-evidence",
  "guardrail-invariants",
];
const retiredModules = [
  "merged-plan-status",
  "plan-body-substance",
  "plan-completion-drift",
  "green-command-digest",
  "merged-plan-target-evidence",
];

function typescriptPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptPaths(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function commandName(node: ts.Node, receiver: string): string | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "command" ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== receiver
  )
    return undefined;
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function githubCommandSurface(source: string): { groupFound: boolean; children: string[] } {
  const file = ts.createSourceFile(
    "src/cli.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let groupFound = false;
  const children: string[] = [];
  const findGithubGroup = (node: ts.Node): void => {
    if (commandName(node, "program") === "github") groupFound = true;
    ts.forEachChild(node, findGithubGroup);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "github" &&
      node.initializer
    )
      findGithubGroup(node.initializer);
    const child = commandName(node, "github");
    if (child !== undefined) children.push(child);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { groupFound, children };
}

function commandOptionSurface(
  source: string,
  parent: string,
  command: string,
): { all: string[]; required: string[] } {
  const file = ts.createSourceFile(
    "src/cli.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let target: ts.CallExpression | undefined;
  const all: string[] = [];
  const required: string[] = [];
  const isCallWithin = (expression: ts.Expression, targetCall: ts.CallExpression): boolean => {
    let current: ts.Expression = expression;
    while (ts.isCallExpression(current)) {
      if (current === targetCall) return true;
      if (!ts.isPropertyAccessExpression(current.expression)) return false;
      current = current.expression.expression;
    }
    return false;
  };
  const findTarget = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "command" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === parent &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === command
    )
      target = node;
    ts.forEachChild(node, findTarget);
  };
  findTarget(file);
  const visit = (node: ts.Node): void => {
    if (
      target &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["option", "requiredOption"].includes(node.expression.name.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isCallWithin(node.expression.expression, target)
    ) {
      const name = node.arguments[0].text.split(/[\s,[]/u)[0] ?? "";
      all.push(name);
      if (node.expression.name.text === "requiredOption") required.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { all, required };
}

function testCallbacks(source: string, path: string): Map<string, string> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const callbacks = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "it" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1]
    )
      callbacks.set(node.arguments[0].text, node.arguments[1].getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return callbacks;
}

const retiredForwardStoreTestIds = [
  "U-GHPROJ-011",
  "U-GHPROJ-013",
  "U-GHPROJ-014",
  "U-GHPROJ-015",
  "U-GHPROJ-033",
  "U-GHPROJ-038",
  "U-GHPROJ-039",
  "U-GHPROJ-040",
  "U-GHPROJ-041",
  "U-GHPROJ-044",
  "U-GHPROJ-045",
  "U-GHPROJ-052",
];

describe("PLAN 機構の S1 退役", () => {
  it("CANDIDATE-U-PLANRET-015: 専用検査・flag・監査の必須参照を同期退役する", () => {
    const checkIds = buildFullDoctorCheckDefinitions(nodeDoctorDeps(snapshotRoot)).map(
      ({ id }) => id,
    );
    for (const id of retiredChecks) {
      expect(checkIds).not.toContain(id);
      expect(FULL_DOCTOR_OUTPUT_IDS).not.toContain(id);
    }
    for (const name of retiredModules) {
      expect(existsSync(join(snapshotRoot, "src", "lint", `${name}.ts`)), name).toBe(false);
      expect(existsSync(join(snapshotRoot, "tests", `${name}.test.ts`)), name).toBe(false);
    }
    const retiredFlag = "--strict-green-command-digest";
    expect(
      readFileSync(join(snapshotRoot, ".github/workflows/harness-check.yml"), "utf8"),
    ).not.toContain(retiredFlag);
    for (const path of typescriptPaths(join(snapshotRoot, "src"))) {
      expect(readFileSync(path, "utf8"), path).not.toContain(retiredFlag);
    }
    const audit = analyzeL14CloseAudit(loadL14CloseAuditDocs(snapshotRoot), snapshotRoot);
    expect(audit.ok, JSON.stringify(audit.violations)).toBe(true);
    const row = audit.rows.find(({ item }) => item === "green-evidence-integrity");
    if (!row) throw new Error("green-evidence-integrity audit row is missing");
    expect(row.status).toBe("closed");
    expect(row.evidencePaths).not.toContain("src/lint/green-command-digest.ts");
    expect(row.evidencePaths).not.toContain("tests/green-command-digest.test.ts");
    expect(row.evidencePaths).toContain(
      ".ut-tdd/audit/A-155-green-command-digest-rebind-2026-07-01.md",
    );
    expect(row.evidencePaths).toContain(
      ".ut-tdd/audit/A-156-pack-repo-default-and-digest-rebind-2026-07-01.md",
    );
  });
});

describe("PLAN 機構の S4 退役", () => {
  it("U-PLANRET-014: task分類・routingとskill推薦にPLAN入力optionを残さない", () => {
    const cliSource = readFileSync(join(snapshotRoot, "src/cli.ts"), "utf8");
    const classifyOptions = commandOptionSurface(cliSource, "task", "classify").all;
    const routeOptions = commandOptionSurface(cliSource, "task", "route").all;
    const skillOptions = commandOptionSurface(cliSource, "skill", "suggest").all;
    const recordOptions = commandOptionSurface(cliSource, "elicit", "record");
    const noPlanSurfaces: Array<[string, string[]]> = [
      ["handover", commandOptionSurface(cliSource, "program", "handover").all],
      ["provider handover", commandOptionSurface(cliSource, "providerHandover", "export").all],
      ["skill suggest", skillOptions],
      ["advisor", commandOptionSurface(cliSource, "program", "advisor").all],
      ["gate", commandOptionSurface(cliSource, "program", "gate <id>").all],
      ["task classify", classifyOptions],
      ["task route", routeOptions],
      ["team run", commandOptionSurface(cliSource, "team", "run").all],
      ["github pr render", commandOptionSurface(cliSource, "githubPr", "render").all],
      ["elicit context", commandOptionSurface(cliSource, "elicit", "context").all],
      ["elicit record", recordOptions.all],
    ];
    const feedbackSource = readFileSync(join(snapshotRoot, "src/cli/feedback.ts"), "utf8");
    const delegationSource = readFileSync(join(snapshotRoot, "src/cli/delegation.ts"), "utf8");
    noPlanSurfaces.push([
      "feedback classify",
      commandOptionSurface(feedbackSource, "feedback", "classify").all,
    ]);
    const workflowSource = readFileSync(
      join(snapshotRoot, "src/forward/adapters/cli-registrar.ts"),
      "utf8",
    );

    expect(classifyOptions).toContain("--text");
    expect(classifyOptions).toContain("--text-file");
    expect(classifyOptions).not.toContain("--plan");
    expect(routeOptions).toContain("--text");
    expect(routeOptions).toContain("--text-file");
    expect(routeOptions).not.toContain("--plan");
    expect(skillOptions).toContain("--text");
    expect(skillOptions).not.toContain("--plan");
    expect(skillOptions).not.toContain("--record");
    for (const [surface, options] of noPlanSurfaces)
      expect(options, `${surface} has no --plan`).not.toContain("--plan");
    expect(commandOptionSurface(cliSource, "githubPr", "render").all).not.toContain(
      "--plan-revision",
    );
    expect(cliSource).not.toContain("planId: opts.plan");
    expect(cliSource).not.toContain("resolveSkillContextInjection(opts.plan)");
    expect(cliSource).not.toContain("resolveActivePlan(nodeDeps(process.cwd(), gitBranch))");
    expect(recordOptions.required).toContain("--issue");
    expect(recordOptions.all).not.toContain("--plan");
    expect(feedbackSource).not.toContain("resolveActivePlan");
    expect(delegationSource).not.toContain("planId");
    expect(delegationSource).not.toContain("plan_id");
    for (const command of ["status", "transition", "explain"]) {
      const workflowOptions = commandOptionSurface(workflowSource, "workflow", command);
      expect(workflowOptions.required, `workflow ${command} requires --issue`).toContain("--issue");
      expect(workflowOptions.all, `workflow ${command} has no --plan`).not.toContain("--plan");
    }
  });

  it("U-PLANRET-025: Issue Form の起点・再合流先はIssueで案内する", () => {
    const formDir = join(snapshotRoot, ".github/ISSUE_TEMPLATE");
    const config = parseYaml(readFileSync(join(formDir, "config.yml"), "utf8")) as {
      blank_issues_enabled?: boolean;
    };
    expect(config.blank_issues_enabled).toBe(false);
    const forms = [
      "recovery.yml",
      "reverse.yml",
      "redesign.yml",
      "incident.yml",
      "nfr-failure.yml",
    ];
    for (const name of forms) {
      const raw = readFileSync(join(formDir, name), "utf8");
      const form = parseYaml(raw) as {
        body?: Array<{
          id?: string;
          validations?: { required?: boolean };
          attributes?: { label?: string; description?: string; placeholder?: string };
        }>;
      };
      const body = form.body ?? [];
      const reentry = body.filter((item) => item.id === "reentry_target");
      expect(reentry).toHaveLength(1);
      expect(reentry[0].validations?.required).toBe(true);
      expect(reentry[0].attributes?.label).toBe("Reentry target (Forward 再合流先 Issue / layer)");
      expect(reentry[0].attributes?.description).toMatch(/Issue URL|layer/u);
      expect(body.map((item) => item.id)).not.toContain("origin_plan");
      expect(body.map((item) => item.id)).not.toContain("origin_revision");
      for (const field of body) {
        const attributes = field.attributes ?? {};
        for (const value of [attributes.label, attributes.description, attributes.placeholder])
          if (typeof value === "string")
            expect(value).not.toMatch(/PLAN(?:-L\d+-| ID|[- ]input)/iu);
      }
      if (["recovery.yml", "reverse.yml", "redesign.yml"].includes(name)) {
        const origin = body.filter((item) => item.id === "origin_issue");
        expect(origin).toHaveLength(1);
        expect(origin[0].validations?.required).toBe(true);
        expect(origin[0].attributes?.label).toBe("Origin Issue URL");
        expect(origin[0].attributes?.placeholder).toBe(
          "https://github.com/<owner>/<repo>/issues/<number>",
        );
        expect(origin[0].attributes?.description).toMatch(/canonical Issue URL/u);
      }
      const header = raw.split(/\r?\n/u).slice(0, 6).join("\n");
      expect(header).not.toMatch(/PLAN(?:-L\d+-| ID|[- ]input)/iu);
    }
  });
});

describe("PLAN 機構の S5 退役", () => {
  it("U-PLANRET-014: S5のProject/binding surfaceを退役し、outboxを保持する", () => {
    const cliSource = readFileSync(join(snapshotRoot, "src/cli.ts"), "utf8");
    const github = githubCommandSurface(cliSource);
    expect(github.groupFound).toBe(true);
    expect(github.children).toContain("guard");
    expect(github.children).toContain("pr");
    expect(github.children).not.toContain("project");
    expect(github.children).not.toContain("binding");

    for (const path of [
      "src/github/project-v2.ts",
      "src/github/repository-bindings.ts",
      "tests/github-project-v2.test.ts",
      "tests/github-repository-bindings.test.ts",
    ])
      expect(existsSync(join(snapshotRoot, path)), path).toBe(false);

    expect(
      existsSync(join(snapshotRoot, "src/state-db/github-forward-projection.ts")),
      "github-forward-projection",
    ).toBe(false);

    const forwardStorePath = "tests/github-forward-store.test.ts";
    const forwardStoreSource = readFileSync(join(snapshotRoot, forwardStorePath), "utf8");
    const forwardStoreCases = testCallbacks(forwardStoreSource, forwardStorePath);
    const actualForwardStoreIds = [...forwardStoreCases.keys()]
      .map((title) => title.match(/^U-GHPROJ-\d{3}/)?.[0])
      .filter((id): id is string => id !== undefined)
      .sort();
    for (const id of retiredForwardStoreTestIds)
      expect(actualForwardStoreIds, id).not.toContain(id);
    expect(actualForwardStoreIds).toEqual(["U-GHPROJ-012"]);

    const pendingCase = [...forwardStoreCases].find(([title]) =>
      title.startsWith("U-GHPROJ-012:"),
    )?.[1];
    expect(pendingCase).toContain("INSERT INTO github_projection_outbox");

    expect(forwardStoreSource).not.toContain("recordGithubBinding");
  });
});
