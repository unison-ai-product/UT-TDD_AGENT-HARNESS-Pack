import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { HOOK_BOUND_MS } from "./support/hook-bounds.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

function directCalls(statements: readonly ts.Statement[]) {
  return statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(ts.isCallExpression);
}

const path = join(headSnapshotRoot(), "tests", "gate-run-bootstrap-retry.test.ts");
const program = ts.createProgram([path], { noLib: true, noResolve: true, types: [] });
const file = program.getSourceFile(path);
if (!file || program.getSyntacticDiagnostics(file).length > 0) {
  throw new Error("Could not parse the bootstrap retry test");
}

const suites = directCalls(file.statements).filter(
  ({ expression, arguments: [title] }) =>
    ts.isIdentifier(expression) &&
    expression.text === "describe" &&
    title != null &&
    ts.isStringLiteral(title) &&
    title.text === "gate-run bootstrap retry oracles",
);
const suiteBody = suites[0]?.arguments[1];
if (
  suites.length !== 1 ||
  !suiteBody ||
  !ts.isArrowFunction(suiteBody) ||
  !ts.isBlock(suiteBody.body)
) {
  throw new Error("Expected one bootstrap retry suite with a block body");
}

const hooks = directCalls(suiteBody.body.statements).filter(
  ({ expression }) =>
    ts.isIdentifier(expression) && ["beforeAll", "heavyBeforeAll"].includes(expression.text),
);
const [hook] = hooks;
if (hooks.length !== 1 || !hook || !ts.isIdentifier(hook.expression)) {
  throw new Error("Expected one bootstrap retry preparation hook");
}
const [firstArg] = hook.arguments;
const hookClass = firstArg && ts.isStringLiteral(firstArg) ? firstArg.text : null;

const registration = {
  name: hook.expression.text,
  hookClass,
  timeoutMs: hookClass === "db" ? HOOK_BOUND_MS.db : null,
};

it("U-GRBOOT-005: suite preparation uses the shared db hook bound", () => {
  expect(registration).toEqual({
    name: "heavyBeforeAll",
    hookClass: "db",
    timeoutMs: 180_000,
  });
});
