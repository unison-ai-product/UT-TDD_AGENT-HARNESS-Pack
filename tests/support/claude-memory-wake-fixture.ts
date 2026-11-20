import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heavyAfterAll, heavyBeforeAll } from "./hook-bounds.ts";
import { ensureTrackedProjectIdentity } from "./project-identity-fixture.ts";
import { removeTestTree } from "./temp-tree.ts";

/**
 * Seeds one tracked git repo (build) and hands out an identical, isolated copy
 * per test (copy). Each copy keeps its own .git, so runtime state under the
 * git common dir is per-test. dispose removes the template.
 * build / dispose は呼び出し側 file の hook として、有限の上限つきで自分で登録する (#1673 1b)。
 */
export function seedFixtureTemplate(repositoryIdentity: string, prefix: string) {
  let template: string | undefined;
  const fixture = {
    build(): void {
      template = mkdtempSync(join(tmpdir(), `${prefix}-template-`));
      ensureTrackedProjectIdentity(template, repositoryIdentity);
    },
    copy(): string {
      if (template === undefined) throw new Error("fixture template is not built");
      const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
      cpSync(template, root, { recursive: true });
      return root;
    },
    dispose(): void {
      if (template !== undefined) removeTestTree(template);
      template = undefined;
    },
  };
  heavyBeforeAll("git", fixture.build);
  heavyAfterAll("teardown", fixture.dispose);
  return fixture;
}
