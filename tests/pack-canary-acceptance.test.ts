import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createCanaryFixture,
  isolatedCanaryEnv,
  removeCanaryFixtureTree,
} from "./support/pack-internal-canary.ts";

interface AcceptanceModule {
  CANARY_ASSETS: readonly string[];
  CANARY_TAG: string;
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
  verifyReleaseDirectory(
    releaseDir: string,
    record: ReturnType<AcceptanceModule["parsePublishRecord"]>,
  ): {
    actualDigests: Record<string, string>;
  };
  verifyInstallEvidence(evidence: unknown, consumerRoot: string, removedPaths: string[]): void;
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
  CANARY_ASSETS,
  CANARY_TAG,
  canaryAssetsForTag,
  createConsumerPlan,
  main,
  createClosedReviewProviders,
  findForbiddenReferences,
  parsePublishRecord,
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
});
