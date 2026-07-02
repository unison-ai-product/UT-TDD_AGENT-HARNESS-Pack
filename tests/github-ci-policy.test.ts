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
  it("accepts the repository source and Pack harness-check workflows", () => {
    const result = analyzeGithubCiPolicy(loadGithubCiPolicyDocs(process.cwd()));

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(githubCiPolicyMessages(result)[0]).toContain("source+pack harness-check gates");
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
});
