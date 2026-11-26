import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

function directCalls(statements: readonly ts.Statement[]) {
  return statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(ts.isCallExpression);
}

const cliSurfacePath = join(headSnapshotRoot(), "tests", "cli-surface.test.ts");
const program = ts.createProgram([cliSurfacePath], { noLib: true, noResolve: true, types: [] });
const sourceFile = program.getSourceFile(cliSurfacePath);
if (!sourceFile || program.getSyntacticDiagnostics(sourceFile).length > 0) {
  throw new Error("Could not parse the committed CLI surface test");
}

const suites = directCalls(sourceFile.statements).filter(
  ({ expression, arguments: [title] }) =>
    ts.isIdentifier(expression) &&
    expression.text === "describe" &&
    title != null &&
    ts.isStringLiteral(title) &&
    title.text === "L7 CLI surface closure",
);
const suiteBody = suites[0]?.arguments[1];
if (
  suites.length !== 1 ||
  !suiteBody ||
  !ts.isArrowFunction(suiteBody) ||
  !ts.isBlock(suiteBody.body)
) {
  throw new Error("Expected one L7 CLI surface suite with a block body");
}

const testTitle = "runs a named consumer-safe doctor profile without relying on setup-smoke alias";
const registrations = directCalls(suiteBody.body.statements).filter(
  ({ arguments: [title] }) =>
    title != null && ts.isStringLiteral(title) && title.text === testTitle,
);
const [registration] = registrations;
if (registrations.length !== 1 || !registration || !ts.isIdentifier(registration.expression)) {
  throw new Error(`Expected one direct registration for "${testTitle}"`);
}

const name = registration.expression.text;
const [, secondArg, thirdArg] = registration.arguments;
const [hookClass, duration] =
  name === "heavyIt" && secondArg && ts.isArrayLiteralExpression(secondArg)
    ? secondArg.elements
    : [undefined, thirdArg];
const observed = {
  name,
  hookClass: hookClass && ts.isStringLiteral(hookClass) ? hookClass.text : null,
  timeoutMs: duration && ts.isNumericLiteral(duration) ? Number(duration.text) : null,
};

it("U-CDPD-013: consumer-toolchain CLI test has the bounded db budget", () => {
  expect(observed).toEqual({ name: "heavyIt", hookClass: "db", timeoutMs: 40_000 });
});
