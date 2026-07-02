import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeGithubCiPolicy,
  type GithubWorkflowDoc,
  githubCiPolicyMessages,
  loadGithubCiPolicyDocs,
} from "../src/lint/github-ci-policy";

const SOURCE_WORKFLOW = `
name: harness-check
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: harness-check-test
jobs:
  harness-check:
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun src/cli.ts github guard
      - run: bun run typecheck
      - run: bun src/cli.ts db rebuild --json
      - run: bun run test
      - run: bun run lint
      - run: bun src/cli.ts audit quality --include-tests
      - run: bun src/cli.ts doctor
`;

const PACK_WORKFLOW = `
name: harness-check
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: harness-check-test
jobs:
  harness-check:
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test:pack
      - run: bun run lint
      - run: bun src/cli.ts setup --solo
      - run: bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke
`;

function docs(source = SOURCE_WORKFLOW, pack = PACK_WORKFLOW): GithubWorkflowDoc[] {
  return [
    { file: ".github/workflows/harness-check.yml", content: source, profile: "source" },
    {
      file: "docs/templates/github/common/pack-harness-check.yml",
      content: pack,
      profile: "pack",
    },
  ];
}

describe("github-ci-policy lint", () => {
  it("accepts canonical source and Pack harness-check workflows", () => {
    const result = analyzeGithubCiPolicy(docs());

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(githubCiPolicyMessages(result)[0]).toContain("source+pack harness-check gates");
  });

  it("loads source checkouts where .github contains the source workflow", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-policy-"));
    try {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "docs", "templates", "github", "common"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "harness-check.yml"), SOURCE_WORKFLOW);
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "pack-harness-check.yml"),
        PACK_WORKFLOW,
      );

      const docs = loadGithubCiPolicyDocs(repo);
      const result = analyzeGithubCiPolicy(docs);

      expect(docs.map((doc) => [doc.file, doc.profile])).toEqual([
        [join(".github", "workflows", "harness-check.yml"), "source"],
        [join("docs", "templates", "github", "common", "pack-harness-check.yml"), "pack"],
      ]);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("loads Pack checkouts where .github contains the Pack workflow", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-policy-"));
    try {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "docs", "templates", "github", "common"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "harness-check.yml"), PACK_WORKFLOW);
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "harness-check.yml"),
        SOURCE_WORKFLOW,
      );
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "pack-harness-check.yml"),
        PACK_WORKFLOW,
      );

      const docs = loadGithubCiPolicyDocs(repo);
      const result = analyzeGithubCiPolicy(docs);

      expect(docs.map((doc) => [doc.file, doc.profile])).toEqual([
        [join(".github", "workflows", "harness-check.yml"), "pack"],
        [join("docs", "templates", "github", "common", "harness-check.yml"), "source"],
      ]);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("requires source CI to keep full doctor in the required status check", () => {
    const result = analyzeGithubCiPolicy(
      docs(SOURCE_WORKFLOW.replace("bun src/cli.ts doctor", "")),
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_step",
      detail: "full doctor",
    });
  });

  it("requires Pack CI to use setup-smoke instead of source full doctor", () => {
    const pack = PACK_WORKFLOW.replace(
      "bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke",
      "bun .ut-tdd/bin/ut-tdd.mjs doctor",
    );
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, pack));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "missing_step",
      detail: "setup smoke doctor",
    });
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_full_doctor",
      detail:
        "Pack CI must use doctor --setup-smoke because Pack excludes source-only governance docs",
    });
  });

  it("rejects raw vitest run in Pack CI because source-only tests need governance docs", () => {
    const pack = PACK_WORKFLOW.replace("bun run test:pack", "bun run vitest run");
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, pack));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "missing_step",
      detail: "pack tests",
    });
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_raw_vitest",
      detail: "Pack CI must use bun run test:pack instead of raw vitest run",
    });
  });
});
