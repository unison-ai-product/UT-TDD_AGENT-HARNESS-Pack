import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveDelegationRouting } from "../src/team/delegation-routing.ts";
import {
  createCanaryFixture,
  isolatedCanaryEnv,
  removeCanaryFixtureTree,
} from "./support/pack-internal-canary.ts";

interface AcceptanceModule {
  CANARY_ASSETS: readonly string[];
  CANARY_TAG: string;
  AGENT_E2E_TAG: string;
  makeAccessAuditModule(
    forbiddenPaths: string[],
    accessLog: string,
    processLog:
      | string
      | {
          path: string;
          providerCommands: { claude: string; codexProbe: string; commandProcessor?: string };
        },
  ): string;
  buildInstallerInvocation(releaseDirectory: string, anchorDigest: string, tag?: string): string[];
  buildAgentE2EInstallerInvocation(releaseDirectory: string, anchorDigest: string): string[];
  canaryAssetsForTag(tag: string): readonly string[];
  createConsumerPlan(consumerRoot: string, source: string): void;
  main(argv: string[], deps?: { fixtureTag?: string }): void;
  findForbiddenReferences(root: string, forbiddenPaths: string[]): string[];
  createClosedReviewProviders(
    auditRoot: string,
    head: string,
  ): {
    ghBin: string;
    ghLoader: string;
    claudeCommand: string;
    claudeMarker: string;
    codexProbeCommand: string;
  };
  parsePublishRecord(
    value: unknown,
    commentUrl: string,
    options?: { expectedTag?: string },
  ): {
    assetDigests: Record<string, string>;
    consumerAnchorDigest: string;
    commentUrl: string;
    value: Record<string, unknown>;
  };
  parseAgentE2ERecord(
    value: unknown,
    commentUrl: string,
  ): ReturnType<AcceptanceModule["parsePublishRecord"]>;
  verifyAgentAuthoringEvidence(value: unknown): void;
  verifyAgentG1Negative(value: unknown, positiveRevision: string): void;
  verifyAgentReviewJoin(value: unknown): Record<string, unknown>;
  verifyAgentG1Positive(value: unknown, subjectRevision?: string): void;
  runAgentAuthoringAndGates(input: {
    consumerRoot: string;
    run?: (
      binary: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      status: number;
      stdout: string;
      stderr: string;
      error?: Error;
    };
  }): {
    authoring: Record<string, unknown>;
    baseline: {
      kind: string;
      revision: string;
      parent_revision: string;
      source_templates: Record<string, { slot: string; path: string; sha256: string }>;
      derivation: Record<string, unknown>;
    };
    subject: { path: string; revision: string; blobOid: string; contentSha256: string };
    positive: { applicable: boolean; passed: boolean; messages: string[] };
    negative: {
      applicable: boolean;
      passed: boolean;
      messages: string[];
      branch: string;
      revision: string;
      parent: string;
    };
  };
  verifyAgentE2EEvidence(value: unknown): {
    tag: string;
    assetDigests: Record<string, string>;
    consumerAnchorDigest: string;
    subjectRevision: string;
  };
  verifyReleaseDirectory(
    releaseDir: string,
    record: ReturnType<AcceptanceModule["parsePublishRecord"]>,
  ): {
    actualDigests: Record<string, string>;
  };
  verifyInstallEvidence(
    evidence: unknown,
    consumerRoot: string,
    removedPaths: string[],
    expectedTag?: string,
  ): void;
  verifyWrongAnchorDenial(
    releaseDirectory: string,
    expectedAnchor: string,
    run?: (
      binary: string,
      args: string[],
      options: { cwd: string },
    ) => {
      status: number;
      stdout: string;
      stderr: string;
    },
  ): { exit_code: number; typed_reason: string; consumer_write_count: number; argv: string[] };
  verifyRegisteredHooks(
    consumerRoot: string,
    env: Record<string, string>,
    run: (
      binary: string,
      args: string[],
      options: { input: string },
    ) => {
      status: number;
      stdout: string;
      stderr: string;
    },
    transcript: unknown[],
  ): void;
}

const runnerSpecifier = "../scripts/pack-canary-acceptance.mjs";
const acceptance = (await import(runnerSpecifier)) as AcceptanceModule;
const {
  buildInstallerInvocation,
  buildAgentE2EInstallerInvocation,
  CANARY_ASSETS,
  CANARY_TAG,
  AGENT_E2E_TAG,
  canaryAssetsForTag,
  createConsumerPlan,
  main,
  createClosedReviewProviders,
  findForbiddenReferences,
  parsePublishRecord,
  parseAgentE2ERecord,
  verifyAgentAuthoringEvidence,
  verifyAgentE2EEvidence,
  verifyAgentG1Positive,
  verifyAgentG1Negative,
  runAgentAuthoringAndGates,
  verifyAgentReviewJoin,
  verifyReleaseDirectory,
  verifyInstallEvidence,
  verifyWrongAnchorDenial,
  verifyRegisteredHooks,
  makeAccessAuditModule,
} = acceptance;

const tempRoots: string[] = [];
const commentUrl =
  "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/418#issuecomment-5907911175";
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (root.startsWith(join(tmpdir(), "ut-tdd-packcanary-pr1-"))) removeCanaryFixtureTree(root);
    else rmSync(root, { recursive: true, force: true });
  }
});

function record() {
  const assetBytes = Object.fromEntries(CANARY_ASSETS.map((name) => [name, `bytes:${name}`]));
  const pair = (value: string) => ({ producer_sha256: sha(value), independent_sha256: sha(value) });
  return {
    value: {
      tag: CANARY_TAG,
      release_url: `https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases/tag/${CANARY_TAG}`,
      c1_commit: "a".repeat(40),
      c2_commit: "b".repeat(40),
      recorded_by: "publisher",
      recorded_at: "2026-09-30T10:00:00.000Z",
      assets: Object.fromEntries(CANARY_ASSETS.map((name) => [name, pair(assetBytes[name])])),
      consumer_anchor_digest: pair("anchor"),
    },
    assetBytes,
  };
}

function releaseDir(assetBytes: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ut-canary-release-"));
  tempRoots.push(root);
  for (const name of CANARY_ASSETS) writeFileSync(join(root, name), assetBytes[name]);
  return root;
}

function agentRecord(tag = AGENT_E2E_TAG) {
  const names = canaryAssetsForTag(tag);
  const assetBytes = Object.fromEntries(names.map((name: string) => [name, `bytes:${name}`]));
  const pair = (value: string) => ({ producer_sha256: sha(value), independent_sha256: sha(value) });
  return {
    value: {
      tag,
      release_url: `https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases/tag/${tag}`,
      c1_commit: "c".repeat(40),
      c2_commit: "d".repeat(40),
      recorded_by: "offline runner contract fixture",
      recorded_at: "2026-10-01T10:00:00.000Z",
      assets: Object.fromEntries(names.map((name: string) => [name, pair(assetBytes[name])])),
      consumer_anchor_digest: pair("canary3-anchor"),
    },
    assetBytes,
  };
}

function agentReviewEvidence() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ut-canary-agent-review-")));
  tempRoots.push(root);
  const runGit = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  runGit("init", "--quiet");
  runGit("config", "user.email", "canary@example.invalid");
  runGit("config", "user.name", "Canary consumer fixture");
  runGit(
    "remote",
    "add",
    "origin",
    "https://github.com/unison-ai-product/ut-tdd-consumer-canary.git",
  );
  const subjectPath = "docs/design/L1-requirements/business-requirements.md";
  mkdirSync(join(root, "docs", "design", "L1-requirements"), { recursive: true });
  writeFileSync(
    join(root, subjectPath),
    "# Business requirements\n\nFixture authored from shipped template.\n",
  );
  runGit("add", "--", subjectPath);
  runGit("commit", "--quiet", "-m", "author canary subject");
  const head = runGit("rev-parse", "HEAD");
  const requestIdentity = {
    authorFamily: "codex",
    exactHead: head,
    memoryId: "canary-memory-001",
    pr: 12,
    schemaVersion: "review-request/v1",
  };
  const digest = createHash("sha256").update(JSON.stringify(requestIdentity)).digest("hex");
  const reviewRevision = `rv1-${digest}`;
  const request = {
    memoryId: requestIdentity.memoryId,
    pr: requestIdentity.pr,
    exactHead: head,
    reviewRevision,
    authorFamily: "codex",
    requestedAt: "2026-10-01T10:00:00.000Z",
    invocationNonce: "nonce-canary-fixture",
  };
  const requestPath = join(root, ".ut-tdd", "review", "requests", `${digest}.json`);
  const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${digest}.json`);
  const verdictPath = join(
    root,
    ".ut-tdd",
    "review",
    "verdicts",
    digest,
    "attempts",
    "attempt-1",
    "verdict.txt",
  );
  mkdirSync(dirname(requestPath), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const receipt = {
    memoryId: request.memoryId,
    pr: request.pr,
    head,
    reviewRevision,
    reviewerFamily: "claude",
    kind: "verdict",
    verdict: "PASS",
    blockingFindings: [],
    at: "2026-10-01T10:02:00.000Z",
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(receiptPath, receiptBytes);
  const verdictBytes = [
    "schema_version: ut-tdd.review-verdict/v1",
    `request_digest: ${digest}`,
    "attempt: 1",
    `pr: ${request.pr}`,
    `exact_head: ${head}`,
    `review_revision: ${reviewRevision}`,
    "reviewer_provider: claude",
    "reviewer_model: claude-opus-5",
    `invocation_nonce: ${request.invocationNonce}`,
    "VERDICT: PASS",
    "",
  ].join("\n");
  writeFileSync(verdictPath, verdictBytes);
  const commonDir = runGit("rev-parse", "--git-common-dir");
  const auditPath = join(
    root,
    commonDir,
    "ut-tdd-runtime",
    "review-custody",
    "review-custody.jsonl",
  );
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(
    auditPath,
    `${JSON.stringify({
      kind: "attempt_completed",
      requestDigest: digest,
      attempt: 1,
      exactHead: head,
      verdictPath: resolve(verdictPath),
      recordedAt: "2026-10-01T10:02:00.000Z",
      reason: "review_completed",
      provider: "claude",
      model: "claude-opus-5",
      exitCode: 0,
      receiptFileDigest: createHash("sha256").update(receiptBytes).digest("hex"),
      verdictDigest: createHash("sha256").update(verdictBytes).digest("hex"),
    })}\n`,
  );
  const dispatchResult = {
    ok: true,
    reviewer: "claude",
    request: { ok: true, request, path: requestPath, digest },
  };
  const consumeResult = {
    ok: true,
    projection: { ok: true, receipt, path: receiptPath, digest },
  };
  return {
    consumerRoot: root,
    repository: "unison-ai-product/ut-tdd-consumer-canary",
    pr: request.pr,
    head,
    dispatchResult,
    consumeResult,
    subjectRevision: head,
    dispatchInvocation: ["ut-tdd", "review", "live-dispatch"],
    consumeInvocation: ["ut-tdd", "review", "live-consume"],
    dispatchTranscript: "fixture CLI JSON result",
    consumeTranscript: "fixture CLI JSON result",
    auditPath,
    receiptPath,
    verdictPath,
  };
}

function agentReleaseDir(assetBytes: Record<string, string>, tag = AGENT_E2E_TAG) {
  const root = mkdtempSync(join(tmpdir(), "ut-canary-agent-release-"));
  tempRoots.push(root);
  for (const name of canaryAssetsForTag(tag)) writeFileSync(join(root, name), assetBytes[name]);
  return root;
}

describe("manual canary acceptance publish-record boundary", () => {
  it("U-ST-PACKCANARY-011: generated hook registrations must allow and block on both providers", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-hook-smoke-"));
    tempRoots.push(root);
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, ".codex"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node", args: ["work-guard"] }] }],
        },
      }),
    );
    writeFileSync(
      join(root, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node work-guard" }] }],
        },
      }),
    );
    const transcript: unknown[] = [];
    const calls: string[] = [];
    verifyRegisteredHooks(
      root,
      {},
      (_binary, _args, options) => {
        calls.push(options.input);
        const denied = options.input.includes("foreign-uncommitted.ts");
        return {
          status: denied ? 2 : 0,
          stdout: denied ? "[ut-tdd-work-guard] BLOCK: foreign edit" : "",
          stderr: "",
        };
      },
      transcript,
    );
    expect(calls).toHaveLength(4);
    expect(transcript).toHaveLength(4);
  });

  it("U-ST-PACKCANARY-008: wrong anchor must typed-deny with consumer write zero", () => {
    const anchor = `sha256:${"a".repeat(64)}`;
    const seen: string[][] = [];
    const denied = verifyWrongAnchorDenial("release", anchor, (_node, args) => {
      seen.push(args as string[]);
      return { status: 1, stdout: "consumer_runtime_anchor_mismatch", stderr: "" };
    });
    expect(denied).toMatchObject({
      exit_code: 1,
      typed_reason: "consumer_runtime_anchor_mismatch",
      consumer_write_count: 0,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("--consumer-runtime-release");
    expect(seen[0]).not.toContain("--consumer-runtime-input");
    expect(seen[0][seen[0].indexOf("--expected-consumer-digest") + 1]).not.toBe(anchor);
    expect(() =>
      verifyWrongAnchorDenial("release", anchor, () => ({ status: 0, stdout: "", stderr: "" })),
    ).toThrow("wrong-anchor-not-typed-denied");
    expect(() =>
      verifyWrongAnchorDenial("release", anchor, (_node, _args, options) => {
        writeFileSync(join((options as { cwd: string }).cwd, "leak"), "1");
        return { status: 1, stdout: "consumer_runtime_anchor_mismatch", stderr: "" };
      }),
    ).toThrow("wrong-anchor-wrote-consumer-root");
  });

  it("U-ST-PACKCANARY-012: consumer state cannot retain removed source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-path-reference-"));
    tempRoots.push(root);
    const removed = join(root, "removed-release");
    writeFileSync(join(root, "state.json"), JSON.stringify({ old: removed }));
    expect(findForbiddenReferences(root, [removed])).toHaveLength(1);
    writeFileSync(join(root, "state.json"), '{"clean":true}');
    expect(findForbiddenReferences(root, [removed])).toEqual([]);
  });

  it("U-ST-PACKCANARY-013: closed review providers cannot reach GitHub", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-review-stub-"));
    tempRoots.push(root);
    const head = "a".repeat(40);
    const stubs = createClosedReviewProviders(root, head);
    const gh = join(stubs.ghBin, process.platform === "win32" ? "gh.exe" : "gh");
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(stubs.ghLoader).href}` };
    const view = spawnSync(
      gh,
      ["pr", "view", "418", "--json", "headRefOid", "--jq", ".headRefOid"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(view.status, view.stderr).toBe(0);
    expect(view.stdout.trim()).toBe(head);
    const body = `PR #418 exact HEAD ${head} のcanonical review receipt。\nverdict=PASS blocking=0\nreviewRevision=rv1-${"b".repeat(64)}\nreviewerFamily=claude\nreceiptDigest=${"c".repeat(64)}`;
    const comment = spawnSync(gh, ["pr", "comment", "418", "--body", body], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(comment.status, comment.stderr || comment.stdout).toBe(0);
    const denied = spawnSync(gh, ["api", "user"], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('"denied":true');
  });

  it("U-ST-PACKCANARY-014: restart evidence binds consumer and removed Release root", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-evidence-"));
    tempRoots.push(root);
    const consumer = join(root, "consumer");
    const release = join(root, "release");
    const source = join(root, "source");
    const evidence = {
      schema_version: "ut-tdd.pack-canary-acceptance/v1",
      phase: "installed-awaiting-clean-restart",
      setup_exit_code: 0,
      tag: CANARY_TAG,
      consumer_root: consumer,
      release_directory: release,
      consumer_head: "a".repeat(40),
    };
    expect(() => verifyInstallEvidence(evidence, consumer, [source, release])).not.toThrow();
    expect(() => verifyInstallEvidence(evidence, join(root, "other"), [source, release])).toThrow(
      "install-evidence-not-verifiable",
    );
    expect(() => verifyInstallEvidence(evidence, consumer, [source, join(root, "other")])).toThrow(
      "verify-removed-paths-not-bound-to-install",
    );
    expect(() => verifyInstallEvidence(evidence, consumer, [source, release, consumer])).toThrow(
      "verify-removed-paths-not-bound-to-install",
    );

    const canary3 = { ...evidence, tag: AGENT_E2E_TAG };
    expect(() =>
      verifyInstallEvidence(canary3, consumer, [source, release], AGENT_E2E_TAG),
    ).not.toThrow();
    expect(() => verifyInstallEvidence(canary3, consumer, [source, release])).toThrow(
      "install-evidence-not-verifiable",
    );
    expect(() =>
      verifyInstallEvidence({ ...evidence, tag: "v0.2.0-canary.4" }, consumer, [source, release]),
    ).toThrow("install-evidence-not-verifiable");
  });

  it("U-ST-PACKCANARY-015: accepts exact canary.6 for the agent lane and canary.2 for the standard lane", () => {
    const anchor = sha("canary.6 anchor");
    expect(CANARY_TAG).toBe("v0.2.0-canary.2");
    expect(buildInstallerInvocation("C:/c6-release", anchor, "v0.2.0-canary.6")).toEqual([
      join("C:/c6-release", "v0.2.0-canary.6.ut-tdd.mjs"),
      "setup",
      "--solo",
      "--consumer-runtime-release",
      "C:/c6-release",
      "--expected-consumer-digest",
      anchor,
    ]);
    expect(buildInstallerInvocation("C:/c2-release", anchor)).toEqual([
      join("C:/c2-release", `${CANARY_TAG}.ut-tdd.mjs`),
      "setup",
      "--solo",
      "--consumer-runtime-release",
      "C:/c2-release",
      "--expected-consumer-digest",
      anchor,
    ]);
    for (const tag of [
      "v0.2.0-canary.5",
      "v0.2.0-canary.4",
      "v0.2.0-canary.3",
      "v0.1.4",
      "latest",
      "v0.2.0-canary.6-preview",
      "v0.2.0-canary.5-preview",
      "v0.2.0-canary.4-preview",
      "prefix-v0.2.0-canary.4",
      "prefix-v0.2.0-canary.6",
    ]) {
      expect(() => buildInstallerInvocation("C:/other-release", anchor, tag)).toThrow(
        "acceptance-tag-not-canary-2-or-offline-fixture",
      );
      expect(() =>
        main([
          "--tag",
          tag,
          "--record",
          "missing",
          "--comment-url",
          commentUrl,
          "--release-dir",
          "missing",
          "--consumer-root",
          "missing",
          "--evidence",
          "missing",
        ]),
      ).toThrow("acceptance-tag-not-exact");
    }
    expect(() =>
      main([
        "--tag",
        "v0.0.0-canary.0",
        "--record",
        "missing",
        "--comment-url",
        commentUrl,
        "--release-dir",
        "missing",
        "--consumer-root",
        "missing",
        "--evidence",
        "missing",
      ]),
    ).toThrow("acceptance-tag-not-exact");
  });

  it("U-ST-PACKCANARY-009: runner loads without source node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-standalone-"));
    tempRoots.push(root);
    const script = join(root, "runner.mjs");
    copyFileSync(join(process.cwd(), "scripts", "pack-canary-acceptance.mjs"), script);
    const child = spawnSync(process.execPath, [script, "--phase", "invalid"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { PATH: "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("usage: install");
    expect(child.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("U-ST-PACKCANARY-014: access audit preserves and guards native realpath", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-audit-native-"));
    tempRoots.push(root);
    const forbidden = join(root, "removed-source");
    const audit = join(root, "audit.mjs");
    const accessLog = join(root, "access.jsonl");
    writeFileSync(
      audit,
      makeAccessAuditModule([forbidden], accessLog, join(root, "process.jsonl")),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(audit).href,
        "--input-type=module",
        "-e",
        `
      import { realpathSync } from "node:fs";
      const root = ${JSON.stringify(root)};
      if (realpathSync(root) !== ${JSON.stringify(realpathSync(root))}) throw new Error("realpath behavior drift");
      if (realpathSync.native(root) !== ${JSON.stringify(realpathSync.native(root))}) throw new Error("native realpath behavior drift");
      for (const resolvePath of [realpathSync, realpathSync.native]) {
        try { resolvePath(${JSON.stringify(forbidden)}); throw new Error("deny missing"); }
        catch (error) { if (error.message !== "forbidden removed path access") throw error; }
      }
    `,
      ],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    expect(readFileSync(accessLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("U-ST-PACKCANARY-014: only the closed provider shim and exact Codex probe are allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-audit-shim-"));
    tempRoots.push(root);
    const providers = createClosedReviewProviders(root, "a".repeat(40));
    const audit = join(root, "audit.mjs");
    const trace = join(root, "process.jsonl");
    writeFileSync(
      audit,
      makeAccessAuditModule([], join(root, "access.jsonl"), {
        path: trace,
        providerCommands: {
          claude: providers.claudeCommand,
          codexProbe: providers.codexProbeCommand,
          commandProcessor: process.env.ComSpec,
        },
      }),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(audit).href,
        "--input-type=module",
        "-e",
        `
      import { spawnSync } from "node:child_process";
      const codex = ${JSON.stringify(providers.codexProbeCommand)};
      if (spawnSync(codex, ["--version"], {shell:false}).status !== 0) throw new Error("closed probe failed");
      const deny = (command, argv) => {
        try { spawnSync(command, argv, {shell:false}); throw new Error("deny missing"); }
        catch (error) { if (error.message !== "unapproved child process") throw error; }
      };
      deny(codex, ["--help"]);
      if (process.platform === "win32") {
        const command = ${JSON.stringify(process.env.ComSpec)};
        const shim = ${JSON.stringify(providers.claudeCommand)};
        const payload = '""' + shim + '" "--version""';
        if (spawnSync(command, ["/d", "/s", "/c", payload], {shell:false,windowsVerbatimArguments:true}).status !== 0)
          throw new Error("closed shim failed");
        deny(command, ["/d", "/s", "/c", payload + " & echo unapproved"]);
        deny(command, ["/d", "/s", "/c", '""foreign.cmd" "--version""']);
      }
    `,
      ],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.allowed === true)).toHaveLength(
      process.platform === "win32" ? 2 : 1,
    );
    expect(calls.filter((call) => call.allowed === false)).toHaveLength(
      process.platform === "win32" ? 3 : 1,
    );
  });

  it("U-ST-PACKCANARY-009: authoring input is derived from the shipped template", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-template-"));
    tempRoots.push(root);
    const template = join(root, "docs", "templates", "plan", "design", "template.md");
    mkdirSync(join(root, "docs", "templates", "plan", "design"), { recursive: true });
    copyFileSync(
      join(process.cwd(), "docs", "templates", "plan", "design", "template.md"),
      template,
    );
    const shippedTemplate = readFileSync(template, "utf8");
    rmSync(template);
    createConsumerPlan(root, shippedTemplate);
    const manifest = JSON.parse(readFileSync(join(root, "canary-plan-draft.json"), "utf8"));
    const match = /^---\n([\s\S]*?)\n---\n/.exec(manifest.source.content);
    expect(match).not.toBeNull();
    expect(parseYaml(match?.[1] ?? "")).toMatchObject({
      plan_id: "PLAN-L2-999-canary-authoring",
      drive: "agent",
      route_signal: "forward",
      route_mode: "forward",
      sub_doc: "screen-list",
      generates: [],
      related_docs: [],
    });
    expect(manifest.source.content).toContain("配布された PLAN テンプレート");
  });

  it("U-ST-PACKCANARY-005/006/009: accepts only exact canary.2 record, comment and 5 digests", () => {
    const input = record();
    const parsed = parsePublishRecord(input.value, commentUrl);
    const dir = releaseDir(input.assetBytes);
    const verified = verifyReleaseDirectory(dir, parsed);
    expect(Object.keys(verified.actualDigests).sort()).toEqual([...CANARY_ASSETS].sort());
    expect(parsed.commentUrl).toBe(commentUrl);
  });

  it("U-ST-PACKCANARY-005/006/009: binds five bytes from the real offline distribution producer", async () => {
    const fixture = await createCanaryFixture();
    tempRoots.push(fixture.root);
    const names = canaryAssetsForTag("v0.0.0-canary.0");
    const assets = Object.fromEntries(
      names.map((name: string) => {
        const bytes = readFileSync(join(fixture.releaseDir, name));
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        return [name, { producer_sha256: digest, independent_sha256: digest }];
      }),
    );
    const anchorBytes = readFileSync(join(fixture.releaseDir, "v0.0.0-canary.0.consumer.sha256"));
    const anchor = `sha256:${createHash("sha256").update(anchorBytes).digest("hex")}`;
    expect(anchor).toBe(fixture.anchor);
    const digestPair = { producer_sha256: anchor, independent_sha256: anchor };
    const publish = parsePublishRecord(
      {
        tag: "v0.0.0-canary.0",
        release_url:
          "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases/tag/v0.0.0-canary.0",
        c1_commit: "a".repeat(40),
        c2_commit: "b".repeat(40),
        recorded_by: "offline fixture",
        recorded_at: "2026-09-30T10:00:00.000Z",
        assets,
        consumer_anchor_digest: digestPair,
      },
      commentUrl,
      { expectedTag: "v0.0.0-canary.0" },
    );
    expect(verifyReleaseDirectory(fixture.releaseDir, publish).actualDigests).toEqual(
      Object.fromEntries(names.map((name: string) => [name, assets[name].producer_sha256])),
    );

    const before = readdirSync(fixture.consumerRoot);
    const denied = spawnSync(
      process.execPath,
      [
        fixture.wrapper,
        "setup",
        "--solo",
        "--consumer-runtime-release",
        fixture.releaseDir,
        "--expected-consumer-digest",
        `sha256:${"0".repeat(64)}`,
      ],
      {
        cwd: fixture.consumerRoot,
        encoding: "utf8",
        env: isolatedCanaryEnv(fixture.root),
        windowsHide: true,
        timeout: 120_000,
      },
    );
    expect(`${denied.stdout}\n${denied.stderr}`).toContain("consumer_runtime_anchor_mismatch");
    expect(readdirSync(fixture.consumerRoot)).toEqual(before);

    const recordPath = join(fixture.root, "fixture-publish-record.json");
    const evidencePath = join(fixture.root, "fixture-acceptance-evidence.json");
    writeFileSync(recordPath, JSON.stringify(publish.value));
    main(
      [
        "--phase",
        "install",
        "--record",
        recordPath,
        "--comment-url",
        commentUrl,
        "--release-dir",
        fixture.releaseDir,
        "--consumer-root",
        fixture.consumerRoot,
        "--evidence",
        evidencePath,
      ],
      { fixtureTag: "v0.0.0-canary.0" },
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence).toMatchObject({
      tag: "v0.0.0-canary.0",
      setup_exit_code: 0,
      consumer_anchor_digest: anchor,
      consumer_root: realpathSync.native(fixture.consumerRoot),
      authoring_template: {
        asset_name: "v0.0.0-canary.0.tar.gz",
        path: "docs/templates/plan/design/template.md",
        sha256: sha(fixture.planTemplate),
      },
      authoring_input_sha256: sha(
        readFileSync(join(fixture.consumerRoot, "canary-plan-draft.json"), "utf8"),
      ),
      wrong_anchor_denial: {
        typed_reason: "consumer_runtime_anchor_mismatch",
        consumer_write_count: 0,
      },
    });
    expect(evidence.consumer_head).toMatch(/^[a-f0-9]{40}$/);
    expect(readdirSync(join(fixture.consumerRoot, ".ut-tdd", "bin"))).toContain("ut-tdd.mjs");
  }, 600_000);

  it.each([
    ["wrong tag", (value: ReturnType<typeof record>["value"]) => ({ ...value, tag: "latest" })],
    ["wrong comment", (value: ReturnType<typeof record>["value"]) => value],
  ])("U-ST-PACKCANARY-006/009: denies %s before setup", (label, mutate) => {
    const input = record();
    if (label === "wrong comment")
      expect(() => parsePublishRecord(mutate(input.value), "https://example.com")).toThrow(
        "publish-record-comment-url-invalid",
      );
    else
      expect(() => parsePublishRecord(mutate(input.value), commentUrl)).toThrow(
        "publish-record-tag-not-exact",
      );
  });

  it("U-ST-PACKCANARY-005: denies missing, extra, or disagreeing publish digests", () => {
    const input = record();
    const missing = structuredClone(input.value);
    delete missing.assets[CANARY_ASSETS[0]];
    expect(() => parsePublishRecord(missing, commentUrl)).toThrow(
      "publish-record-asset-set-not-exact",
    );

    const extra = structuredClone(input.value);
    extra.assets["unexpected.bin"] = extra.assets[CANARY_ASSETS[0]];
    expect(() => parsePublishRecord(extra, commentUrl)).toThrow(
      "publish-record-asset-set-not-exact",
    );

    const disagreement = structuredClone(input.value);
    disagreement.assets[CANARY_ASSETS[0]].independent_sha256 = sha("other");
    expect(() => parsePublishRecord(disagreement, commentUrl)).toThrow(
      "publish-record-digest-disagreement",
    );
  });

  it("U-ST-PACKCANARY-005: checks downloaded bytes against the independent publish record", () => {
    const input = record();
    const dir = releaseDir(input.assetBytes);
    writeFileSync(join(dir, CANARY_ASSETS[0]), "tampered");
    expect(() => verifyReleaseDirectory(dir, parsePublishRecord(input.value, commentUrl))).toThrow(
      `release-asset-digest-mismatch:${CANARY_ASSETS[0]}`,
    );
  });

  it("U-ST-PACKCANARY-005/006: denies extra files rather than subset-matching the release", () => {
    const input = record();
    const dir = releaseDir(input.assetBytes);
    writeFileSync(join(dir, "README.txt"), "extra");
    expect(() => verifyReleaseDirectory(dir, parsePublishRecord(input.value, commentUrl))).toThrow(
      "release-asset-set-not-exact",
    );
  });

  it("U-ST-PACKCANARY-008/009: uses only the canonical record anchor and Release-assets input", () => {
    const input = record();
    const parsed = parsePublishRecord(input.value, commentUrl);
    const invocation = buildInstallerInvocation("C:/release-dir", parsed.consumerAnchorDigest);
    expect(invocation).toContain("--consumer-runtime-release");
    expect(invocation).not.toContain("--consumer-runtime-input");
    expect(invocation.slice(-1)[0]).toBe(parsed.consumerAnchorDigest);
    expect(() =>
      buildInstallerInvocation("C:/release-dir", parsed.consumerAnchorDigest, "latest"),
    ).toThrow("acceptance-tag-not-canary-2");
  });

  it("U-ST-PACKCANARY-015: the AT-DIST-003 lane accepts only exact canary.6 bytes and its record anchor", () => {
    const agentTag = "v0.2.0-canary.6";
    const input = agentRecord(agentTag);
    expect(input.value.tag).toBe(agentTag);
    const parsed = parseAgentE2ERecord(input.value, commentUrl);
    const dir = agentReleaseDir(input.assetBytes, agentTag);
    expect(parsed.value.tag).toBe(agentTag);
    expect(Object.keys(verifyReleaseDirectory(dir, parsed).actualDigests).sort()).toEqual(
      [...canaryAssetsForTag(agentTag)].sort(),
    );
    expect(buildAgentE2EInstallerInvocation("C:/c6-release", parsed.consumerAnchorDigest)).toEqual([
      join("C:/c6-release", `${agentTag}.ut-tdd.mjs`),
      "setup",
      "--solo",
      "--consumer-runtime-release",
      "C:/c6-release",
      "--expected-consumer-digest",
      parsed.consumerAnchorDigest,
    ]);
    expect(
      buildInstallerInvocation("C:/c6-release", parsed.consumerAnchorDigest, agentTag),
    ).toEqual(buildAgentE2EInstallerInvocation("C:/c6-release", parsed.consumerAnchorDigest));
    expect(() => parseAgentE2ERecord(record().value, commentUrl)).toThrow(
      "publish-record-tag-not-exact",
    );

    const c2Bytes = structuredClone(input.value);
    c2Bytes.tag = CANARY_TAG;
    expect(() => parseAgentE2ERecord(c2Bytes, commentUrl)).toThrow("publish-record-tag-not-exact");
    for (const tag of [
      "v0.2.0-canary.5",
      "v0.2.0-canary.4",
      "v0.2.0-canary.3",
      "latest",
      "v0.2.0-canary.6-preview",
      "v0.2.0-canary.5-preview",
      "v0.2.0-canary.4-preview",
      "prefix-v0.2.0-canary.4",
      "prefix-v0.2.0-canary.6",
    ]) {
      const wrongTag = structuredClone(input.value);
      wrongTag.tag = tag;
      expect(() => parseAgentE2ERecord(wrongTag, commentUrl)).toThrow(
        "publish-record-tag-not-exact",
      );
    }
    const tampered = agentReleaseDir(input.assetBytes, agentTag);
    writeFileSync(join(tampered, canaryAssetsForTag(agentTag)[2]), "tampered");
    expect(() => verifyReleaseDirectory(tampered, parsed)).toThrow("release-asset-digest-mismatch");

    const missing = agentReleaseDir(input.assetBytes, agentTag);
    rmSync(join(missing, canaryAssetsForTag(agentTag)[0]));
    expect(() => verifyReleaseDirectory(missing, parsed)).toThrow("release-asset-set-not-exact");

    const extra = agentReleaseDir(input.assetBytes, agentTag);
    writeFileSync(join(extra, "unexpected.bin"), "extra");
    expect(() => verifyReleaseDirectory(extra, parsed)).toThrow("release-asset-set-not-exact");

    const wrongAnchor = structuredClone(input.value);
    wrongAnchor.consumer_anchor_digest.independent_sha256 = sha("different anchor");
    expect(() => parseAgentE2ERecord(wrongAnchor, commentUrl)).toThrow(
      "publish-record-digest-disagreement:consumer_anchor_digest",
    );

    const wrongAnchorBytes = { ...input.assetBytes };
    const anchorName = canaryAssetsForTag(agentTag)[4];
    wrongAnchorBytes[anchorName] = "wrong anchor bytes";
    expect(() =>
      verifyReleaseDirectory(agentReleaseDir(wrongAnchorBytes, agentTag), parsed),
    ).toThrow(`release-asset-digest-mismatch:${anchorName}`);
  });

  it("U-ST-PACKCANARY-016: rejects missing or non-agent authoring provenance", () => {
    const valid = {
      provider: "codex",
      model: "gpt-6-luna",
      invocation: [
        "ut-tdd",
        "codex",
        "--role",
        "se",
        "--model",
        "gpt-6-luna",
        "--effort",
        "high",
        "--task",
        "write L1 business requirements",
        "--execute",
        "--json",
      ],
      role: "se",
      template_source: "pack-template",
      provenance: "live-provider",
      template_slot: "DOC-L1-REQUIREMENTS",
      transcript: "provider started; completed subject authoring",
      baseline_revision: "1".repeat(40),
      subject_revision: "2".repeat(40),
      subject_parent: "1".repeat(40),
    };
    expect(() => verifyAgentAuthoringEvidence(valid)).not.toThrow();
    expect(() =>
      verifyAgentAuthoringEvidence({
        provider: "codex",
        model: "gpt-6-luna",
        invocation: [],
        template_source: "pack-template",
      }),
    ).toThrow("agent-authoring-provenance-invalid");
    expect(() => verifyAgentAuthoringEvidence({ ...valid, provenance: "closed-stub" })).toThrow(
      "agent-authoring-provenance-invalid",
    );
    expect(() =>
      verifyAgentAuthoringEvidence({
        ...valid,
        provider: "manual",
        model: "not-a-provider",
        invocation: ["source-helper"],
        template_source: "handwritten",
        provenance: "handwritten",
      }),
    ).toThrow("agent-authoring-provenance-invalid");
  });

  it("U-ST-PACKCANARY-016: rejects prefixed github.com repository identity", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-agent-identity-"));
    tempRoots.push(root);
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/unison-ai-product/ut-tdd-consumer-canary.git",
    ]);
    mkdirSync(join(root, ".ut-tdd", "bin"), { recursive: true });
    writeFileSync(join(root, ".ut-tdd", "bin", "ut-tdd.mjs"), "// sealed CLI fixture\n");
    writeFileSync(
      join(root, "ut-tdd.project.json"),
      JSON.stringify({
        schema_version: "ut-tdd.project/v1",
        repository_identity: "github.com/unison-ai-product/ut-tdd-consumer-canary",
      }),
    );

    expect(() => runAgentAuthoringAndGates({ consumerRoot: root })).toThrow(
      "agent-authoring-consumer-identity-invalid",
    );
  });

  it("U-ST-PACKCANARY-016: routes authoring through registered se role and rejects worker", () => {
    const accepted = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "write L1 business requirements",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(accepted).toMatchObject({
      ok: true,
      model: "gpt-6-luna",
      effort: "high",
      model_source: "explicit",
      effort_source: "explicit",
    });

    const rejected = resolveDelegationRouting({
      provider: "codex",
      role: "worker",
      task: "write L1 business requirements",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(rejected).toMatchObject({ ok: false });
    if (!rejected.ok)
      expect(rejected.message).toContain("role=worker is not a registered delegation role");
  });

  it("U-ST-PACKCANARY-017: rejects a non-applicable, failed, or could-not-run G1 positive", () => {
    const revision = "a".repeat(40);
    expect(() =>
      verifyAgentG1Positive(
        {
          revision,
          applicable: true,
          passed: true,
          messages: ["G1 passed"],
        },
        revision,
      ),
    ).not.toThrow();
    expect(() => verifyAgentG1Positive({ applicable: false, passed: true, messages: [] })).toThrow(
      "agent-g1-positive-invalid",
    );
    expect(() => verifyAgentG1Positive({ applicable: true, passed: false, messages: [] })).toThrow(
      "agent-g1-positive-invalid",
    );
    expect(() =>
      verifyAgentG1Positive(
        {
          revision,
          applicable: true,
          passed: true,
          messages: ["could not run: gate unavailable"],
        },
        revision,
      ),
    ).toThrow("agent-g1-positive-invalid");
  });

  it("U-ST-PACKCANARY-018: rejects same-revision or unnamed-slot G1 negative evidence", () => {
    const positiveRevision = "a".repeat(40);
    expect(() =>
      verifyAgentG1Negative(
        {
          revision: "b".repeat(40),
          parent: positiveRevision,
          applicable: true,
          passed: false,
          messages: ["required doc not created: business-requirements.md"],
        },
        positiveRevision,
      ),
    ).not.toThrow();
    expect(() =>
      verifyAgentG1Negative(
        {
          revision: positiveRevision,
          parent: positiveRevision,
          applicable: true,
          passed: false,
          messages: ["required doc not created: business-requirements.md"],
        },
        positiveRevision,
      ),
    ).toThrow("agent-g1-negative-invalid");
    expect(() =>
      verifyAgentG1Negative(
        {
          revision: "b".repeat(40),
          parent: positiveRevision,
          applicable: true,
          passed: false,
          messages: ["required doc not created: another-slot.md"],
        },
        positiveRevision,
      ),
    ).toThrow("agent-g1-negative-invalid");
  });

  it("U-ST-PACKCANARY-016..018: mock adapter exercises consumer CLI wiring (not provider evidence)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-agent-authoring-"));
    tempRoots.push(root);
    const runGit = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    runGit("init", "--quiet", "--initial-branch=main");
    runGit("config", "user.email", "canary@example.invalid");
    runGit("config", "user.name", "Canary consumer fixture");
    runGit(
      "remote",
      "add",
      "origin",
      "https://github.com/unison-ai-product/ut-tdd-consumer-canary.git",
    );
    mkdirSync(join(root, ".ut-tdd", "bin"), { recursive: true });
    writeFileSync(join(root, ".ut-tdd", "bin", "ut-tdd.mjs"), "// consumer-local CLI fixture\n");
    writeFileSync(
      join(root, "ut-tdd.project.json"),
      JSON.stringify({
        schema_version: "ut-tdd.project/v1",
        repository_identity: "unison-ai-product/ut-tdd-consumer-canary",
      }),
    );
    writeFileSync(join(root, "README.md"), "# baseline\n");
    runGit("add", "--", ".ut-tdd/bin/ut-tdd.mjs", "ut-tdd.project.json", "README.md");
    runGit("commit", "--quiet", "-m", "consumer baseline");
    const cliPath = realpathSync.native(join(root, ".ut-tdd", "bin", "ut-tdd.mjs"));
    const invocations: string[][] = [];
    const mockRun = (binary: string, args: string[], options: Record<string, unknown>) => {
      if (binary === "git") {
        const result = spawnSync(binary, args, { ...options, encoding: "utf8" });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          error: result.error,
        };
      }
      expect(binary).toBe(process.execPath);
      expect(realpathSync.native(String(args[0]))).toBe(cliPath);
      const cliArgs = args.slice(1);
      invocations.push(cliArgs);
      if (cliArgs[0] === "vmodel" && cliArgs[1] === "template") {
        const written = [
          "docs/design/L1-requirements/functional-requirements.md",
          "docs/design/L2-screen/screen-list.md",
          "docs/test-design/L12-acceptance-test-design.md",
        ];
        for (const path of written) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          const layer = path.includes("screen-list")
            ? "L2"
            : path.includes("acceptance")
              ? "L12"
              : "L1";
          const fields =
            layer === "L12"
              ? "layer: L12\nstatus: draft\npair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md\n"
              : `layer: ${layer}\nstatus: draft\npair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md\n`;
          const screenSeed = path.includes("screen-list") ? "\nSC-001 signup\n" : "";
          writeFileSync(
            join(root, path),
            `---\n${fields}---\n# Shipped ${layer} template${screenSeed}\n`,
          );
        }
        return { status: 0, stdout: JSON.stringify({ written, skipped: [] }), stderr: "" };
      }
      if (cliArgs[0] === "codex") {
        expect(cliArgs).toContain("--execute");
        expect(cliArgs).toContain("--role");
        expect(cliArgs).toContain("se");
        expect(cliArgs).toContain("--model");
        expect(cliArgs).toContain("gpt-6-luna");
        const path = "docs/design/L1-requirements/business-requirements.md";
        mkdirSync(join(root, "docs", "design", "L1-requirements"), { recursive: true });
        writeFileSync(
          join(root, path),
          "---\nlayer: L1\nsub_doc: business\nstatus: confirmed\npair_artifact: docs/test-design/L12-acceptance-test-design.md\n---\n| **BR-01** | Consumer need |\n",
        );
        return {
          status: 0,
          stdout: JSON.stringify({
            provider: "codex",
            model: "gpt-6-luna",
            available: true,
            exit_code: 0,
          }),
          stderr: "provider execution captured by test double",
        };
      }
      if (cliArgs[0] === "gate" && cliArgs[1] === "G1") {
        const negative = execFileSync("git", ["-C", root, "branch", "--show-current"], {
          encoding: "utf8",
        })
          .trim()
          .startsWith("ut-tdd-agent-e2e-negative-");
        const static_gate = negative
          ? {
              gate: "G1",
              applicable: true,
              passed: false,
              messages: ["required doc not created: business-requirements.md"],
            }
          : {
              gate: "G1",
              applicable: true,
              passed: true,
              messages: [
                "G1 pair - OK",
                "g1-trace - OK (business=1, screens=1, p0Fr=1, l3Plans=0)",
              ],
            };
        return { status: negative ? 1 : 0, stdout: JSON.stringify({ static_gate }), stderr: "" };
      }
      throw new Error(`unexpected consumer CLI invocation: ${cliArgs.join(" ")}`);
    };
    const evidence = runAgentAuthoringAndGates({ consumerRoot: root, run: mockRun });
    expect(evidence).toMatchObject({
      authoring: {
        provider: "codex",
        provenance: "live-provider",
        baseline_revision: expect.stringMatching(/^[a-f0-9]{40}$/),
      },
      subject: {
        path: "docs/design/L1-requirements/business-requirements.md",
        revision: expect.stringMatching(/^[a-f0-9]{40}$/),
      },
      positive: { applicable: true, passed: true },
      negative: { applicable: true, passed: false },
    });
    expect(invocations[0]).toEqual([
      "vmodel",
      "template",
      "--slot",
      "DOC-L1-REQUIREMENTS",
      "DOC-L2-SCREEN",
      "DOC-L12-ACCEPTANCE",
      "--json",
    ]);
    expect(invocations[1][0]).toBe("codex");
    expect(invocations[1]).toContain("--execute");
    expect(invocations[1]).toContain("--effort");
    expect(invocations[1]).toContain("high");
    expect(invocations.filter((args) => args[0] === "gate")).toHaveLength(2);
    expect(runGit("rev-parse", "HEAD")).toBe(evidence.subject.revision);
    expect(runGit("rev-parse", `${evidence.baseline.revision}^1`)).toBe(
      evidence.baseline.parent_revision,
    );
    expect(
      runGit("diff", "--name-only", evidence.baseline.revision, evidence.subject.revision),
    ).toBe("docs/design/L1-requirements/business-requirements.md");
    expect(runGit("rev-parse", `${evidence.negative.branch}^1`)).toBe(evidence.subject.revision);
    expect(runGit("branch", "--show-current")).toBe("main");
    expect(evidence.authoring.subject_parent).toBe(evidence.baseline.revision);
    expect(evidence.baseline).toMatchObject({
      kind: "baseline",
      derivation: {
        functional: { id: "FR-L1-01", priority: "P0" },
        screen: { source_id: "SC-001", derived_id: "PM-01" },
        trace: { business_id: "BR-01", functional_id: "FR-L1-01", screen_id: "PM-01" },
      },
    });
    expect(evidence.baseline.source_templates.screenSource.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runGit("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("U-ST-PACKCANARY-019: rejects same-family, wrong-head, or noncanonical review receipts", () => {
    const base = agentReviewEvidence();
    const joined = verifyAgentReviewJoin(base);
    expect(joined.subject).toMatchObject({
      revision: base.subjectRevision,
      path: "docs/design/L1-requirements/business-requirements.md",
      blobOid: expect.stringMatching(/^[a-f0-9]{40}$/),
      contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const sameFamily = agentReviewEvidence();
    const parsedSameFamily = JSON.parse(readFileSync(sameFamily.receiptPath, "utf8"));
    parsedSameFamily.reviewerFamily = "codex";
    writeFileSync(sameFamily.receiptPath, JSON.stringify(parsedSameFamily));
    expect(() => verifyAgentReviewJoin(sameFamily)).toThrow("same_family_reviewer");

    const wrongHead = agentReviewEvidence();
    const dispatch = structuredClone(wrongHead.dispatchResult);
    dispatch.request.request.exactHead = "b".repeat(40);
    expect(() => verifyAgentReviewJoin({ ...wrongHead, dispatchResult: dispatch })).toThrow(
      "agent-review-request-identity-invalid",
    );

    const noncanonical = agentReviewEvidence();
    const consume = structuredClone(noncanonical.consumeResult);
    consume.projection.path = "source/.ut-tdd/review/receipts/foreign.json";
    expect(() => verifyAgentReviewJoin({ ...noncanonical, consumeResult: consume })).toThrow(
      "agent-review-receipt-schema-invalid",
    );

    const wrongRequestPath = agentReviewEvidence();
    const dispatchWithForeignPath = structuredClone(wrongRequestPath.dispatchResult);
    dispatchWithForeignPath.request.path = join(
      wrongRequestPath.consumerRoot,
      "foreign-request.json",
    );
    expect(() =>
      verifyAgentReviewJoin({
        ...wrongRequestPath,
        dispatchResult: dispatchWithForeignPath,
      }),
    ).toThrow("agent-review-request-custody-invalid");

    expect(() =>
      verifyAgentReviewJoin({
        ...base,
        dispatchInvocation: ["source-helper", "review", "live-dispatch"],
      }),
    ).toThrow("agent-review-run-boundary-invalid");

    const rejectAttemptMutation = (mutate: (attempt: Record<string, unknown>) => void) => {
      const evidence = agentReviewEvidence();
      const audit = readFileSync(evidence.auditPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      mutate(audit[0]);
      writeFileSync(evidence.auditPath, `${JSON.stringify(audit[0])}\n`);
      expect(() => verifyAgentReviewJoin(evidence)).toThrow(
        "agent-review-attempt-identity-invalid",
      );
    };

    rejectAttemptMutation((attempt) => {
      attempt.provider = "codex";
    });
    rejectAttemptMutation((attempt) => {
      attempt.exitCode = 1;
    });
    rejectAttemptMutation((attempt) => {
      attempt.receiptFileDigest = "0".repeat(64);
    });
    rejectAttemptMutation((attempt) => {
      attempt.verdictDigest = "0".repeat(64);
    });

    const rejectVerdictFieldMutation = (field: "pr" | "exact_head", value: string) => {
      const evidence = agentReviewEvidence();
      const originalVerdict = readFileSync(evidence.verdictPath, "utf8");
      const mutatedVerdict = originalVerdict.replace(
        new RegExp(`^${field}: .*?$`, "m"),
        `${field}: ${value}`,
      );
      expect(mutatedVerdict).not.toBe(originalVerdict);
      writeFileSync(evidence.verdictPath, mutatedVerdict);

      const audit = readFileSync(evidence.auditPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      audit[0].verdictDigest = createHash("sha256").update(mutatedVerdict).digest("hex");
      writeFileSync(evidence.auditPath, `${JSON.stringify(audit[0])}\n`);
      expect(() => verifyAgentReviewJoin(evidence)).toThrow(
        "agent-review-attempt-identity-invalid",
      );
    };

    rejectVerdictFieldMutation("pr", "13");
    rejectVerdictFieldMutation("exact_head", "b".repeat(40));
  });

  it("U-ST-PACKCANARY-015..019: offline structural join accepts a complete fixture (not an AT-DIST-003 run)", () => {
    const input = agentRecord();
    const releaseDirectory = agentReleaseDir(input.assetBytes);
    const review = agentReviewEvidence();
    const subjectRevision = review.subjectRevision;
    const authoring = {
      provider: "codex",
      model: "gpt-6-luna",
      invocation: [
        "ut-tdd",
        "codex",
        "--role",
        "se",
        "--model",
        "gpt-6-luna",
        "--effort",
        "high",
        "--task",
        "write L1 business requirements",
        "--execute",
        "--json",
      ],
      role: "se",
      template_source: "pack-template",
      provenance: "live-provider",
      template_slot: "DOC-L1-REQUIREMENTS",
      transcript: "provider started; wrote subject from shipped template",
      baseline_revision: "f".repeat(40),
      subject_revision: subjectRevision,
      subject_parent: "f".repeat(40),
    };
    const verified = verifyAgentE2EEvidence({
      tag: AGENT_E2E_TAG,
      commentUrl,
      publishRecord: input.value,
      releaseDirectory,
      subjectRevision,
      authoring,
      positive: {
        revision: subjectRevision,
        applicable: true,
        passed: true,
        messages: ["G1 passed"],
      },
      negative: {
        revision: "b".repeat(40),
        parent: subjectRevision,
        applicable: true,
        passed: false,
        messages: ["required doc not created: business-requirements.md"],
      },
      review,
    });
    expect(verified).toMatchObject({
      tag: AGENT_E2E_TAG,
      assetDigests: Object.fromEntries(
        Object.entries(input.assetBytes).map(([name, bytes]) => [name, sha(bytes)]),
      ),
      consumerAnchorDigest: sha("canary3-anchor"),
      subjectRevision,
    });
  });
});
