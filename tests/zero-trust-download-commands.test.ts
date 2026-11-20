import { describe, expect, it } from "vitest";
import {
  analyzeZeroTrustDownload,
  classifyScanTarget,
  extractCommands,
} from "../src/lint/zero-trust-download.ts";
import {
  baseline,
  bat,
  ps,
  sh,
  source,
  workflow,
} from "./fixtures/zero-trust-download-fixtures.ts";

// Red 段: 契約 docs/test-design/harness/L7-zero-trust-download-lint-test-design.md §3。
// stub は throw / 定数なので、各 oracle は it.fails で登録する (Green で it に戻す)。
const texts = (s: ReturnType<typeof sh>): string[] => extractCommands(s).map((c) => c.text);

describe("zero-trust-download 対象と取り出し (L6 §2, §3)", () => {
  it.fails("CANDIDATE-U-ZTDL-001 classifyScanTarget は実行される面だけを種別へ分ける", () => {
    expect(classifyScanTarget(".github/workflows/ci.yml")).toBe("workflow");
    expect(classifyScanTarget(".github/workflows/a/b.yaml")).toBe("workflow");
    expect(classifyScanTarget("docs/templates/github/common/harness-check.yml")).toBe("workflow");
    expect(classifyScanTarget("scripts/run.sh")).toBe("shell");
    expect(classifyScanTarget("scripts/x.ps1")).toBe("powershell");
    expect(classifyScanTarget("scripts/x.cmd")).toBe("batch");
    expect(classifyScanTarget("skills/git.md")).toBe("markdown");
    expect(classifyScanTarget("docs/templates/design/t.md")).toBe("markdown");
    expect(classifyScanTarget("tests/fixtures/w.yml")).toBeNull();
    expect(classifyScanTarget("docs/design/harness/x.md")).toBeNull();
    expect(classifyScanTarget("scripts/x.mjs")).toBeNull();
    expect(classifyScanTarget("node_modules/p/a.sh")).toBeNull();
    expect(classifyScanTarget(".github\\workflows\\ci.yml")).toBe("workflow");
  });

  it.fails("CANDIDATE-U-ZTDL-002 extractCommands は行継続と演算子で終わる行を連結する", () => {
    expect(extractCommands(sh("npm ci \\\n  --no-audit"))).toEqual([
      { path: "scripts/run.sh", line: 1, text: "npm ci --no-audit" },
    ]);
    expect(texts(sh("curl u |\n  sh"))).toEqual(["curl u | sh"]);
    expect(texts(sh("a &&\nb"))).toEqual(["a && b"]);
    expect(texts(ps("iwr u `\n  | iex"))).toEqual(["iwr u | iex"]);
    expect(texts(bat("npm ci ^\n--ignore-scripts"))).toEqual(["npm ci --ignore-scripts"]);
  });

  it.fails("CANDIDATE-U-ZTDL-003 extractCommands はコメントを捨て引用符の中の # は残す", () => {
    expect(texts(sh("# curl u | sh"))).toEqual([]);
    expect(texts(sh("npm ci --ignore-scripts # curl u | sh"))).toEqual(["npm ci --ignore-scripts"]);
    expect(texts(sh('echo "a # b"'))).toEqual(["echo a # b"]);
    expect(texts(bat("REM npm ci\n:: npm ci"))).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-004 extractCommands はヒアドキュメントの本文を走査する", () => {
    expect(texts(sh("cat > run.sh <<MARK\nnpm ci\nMARK"))).toContain("npm ci");
    expect(texts(sh("cat > run.sh <<MARK\ncurl u | sh\nMARK"))).toContain("curl u | sh");
    expect(texts(sh("cat > run.sh <<MARK\nnpm ci\nMARK"))).not.toContain("MARK");
    expect(texts(sh("npm ci"))).toEqual(["npm ci"]);
  });

  it.fails("CANDIDATE-U-ZTDL-005 extractCommands は workflow の run だけを YAML 構文解析で取り出す", () => {
    expect(texts(workflow("npm ci\nnpm test"))).toEqual(["npm ci", "npm test"]);
    expect(
      texts(source(".github/workflows/a.yml", "jobs:\n  x:\n    steps:\n      - run: npm ci\n")),
    ).toEqual(["npm ci"]);
    expect(
      texts(
        source(
          ".github/actions/c/action.yml",
          "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: npm ci\n",
        ),
      ),
    ).toEqual(["npm ci"]);
    expect(
      texts(
        source(
          ".github/workflows/b.yml",
          "name: npm ci\nenv:\n  X: npm ci\njobs:\n  x:\n    steps:\n      - run: echo ok\n",
        ),
      ),
    ).toEqual(["echo ok"]);
    const broken = analyzeZeroTrustDownload({
      sources: [source(".github/workflows/c.yml", "jobs: [unclosed\n  - : :\n")],
      baseline: baseline(),
      previousBaseline: baseline(),
      mergeBaseMeasures: null,
      severity: "fail-close",
    });
    expect(broken.ok).toBe(false);
    expect(broken.findings.map((f) => f.rule)).toContain("zero-trust-input-unreadable");
  });
});
