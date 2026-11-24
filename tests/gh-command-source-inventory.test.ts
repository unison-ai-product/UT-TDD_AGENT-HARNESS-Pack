import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const snapshotRoot = headSnapshotRoot();
const ghExecutors = new Set(["execFileSync", "spawnSync", "spawn", "run", "runGh"]);

const expectedLaunches = [
  "src/cli.ts:observeClaudeInboxPullRequest",
  "src/cli.ts:fetchRulesetsViaGh",
  "src/cli.ts:fetchRulesetsViaGh",
  "src/cli/review-live.ts:validateLiveReviewSubject",
  "src/cli/review-live.ts:publishLiveReviewReceipt",
  "src/setup/index.ts:nodeGh",
  "src/feedback/review-custody-runner.ts:processEnvironment.runGh",
  "src/feedback/adapters/gh-attestation-verifier.ts:createGhAttestationVerifier",
  "src/feedback/post-merge-backstop.ts:defaultFetchMergedPrPage",
  "src/feedback/review-merge-github.ts:readGhView",
  "src/feedback/review-merge-github.ts:readGhMergeCommitTree",
  "src/feedback/review-merge-github.ts:createGhPrMergePorts.mergePullRequest",
] as const;

const staticSites = [
  ["src/cli.ts:observeClaudeInboxPullRequest", 0, "inbox PR state"],
  ["src/cli.ts:fetchRulesetsViaGh", 0, "ruleset list"],
  ["src/cli.ts:fetchRulesetsViaGh", 1, "ruleset details"],
  ["src/feedback/review-custody-runner.ts:processEnvironment.runGh", 0, "review custody"],
  ["src/cli/review-live.ts:publishLiveReviewReceipt", 0, "live review comment"],
  ["src/feedback/review-merge-github.ts:readGhMergeCommitTree", 0, "merged commit lookup"],
] as const;

interface GhLaunch {
  site: string;
  call: ts.CallExpression;
}

function calleeName(call: ts.CallExpression): string {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

function functionPath(node: ts.Node): string {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const name =
      current.name ?? (ts.isPropertyAssignment(current.parent) ? current.parent.name : undefined);
    if (name) names.unshift(name.getText());
  }
  return names.join(".") || "<module>";
}

function stringEquals(node: ts.Expression | undefined, value: string): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === value;
}

function isAttestationDefault(call: ts.CallExpression, site: string): boolean {
  if (site !== "src/feedback/adapters/gh-attestation-verifier.ts:createGhAttestationVerifier") {
    return false;
  }
  if (calleeName(call) !== "defaultRunner") return false;
  const binary = call.arguments[0];
  return (
    stringEquals(binary, "gh") ||
    (binary !== undefined &&
      ts.isBinaryExpression(binary) &&
      binary.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      stringEquals(binary.right, "gh"))
  );
}

function isVersionProbe(call: ts.CallExpression, path: string): boolean {
  const args = call.arguments[1];
  return (
    path === "src/cli/distribution.ts" &&
    args !== undefined &&
    ts.isArrayLiteralExpression(args) &&
    args.elements.length === 1 &&
    stringEquals(args.elements[0], "--version")
  );
}

function isPropertyAccess(
  expression: ts.Expression | undefined,
  object: string,
  property: string,
): boolean {
  return (
    expression !== undefined &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === object &&
    expression.name.text === property
  );
}

function isTeamSpawn(call: ts.CallExpression): boolean {
  if (
    calleeName(call) !== "spawn" ||
    !isPropertyAccess(call.arguments[0], "invocation", "command")
  ) {
    return false;
  }
  for (let current = call.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && calleeName(current) === "executeTeamRunPlan") return true;
  }
  return false;
}

function scanTrackedSource(): { ghLaunches: GhLaunch[]; teamSpawns: ts.CallExpression[] } {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "src"], {
    cwd: snapshotRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.endsWith(".ts"));

  const ghLaunches: GhLaunch[] = [];
  const teamSpawns: ts.CallExpression[] = [];
  for (const path of paths) {
    const source = ts.createSourceFile(
      path,
      readFileSync(join(snapshotRoot, path), "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const literalGh =
          ghExecutors.has(calleeName(node)) && stringEquals(node.arguments[0], "gh");
        if (literalGh || calleeName(node) === "defaultRunner") {
          const site = `${path}:${functionPath(node)}`;
          if ((literalGh && !isVersionProbe(node, path)) || isAttestationDefault(node, site)) {
            ghLaunches.push({ site, call: node });
          }
        }
        if (path === "src/cli.ts" && isTeamSpawn(node)) teamSpawns.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { ghLaunches, teamSpawns };
}

function callOptions(call: ts.CallExpression | undefined): ts.ObjectLiteralExpression | undefined {
  const options = call?.arguments[2];
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
  if (name && ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function optionValue(options: ts.ObjectLiteralExpression | undefined, name: string) {
  const member = options?.properties.find((property) => propertyName(property.name) === name);
  return member && ts.isPropertyAssignment(member) ? member.initializer : undefined;
}

const { ghLaunches, teamSpawns } = scanTrackedSource();
const staticOptions = staticSites.map(([site, index, label]) => ({
  label,
  options: callOptions(ghLaunches.filter((launch) => launch.site === site)[index]?.call),
}));

describe("U-CMDINPUT-020 gh runtime options", () => {
  it("matches all twelve GitHub launch sites and locates the six static option objects", () => {
    expect(ghLaunches.map(({ site }) => site).sort()).toEqual([...expectedLaunches].sort());
    for (const { label, options } of staticOptions) {
      expect(options, label).toBeDefined();
    }
  });

  for (const { label, options } of staticOptions) {
    it(`${label} passes GH_COMMAND_TIMEOUT_MS`, () => {
      const timeout = optionValue(options, "timeout");
      expect(timeout && ts.isIdentifier(timeout) ? timeout.text : undefined).toBe(
        "GH_COMMAND_TIMEOUT_MS",
      );
    });

    it(`${label} suppresses prompts with the inherited environment`, () => {
      const env = optionValue(options, "env");
      expect(
        env !== undefined &&
          ts.isCallExpression(env) &&
          calleeName(env) === "ghCommandEnv" &&
          env.arguments.length === 1 &&
          isPropertyAccess(env.arguments[0], "process", "env"),
      ).toBe(true);
    });
  }
});

it("U-CMDINPUT-024 leaves the team run provider spawn without a timeout", () => {
  expect(teamSpawns).toHaveLength(1);
  const options = callOptions(teamSpawns[0]);
  expect(options).toBeDefined();
  expect(options?.properties.map(({ name }) => propertyName(name))).not.toContain("timeout");
});
