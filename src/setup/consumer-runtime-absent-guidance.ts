/**
 * Inline source used by the generated consumer launcher. Keeping this fragment
 * separate keeps consumer-node-runtime focused on bundle validation while the
 * emitted launcher remains a single self-contained ESM file.
 */
import { REQUIRED } from "../lint/project-hook.ts";

/** Record / session hooks (no `onFailure: "block"`) fail open when the runtime is absent (#1602). */
const FAIL_OPEN_ARGV = REQUIRED.filter((hook) => !("onFailure" in hook)).map((hook) =>
  hook.wrapperArgs.slice(1, 3),
);

export const CONSUMER_RUNTIME_ABSENT_WRAPPER_SOURCE = [
  `const failOpenArgv = ${JSON.stringify(FAIL_OPEN_ARGV)};`,
  "const runtimeAbsent = () => {",
  "  const worktreeRoot = consumerRoot ?? process.cwd();",
  '  let mainLauncher = "<main worktree>/.ut-tdd/bin/ut-tdd.mjs";',
  '  let mainExplanation = " (resolve <main worktree> from git rev-parse --git-common-dir)";',
  "  try {",
  '    const common = resolve(worktreeRoot, execFileSync("git", ["rev-parse", "--git-common-dir"], {',
  "      cwd: worktreeRoot,",
  '      encoding: "utf8",',
  '      stdio: ["ignore", "pipe", "ignore"],',
  "      windowsHide: true,",
  "    }).trim());",
  '    mainLauncher = resolve(dirname(common), ".ut-tdd", "bin", "ut-tdd.mjs");',
  '    mainExplanation = "";',
  "  } catch {}",
  "  const quote = String.fromCharCode(34);",
  '  console.error("consumer_runtime_absent: runtime is missing from this worktree. Run: node " + quote + mainLauncher + quote + " setup --worktree " + quote + worktreeRoot + quote + mainExplanation);',
  "  const argv = process.argv.slice(2, 4);",
  "  process.exit(failOpenArgv.some((pair) => pair[0] === argv[0] && pair[1] === argv[1]) ? 0 : 2);",
  "};",
].join("\n");
