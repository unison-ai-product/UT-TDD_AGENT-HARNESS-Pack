import { TestRunner } from "../../node_modules/vitest/dist/index.js";
import { testExpectScope } from "./vitest-assertion-required-expect.mjs";

export default class AssertionRequiredRunner extends TestRunner {
  assertionCallsByTask = new WeakMap();

  async runTask(task) {
    const run = TestRunner.getTestFn(task);
    const taskExpect = task.context.expect;
    const before = taskExpect.getState().assertionCalls;

    await testExpectScope.run(taskExpect, run);
    this.assertionCallsByTask.set(
      task,
      taskExpect.getState().assertionCalls - before,
    );
  }

  onAfterTryTask(task) {
    const assertionCalls = this.assertionCallsByTask.get(task);
    this.assertionCallsByTask.delete(task);
    super.onAfterTryTask(task);

    if (!task.fails && assertionCalls === 0) {
      throw new Error(
        `Test "${task.name}" completed without calling an assertion in its callback`,
      );
    }
  }
}
