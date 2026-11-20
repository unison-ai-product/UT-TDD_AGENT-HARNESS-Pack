import type { Finding, ScanSource, ZeroTrustBaseline } from "../../src/lint/zero-trust-download.ts";

/** 設計 L7 §2: path と内容の組を直接渡す。 */
export function source(path: string, text: string): ScanSource {
  return { path, text };
}

export function sh(text: string): ScanSource {
  return source("scripts/run.sh", text);
}

export function ps(text: string): ScanSource {
  return source("scripts/run.ps1", text);
}

export function bat(text: string): ScanSource {
  return source("scripts/run.cmd", text);
}

export function workflow(run: string): ScanSource {
  const body = run
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
  return source(
    ".github/workflows/ci.yml",
    `name: ci\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n${body}\n`,
  );
}

export function md(text: string): ScanSource {
  return source("skills/git.md", text);
}

export function fence(body: string, lang = "bash"): string {
  return `説明\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
}

export function rules(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.rule}|${f.subject}`);
}

export function baseline(
  ...entries: Array<[path: string, rule: string, subject: string, count: number]>
): ZeroTrustBaseline {
  return {
    entries: entries.map(([path, rule, subject, count]) => ({ path, rule, subject, count })),
  };
}
