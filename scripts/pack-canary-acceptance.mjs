import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

export const CANARY_TAG = "v0.2.0-canary.2";
export const AGENT_E2E_TAG = "v0.2.0-canary.4";
export const PACK_RELEASE_PREFIX =
  "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases/tag/";
export const SOURCE_ISSUE_PREFIX =
  "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/418#issuecomment-";
export const canaryAssetsForTag = (tag) => Object.freeze([
  `${tag}.tar.gz`,
  `${tag}.tar.gz.sha256`,
  `${tag}.ut-tdd.mjs`,
  `${tag}.consumer-runtime.json`,
  `${tag}.consumer.sha256`,
]);
export const CANARY_ASSETS = canaryAssetsForTag(CANARY_TAG);

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const objectWith = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`publish-record-invalid:${field}`);
  return value;
}

function requireDigest(value, field) {
  if (typeof value !== "string" || !digestPattern.test(value))
    throw new Error(`publish-record-invalid:${field}`);
  return value;
}

function verifyPair(pair, field) {
  if (!objectWith(pair, ["producer_sha256", "independent_sha256"]))
    throw new Error(`publish-record-invalid:${field}`);
  const producer = requireDigest(pair.producer_sha256, `${field}.producer_sha256`);
  const independent = requireDigest(pair.independent_sha256, `${field}.independent_sha256`);
  if (producer !== independent) throw new Error(`publish-record-digest-disagreement:${field}`);
  return producer;
}

/** Parse a JSON copy of the canonical #418 publish comment; the comment remains authoritative. */
export function parsePublishRecord(value, commentUrl, { expectedTag = CANARY_TAG } = {}) {
  if (!objectWith(value, [
    "tag", "release_url", "c1_commit", "c2_commit", "recorded_by", "recorded_at",
    "assets", "consumer_anchor_digest",
  ])) throw new Error("publish-record-invalid:fields");
  if (value.tag !== expectedTag) throw new Error("publish-record-tag-not-exact");
  if (value.release_url !== `${PACK_RELEASE_PREFIX}${expectedTag}`)
    throw new Error("publish-record-release-url-not-exact");
  if (typeof value.c1_commit !== "string" || !commitPattern.test(value.c1_commit) ||
      typeof value.c2_commit !== "string" || !commitPattern.test(value.c2_commit))
    throw new Error("publish-record-invalid:commit");
  requireString(value.recorded_by, "recorded_by");
  if (typeof value.recorded_at !== "string" || Number.isNaN(Date.parse(value.recorded_at)))
    throw new Error("publish-record-invalid:recorded_at");
  const assetNames = canaryAssetsForTag(expectedTag);
  if (!objectWith(value.assets, assetNames))
    throw new Error("publish-record-asset-set-not-exact");
  const assetDigests = Object.fromEntries(assetNames.map((name) => [
    name,
    verifyPair(value.assets[name], `assets.${name}`),
  ]));
  const consumerAnchorDigest = verifyPair(value.consumer_anchor_digest, "consumer_anchor_digest");
  if (typeof commentUrl !== "string" ||
      !commentUrl.startsWith(SOURCE_ISSUE_PREFIX) ||
      !/^\d+$/.test(commentUrl.slice(SOURCE_ISSUE_PREFIX.length)))
    throw new Error("publish-record-comment-url-invalid");
  return { value, assetDigests, consumerAnchorDigest, commentUrl };
}

export function verifyReleaseDirectory(releaseDir, publishRecord) {
  const directory = realpathSync.native(resolve(releaseDir));
  const entries = readdirSync(directory).sort();
  const assetNames = Object.keys(publishRecord.assetDigests).sort();
  if (entries.join("\0") !== assetNames.join("\0"))
    throw new Error("release-asset-set-not-exact");
  const actualDigests = {};
  for (const name of assetNames) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error(`release-asset-not-regular-file:${name}`);
    const digest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    if (digest !== publishRecord.assetDigests[name])
      throw new Error(`release-asset-digest-mismatch:${name}`);
    actualDigests[name] = digest;
  }
  return { directory, actualDigests };
}

export function buildInstallerInvocation(releaseDirectory, anchorDigest, tag = CANARY_TAG) {
  if (tag !== CANARY_TAG && tag !== AGENT_E2E_TAG && tag !== "v0.0.0-canary.0")
    throw new Error("acceptance-tag-not-canary-2-or-offline-fixture");
  const args = [
    join(releaseDirectory, `${tag}.ut-tdd.mjs`),
    "setup", "--solo", "--consumer-runtime-release", releaseDirectory,
    "--expected-consumer-digest", anchorDigest,
  ];
  if (!args.includes("--consumer-runtime-release") || args.includes("--consumer-runtime-input"))
    throw new Error("acceptance-installer-input-not-release-assets");
  return args;
}

/** Parse the separate AT-DIST-003 publish record without widening the canary.2 lane. */
export function parseAgentE2ERecord(value, commentUrl) {
  return parsePublishRecord(value, commentUrl, { expectedTag: AGENT_E2E_TAG });
}

/** Build only the canary.4 Release-assets installer command used by AT-DIST-003. */
export function buildAgentE2EInstallerInvocation(releaseDirectory, anchorDigest) {
  if (!digestPattern.test(anchorDigest)) throw new Error("agent-e2e-anchor-invalid");
  return [
    join(releaseDirectory, `${AGENT_E2E_TAG}.ut-tdd.mjs`),
    "setup", "--solo", "--consumer-runtime-release", releaseDirectory,
    "--expected-consumer-digest", anchorDigest,
  ];
}

const agentEvidenceObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const agentCommit = (value) => typeof value === "string" && commitPattern.test(value);
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

/** Validate recorded Codex authorship and the distinct pre-subject baseline revision. */
export function verifyAgentAuthoringEvidence(value) {
  if (!agentEvidenceObject(value) || value.provider !== "codex" || value.model !== "gpt-6-luna" ||
      value.template_source !== "pack-template" || value.provenance !== "live-provider" ||
      value.template_slot !== "DOC-L1-REQUIREMENTS" ||
      !Array.isArray(value.invocation) ||
      value.invocation[0] !== "ut-tdd" || value.invocation[1] !== "codex" ||
      !value.invocation.includes("--role") || !hasText(value.role) ||
      !value.invocation.includes("--model") || !value.invocation.includes("--effort") ||
      !value.invocation.includes("high") || !value.invocation.includes("--task") ||
      !value.invocation.includes("--execute") || !value.invocation.includes("--json") ||
      !value.invocation.includes(value.role) || !hasText(value.transcript) ||
      !agentCommit(value.baseline_revision) || !agentCommit(value.subject_revision) ||
      value.baseline_revision === value.subject_revision ||
      value.subject_parent !== value.baseline_revision)
    throw new Error("agent-authoring-provenance-invalid");
}

/** Require the recorded positive G1 result for the exact authored subject revision. */
export function verifyAgentG1Positive(value, subjectRevision) {
  if (!agentEvidenceObject(value) || value.applicable !== true || value.passed !== true ||
      !Array.isArray(value.messages) || value.messages.some((message) =>
        typeof message !== "string" || /could not run/i.test(message)) ||
      !agentCommit(value.revision) || value.revision !== subjectRevision)
    throw new Error("agent-g1-positive-invalid");
}

/** Require a separate negative revision that names the frozen required document slot. */
export function verifyAgentG1Negative(value, positiveRevision) {
  if (!agentEvidenceObject(value) || !agentCommit(positiveRevision) ||
      !agentCommit(value.revision) || value.revision === positiveRevision ||
      value.parent !== positiveRevision || value.applicable !== true || value.passed !== false ||
      !Array.isArray(value.messages) || !value.messages.some((message) =>
        typeof message === "string" && /business-requirements\.md/i.test(message)))
    throw new Error("agent-g1-negative-invalid");
}

function requireCommandSuccess(result, label, allowedStatuses = [0]) {
  if (result?.error || !allowedStatuses.includes(result?.status))
    throw new Error(`${label}-failed:${result?.error?.message ?? result?.stderr ?? result?.status ?? "unknown"}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runAgentCli(root, cliPath, args, run, timeout = 300_000) {
  return run(process.execPath, [cliPath, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: process.env, timeout,
  });
}

function replaceFrontmatterField(content, key, value) {
  const pattern = new RegExp(`^${key}:[^\\r\\n]*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, `${key}: ${value}`);
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n"))
    throw new Error(`agent-baseline-template-frontmatter-invalid:${key}`);
  return content.replace(/^(---\r?\n)/, `$1${key}: ${value}\n`);
}

function parseAgentGateResult(result, label) {
  requireCommandSuccess(result, label, [0, 1]);
  const output = parseCliJson(result.stdout, label);
  const gate = output?.static_gate;
  if (!agentEvidenceObject(gate) || gate.gate !== "G1" || typeof gate.applicable !== "boolean" ||
      typeof gate.passed !== "boolean" || !Array.isArray(gate.messages))
    throw new Error(`${label}-static-gate-result-invalid`);
  if (gate.passed) {
    const trace = gate.messages.find((message) => typeof message === "string" && message.startsWith("g1-trace - OK ("));
    const counts = trace?.match(/business=(\d+), screens=(\d+), p0Fr=(\d+), l3Plans=(\d+)/);
    if (!counts || Number(counts[1]) < 1 || Number(counts[2]) < 1 || Number(counts[3]) < 1)
      throw new Error(`${label}-g1-trace-baseline-empty`);
  }
  return gate;
}

/**
 * Collect real local authoring and G1 CLI evidence without invoking raw providers.
 * Callers must supply an already-installed disposable consumer checkout. This
 * function uses only the consumer-local UT-TDD wrapper and never pushes a ref.
 */
export function runAgentAuthoringAndGates(input) {
  if (!agentEvidenceObject(input) || typeof input.consumerRoot !== "string")
    throw new Error("agent-authoring-input-invalid");
  const root = realpathSync.native(resolve(input.consumerRoot));
  const run = input.run ?? ((binary, args, options) => spawnSync(binary, args, options));
  const cliPath = realpathSync.native(resolve(root, ".ut-tdd", "bin", "ut-tdd.mjs"));
  if (!isInside(root, cliPath)) throw new Error("consumer_runtime_external_path");
  const git = (...args) => {
    const result = run("git", ["-C", root, ...args], {
      cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
    });
    requireCommandSuccess(result, "agent-authoring-git");
    return String(result.stdout ?? "").trim();
  };
  const normalizedRemote = git("remote", "get-url", "origin")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "").replace(/\/$/, "");
  if (normalizedRemote !== "https://github.com/unison-ai-product/ut-tdd-consumer-canary")
    throw new Error("agent-authoring-wrong-consumer-repository");
  const identity = JSON.parse(readFileSync(join(root, "ut-tdd.project.json"), "utf8"));
  if (identity?.schema_version !== "ut-tdd.project/v1" ||
      identity.repository_identity !== "unison-ai-product/ut-tdd-consumer-canary")
    throw new Error("agent-authoring-consumer-identity-invalid");
  if (git("status", "--porcelain").length !== 0)
    throw new Error("agent-authoring-consumer-not-clean");
  const initialRevision = git("rev-parse", "HEAD");
  const subjectBranch = git("branch", "--show-current");
  if (!agentCommit(initialRevision) || !hasText(subjectBranch))
    throw new Error("agent-authoring-baseline-invalid");

  const templateResult = runAgentCli(root, cliPath,
    ["vmodel", "template", "--slot", "DOC-L1-REQUIREMENTS", "DOC-L2-SCREEN", "DOC-L12-ACCEPTANCE", "--json"], run);
  requireCommandSuccess(templateResult, "agent-authoring-template");
  const templateOutput = parseCliJson(templateResult.stdout, "agent-authoring-template");
  const templatePaths = {
    functional: "docs/design/L1-requirements/functional-requirements.md",
    screenSource: "docs/design/L2-screen/screen-list.md",
    acceptance: "docs/test-design/L12-acceptance-test-design.md",
  };
  if (!Array.isArray(templateOutput?.written) ||
      Object.values(templatePaths).some((path) => !templateOutput.written.includes(path) || !existsSync(join(root, path))))
    throw new Error("agent-authoring-shipped-template-not-written");
  const shippedTemplates = Object.fromEntries(Object.entries(templatePaths).map(([name, path]) => [name, {
    slot: name === "functional" ? "DOC-L1-REQUIREMENTS" : name === "screenSource" ? "DOC-L2-SCREEN" : "DOC-L12-ACCEPTANCE",
    path,
    sha256: `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`,
  }]));
  const functionalPath = templatePaths.functional;
  let functionalBaseline = replaceFrontmatterField(readFileSync(join(root, functionalPath), "utf8"), "status", "confirmed");
  functionalBaseline = replaceFrontmatterField(functionalBaseline, "pair_artifact", "docs/test-design/L12-acceptance-test-design.md");
  functionalBaseline += "\n| **FR-L1-01** | Consumer baseline function | P0 | PLAN-L1-02-functional-requirements |\n";
  writeFileSync(join(root, functionalPath), functionalBaseline);

  const screenSourcePath = templatePaths.screenSource;
  let screenTemplate = readFileSync(join(root, screenSourcePath), "utf8");
  if (!screenTemplate.includes("signup") || !screenTemplate.includes("SC-001"))
    throw new Error("agent-baseline-screen-template-source-invalid");
  screenTemplate = replaceFrontmatterField(screenTemplate, "pair_artifact", "docs/test-design/L12-acceptance-test-design.md");
  writeFileSync(join(root, screenSourcePath), screenTemplate);
  let screenBaseline = screenTemplate;
  screenBaseline = replaceFrontmatterField(screenBaseline, "layer", "L1");
  screenBaseline = replaceFrontmatterField(screenBaseline, "sub_doc", "screen");
  screenBaseline = replaceFrontmatterField(screenBaseline, "status", "confirmed");
  screenBaseline = replaceFrontmatterField(screenBaseline, "pair_artifact", "docs/test-design/L12-acceptance-test-design.md");
  screenBaseline = screenBaseline.replace(/^# DOC-L2-SCREEN:.*$/m, "# L1 screen requirements baseline");
  screenBaseline += [
    "", "## §1 画面要求", "| Screen ID | Name | Purpose |", "|---|---|---|",
    "| **PM-01** | signup | Begin the consumer signup flow (derived from DOC-L2-SCREEN signup / SC-001; ID normalization only) |",
    "", "## §2 次", "",
    "### §5.1 業務要求トレース", "| **BR-01** | PM-01 |", "",
    "### §5.3 機能要求トレース", "| **FR-L1-01** | PM-01 |", "",
    "### §5.4 次", "", "### §5.5 画面トレース", "| **PM-01** | BR-01 / FR-L1-01 |", "",
    "### §5.6 次", "",
  ].join("\n");
  const screenPath = "docs/design/L1-requirements/screen-requirements.md";
  mkdirSync(dirname(join(root, screenPath)), { recursive: true });
  writeFileSync(join(root, screenPath), screenBaseline, { flag: "wx" });

  const acceptancePath = templatePaths.acceptance;
  let acceptanceBaseline = readFileSync(join(root, acceptancePath), "utf8");
  acceptanceBaseline = replaceFrontmatterField(acceptanceBaseline, "pair_artifact", "docs/design/");
  writeFileSync(join(root, acceptancePath), acceptanceBaseline);
  const baselinePaths = [functionalPath, screenSourcePath, acceptancePath, screenPath].sort();
  const changedBaseline = git("status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean)
    .map((line) => line.slice(3).replaceAll("\\", "/").replace(/ -> .+$/, "")).sort();
  if (changedBaseline.length !== baselinePaths.length || baselinePaths.some((path, index) => path !== changedBaseline[index]))
    throw new Error("agent-authoring-template-path-set-invalid");
  git("add", "--", ...baselinePaths);
  const templateCommit = run("git", ["-C", root, "commit", "--quiet", "-m", "test(canary): seed shipped L1 template"], {
    cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
  });
  requireCommandSuccess(templateCommit, "agent-authoring-template-commit");
  const baselineRevision = git("rev-parse", "HEAD");
  if (!agentCommit(baselineRevision) || git("rev-parse", "HEAD^1") !== initialRevision ||
      git("status", "--porcelain", "--untracked-files=all") !== "")
    throw new Error("agent-authoring-baseline-invalid");
  const baselineDocuments = Object.fromEntries(baselinePaths.map((path) => [path, {
    kind: "baseline",
    sha256: `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`,
  }]));

  const subjectPath = "docs/design/L1-requirements/business-requirements.md";
  const task = [
    "Author the L1 business requirements subject for this canary consumer.",
    `Use the shipped V-model template at ${functionalPath} as the authoring source.`,
    `Create or update only ${subjectPath}; do not edit other files.`,
    "Create a concise, valid requirements document that pairs with the shipped L1 acceptance test design.",
    "Write one user requirement for the signup screen; include business ID BR-01 traced to baseline PM-01 (the signup screen, not a different feature).",
    "Set frontmatter layer: L1, sub_doc: business, status: confirmed, and pair_artifact: docs/test-design/L12-acceptance-test-design.md.",
  ].join("\n");
  const authorInvocation = ["ut-tdd", "codex", "--role", "se", "--model", "gpt-6-luna",
    "--effort", "high", "--task", task, "--execute", "--json"];
  const authorResult = runAgentCli(root, cliPath, authorInvocation.slice(1), run, 1_800_000);
  const authorTranscript = requireCommandSuccess(authorResult, "agent-authoring-codex");
  const authorOutput = parseCliJson(authorResult.stdout, "agent-authoring-codex");
  if (authorOutput?.provider !== "codex" || authorOutput?.available === false ||
      !hasText(authorOutput?.model) || authorOutput?.exit_code !== 0 ||
      !existsSync(join(root, subjectPath)))
    throw new Error("agent-authoring-live-provider-result-invalid");
  const changed = git("status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean)
    .map((line) => line.slice(3).replaceAll("\\", "/").replace(/ -> .+$/, ""));
  if (changed.length !== 1 || changed[0] !== subjectPath)
    throw new Error("agent-authoring-changed-path-set-invalid");

  const subjectBytes = readFileSync(join(root, subjectPath));
  git("add", "--", subjectPath);
  const commitResult = run("git", ["-C", root, "commit", "--quiet", "-m", "feat(canary): author L1 business requirements"], {
    cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
  });
  requireCommandSuccess(commitResult, "agent-authoring-subject-commit");
  const subjectRevision = git("rev-parse", "HEAD");
  const subjectParent = git("rev-parse", "HEAD^1");
  const committedBlob = git("rev-parse", `HEAD:${subjectPath}`);
  if (subjectParent !== baselineRevision || !agentCommit(subjectRevision) ||
      !/^[a-f0-9]{40}$/.test(committedBlob) || git("status", "--porcelain", "--untracked-files=all") !== "")
    throw new Error("agent-authoring-subject-commit-boundary-invalid");

  const positiveGate = parseAgentGateResult(
    runAgentCli(root, cliPath, ["gate", "G1", "--json"], run), "agent-g1-positive",
  );
  verifyAgentG1Positive({ ...positiveGate, revision: git("rev-parse", "HEAD") }, subjectRevision);

  const negativeParent = subjectRevision;
  const negativeBranch = `ut-tdd-agent-e2e-negative-${randomUUID()}`;
  const switchNegative = run("git", ["-C", root, "switch", "--quiet", "-c", negativeBranch, subjectRevision], {
    cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
  });
  requireCommandSuccess(switchNegative, "agent-g1-negative-branch-create");
  let negativeRevision;
  let negativeGate;
  try {
    git("rm", "--", subjectPath);
    const negativeCommit = run("git", ["-C", root, "commit", "--quiet", "-m", "test(canary): remove required business requirements"], {
      cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
    });
    requireCommandSuccess(negativeCommit, "agent-g1-negative-commit");
    negativeRevision = git("rev-parse", "HEAD");
    negativeGate = parseAgentGateResult(
      runAgentCli(root, cliPath, ["gate", "G1", "--json"], run),
      "agent-g1-negative",
    );
    verifyAgentG1Negative({ ...negativeGate, revision: negativeRevision, parent: git("rev-parse", "HEAD^1") }, negativeParent);
  } finally {
    const switchBack = run("git", ["-C", root, "switch", "--quiet", subjectBranch], {
      cwd: root, encoding: "utf8", windowsHide: true, env: process.env, timeout: 30_000,
    });
    requireCommandSuccess(switchBack, "agent-g1-negative-restore-subject-branch");
    if (git("rev-parse", "HEAD") !== subjectRevision || git("branch", "--show-current") !== subjectBranch)
      throw new Error("agent-g1-negative-subject-branch-restore-invalid");
  }

  return {
    authoring: {
      provider: authorOutput.provider,
      model: authorOutput.model,
      invocation: authorInvocation,
      role: "se",
      template_source: "pack-template",
      template_slot: "DOC-L1-REQUIREMENTS",
      provenance: "live-provider",
      transcript: authorTranscript,
      baseline_revision: baselineRevision,
      subject_revision: subjectRevision,
      subject_parent: subjectParent,
      negative_branch: negativeBranch,
    },
    baseline: {
      kind: "baseline",
      revision: baselineRevision,
      parent_revision: initialRevision,
      source_templates: shippedTemplates,
      documents: baselineDocuments,
      derivation: {
        functional: { id: "FR-L1-01", priority: "P0" },
        screen: { source_id: "SC-001", source_label: "signup", derived_id: "PM-01" },
        trace: { business_id: "BR-01", functional_id: "FR-L1-01", screen_id: "PM-01" },
      },
    },
    subject: {
      path: subjectPath,
      revision: subjectRevision,
      blobOid: committedBlob,
      contentSha256: `sha256:${createHash("sha256").update(subjectBytes).digest("hex")}`,
    },
    positive: { ...positiveGate, revision: subjectRevision },
    negative: { ...negativeGate, revision: negativeRevision, parent: negativeParent, branch: negativeBranch },
  };
}

/** Join the real subject, canonical consumer custody, and non-author Claude receipt. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function reviewIdentityDigest(request) {
  return createHash("sha256").update(stableJson({
    schemaVersion: "review-request/v1",
    memoryId: request.memoryId,
    pr: request.pr,
    exactHead: request.exactHead,
    authorFamily: request.authorFamily,
  }), "utf8").digest("hex");
}

function parseCliJson(value, label) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { throw new Error(`${label}-json-invalid`); }
  }
  return value;
}

function readCanonicalJson(path, root, label) {
  const canonical = realpathSync.native(resolve(path));
  if (!isInside(root, canonical) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${label}-custody-path-invalid`);
  const bytes = readFileSync(canonical);
  try { return { value: JSON.parse(bytes.toString("utf8")), bytes }; }
  catch { throw new Error(`${label}-json-invalid`); }
}

function runGitBuffer(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer", stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Read the request, receipt, attempt audit and verdict from canonical consumer custody. */
export function verifyAgentReviewJoin(input) {
  if (!agentEvidenceObject(input) || typeof input.consumerRoot !== "string")
    throw new Error("agent-review-input-invalid");
  if (input.repository !== "unison-ai-product/ut-tdd-consumer-canary" ||
      !Number.isSafeInteger(input.pr) || input.pr < 1 || !agentCommit(input.head) ||
      !Array.isArray(input.dispatchInvocation) ||
      input.dispatchInvocation.slice(0, 3).join(" ") !== "ut-tdd review live-dispatch" ||
      !Array.isArray(input.consumeInvocation) ||
      input.consumeInvocation.slice(0, 3).join(" ") !== "ut-tdd review live-consume" ||
      !hasText(input.dispatchTranscript) || !hasText(input.consumeTranscript))
    throw new Error("agent-review-run-boundary-invalid");
  const root = realpathSync.native(resolve(input.consumerRoot));
  const dispatch = parseCliJson(input.dispatchResult, "agent-review-dispatch");
  const consume = parseCliJson(input.consumeResult, "agent-review-consume");
  const issued = dispatch?.request;
  if (dispatch?.ok !== true || dispatch.reviewer !== "claude" || issued?.ok !== true ||
      !/^[a-f0-9]{64}$/.test(issued.digest ?? ""))
    throw new Error("agent-review-live-dispatch-failed");
  if (consume?.ok !== true || consume.projection?.ok !== true)
    throw new Error("agent-review-live-consume-failed");

  const digest = issued.digest;
  const requestPath = join(root, ".ut-tdd", "review", "requests", `${digest}.json`);
  const expectedRequestPath = resolve(requestPath);
  if (resolve(issued.path) !== expectedRequestPath)
    throw new Error("agent-review-request-custody-invalid");
  const requestRead = readCanonicalJson(requestPath, root, "agent-review-request");
  const request = requestRead.value;
  const requestKeys = ["memoryId", "pr", "exactHead", "reviewRevision", "authorFamily", "requestedAt", "invocationNonce"];
  if (!agentEvidenceObject(request) || Object.keys(request).sort().join("\0") !== requestKeys.sort().join("\0") ||
      request.authorFamily !== "codex" || !Number.isSafeInteger(request.pr) || request.pr < 1 ||
      !agentCommit(request.exactHead) || !hasText(request.requestedAt) || !hasText(request.invocationNonce) ||
      request.reviewRevision !== `rv1-${digest}` ||
      request.pr !== input.pr || request.exactHead !== input.head ||
      reviewIdentityDigest(request) !== digest || issued.request?.memoryId !== request.memoryId ||
      issued.request?.pr !== request.pr || issued.request?.exactHead !== request.exactHead ||
      issued.request?.reviewRevision !== request.reviewRevision || issued.request?.authorFamily !== "codex")
    throw new Error("agent-review-request-identity-invalid");

  const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${digest}.json`);
  const expectedReceiptPath = resolve(receiptPath);
  const receiptRead = readCanonicalJson(receiptPath, root, "agent-review-receipt");
  const receipt = receiptRead.value;
  const receiptKeys = ["memoryId", "pr", "head", "reviewRevision", "reviewerFamily", "kind", "verdict", "blockingFindings", "at"];
  if (!agentEvidenceObject(receipt) || Object.keys(receipt).sort().join("\0") !== receiptKeys.sort().join("\0") ||
      receipt.memoryId !== request.memoryId || receipt.pr !== request.pr || receipt.head !== request.exactHead ||
      receipt.reviewRevision !== request.reviewRevision || receipt.reviewerFamily === "codex")
    throw new Error(receipt?.reviewerFamily === "codex" ? "same_family_reviewer" : "agent-review-receipt-identity-invalid");
  if (receipt.reviewerFamily !== "claude" || receipt.kind !== "verdict" ||
      !["PASS", "PASS-WEAK", "FLAG"].includes(receipt.verdict) ||
      !Array.isArray(receipt.blockingFindings) || !hasText(receipt.at) ||
      (receipt.verdict === "FLAG" ? receipt.blockingFindings.length < 1 : receipt.blockingFindings.length !== 0) ||
      consume.projection.path !== expectedReceiptPath ||
      consume.projection.digest !== digest ||
      stableJson(consume.projection.receipt) !== stableJson(receipt))
    throw new Error("agent-review-receipt-schema-invalid");

  const head = request.exactHead;
  const subjectPath = "docs/design/L1-requirements/business-requirements.md";
  let blobOid;
  let subjectBytes;
  try {
    blobOid = runGitBuffer(root, ["rev-parse", `${head}:${subjectPath}`]).toString("utf8").trim();
    subjectBytes = runGitBuffer(root, ["show", `${head}:${subjectPath}`]);
  } catch { throw new Error("agent-review-subject-git-object-missing"); }
  if (!/^[a-f0-9]{40}$/.test(blobOid)) throw new Error("agent-review-subject-blob-invalid");

  const commonDir = resolve(root, runGitBuffer(root, ["rev-parse", "--git-common-dir"]).toString("utf8").trim());
  const auditPath = join(commonDir, "ut-tdd-runtime", "review-custody", "review-custody.jsonl");
  let events;
  try {
    events = readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { throw new Error("agent-review-attempt-audit-unavailable"); }
  const attempts = events.filter((event) => event.requestDigest === digest && event.kind === "attempt_completed");
  if (attempts.length !== 1) throw new Error("agent-review-attempt-completion-not-unique");
  const attempt = attempts[0];
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1)
    throw new Error("agent-review-attempt-identity-invalid");
  const verdictPath = join(root, ".ut-tdd", "review", "verdicts", digest, "attempts", `attempt-${attempt.attempt}`, "verdict.txt");
  let canonicalVerdictPath;
  let verdictRead;
  try {
    canonicalVerdictPath = realpathSync.native(verdictPath);
    if (!isInside(root, canonicalVerdictPath) || lstatSync(verdictPath).isSymbolicLink() ||
        !lstatSync(verdictPath).isFile()) throw new Error("invalid");
    verdictRead = readFileSync(canonicalVerdictPath);
  } catch { throw new Error("agent-review-verdict-custody-invalid"); }
  const verdictText = verdictRead.toString("utf8");
  const verdictFields = new Map([...verdictText.matchAll(/^([a-z_]+):[ \t]*(.*)$/gm)].map((match) => [match[1], match[2].trim()]));
  const auditReceiptDigest = createHash("sha256").update(receiptRead.bytes).digest("hex");
  const auditVerdictDigest = createHash("sha256").update(verdictRead).digest("hex");
  if (attempt.exactHead !== head || attempt.verdictPath !== resolve(verdictPath) ||
      attempt.provider !== "claude" || !hasText(attempt.model) || attempt.exitCode !== 0 ||
      attempt.receiptFileDigest !== auditReceiptDigest || attempt.verdictDigest !== auditVerdictDigest ||
      verdictFields.get("schema_version") !== "ut-tdd.review-verdict/v1" ||
      verdictFields.get("request_digest") !== digest || verdictFields.get("attempt") !== String(attempt.attempt) ||
      verdictFields.get("pr") !== String(request.pr) || verdictFields.get("exact_head") !== head ||
      verdictFields.get("review_revision") !== request.reviewRevision ||
      verdictFields.get("reviewer_provider") !== "claude" || verdictFields.get("reviewer_model") !== attempt.model ||
      verdictFields.get("invocation_nonce") !== request.invocationNonce ||
      !new RegExp(`^VERDICT: ${receipt.verdict}$`, "m").test(verdictText))
    throw new Error("agent-review-attempt-identity-invalid");

  return {
    repository: input.repository ?? "unison-ai-product/ut-tdd-consumer-canary",
    pr: request.pr,
    prHead: head,
    subject: {
      path: subjectPath,
      revision: head,
      blobOid,
      contentSha256: `sha256:${createHash("sha256").update(subjectBytes).digest("hex")}`,
    },
    recomputed: { blobOid, contentSha256: `sha256:${createHash("sha256").update(subjectBytes).digest("hex")}` },
    request: { ...request, path: `.ut-tdd/review/requests/${digest}.json`, digest },
    receipt: {
      ...receipt,
      path: `.ut-tdd/review/receipts/${digest}.json`,
      provider: attempt.provider,
      model: attempt.model,
      exitCode: attempt.exitCode,
      attempt: attempt.attempt,
    },
    verdictPath: relative(root, verdictPath).replaceAll("\\", "/"),
    requestDigest: digest,
    verdict: receipt.verdict,
    attempt,
    dispatchInvocation: input.dispatchInvocation,
    consumeInvocation: input.consumeInvocation,
    dispatchTranscript: input.dispatchTranscript,
    consumeTranscript: input.consumeTranscript,
  };
}

/** Execute only the frozen live-review route inside the already-existing consumer PR. */
export function runAgentReviewJoin(input) {
  if (!agentEvidenceObject(input) || typeof input.consumerRoot !== "string" ||
      !Number.isSafeInteger(input.pr) || input.pr < 1 || !agentCommit(input.head) ||
      !hasText(input.memoryId) || !hasText(input.memoryPath))
    throw new Error("agent-review-input-invalid");
  const root = realpathSync.native(resolve(input.consumerRoot));
  const run = input.run ?? ((binary, args, options) => spawnSync(binary, args, {
    cwd: options.cwd, encoding: "utf8", windowsHide: true,
    env: options.env ?? process.env, timeout: options.timeout ?? 300_000,
  }));
  const git = (...args) => run("git", args, { cwd: root, env: process.env, timeout: 30_000 });
  const remote = git("remote", "get-url", "origin");
  if (remote.error || remote.status !== 0) throw new Error("agent-review-consumer-origin-unavailable");
  const normalizedRemote = String(remote.stdout).trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "").replace(/\/$/, "");
  if (normalizedRemote !== "https://github.com/unison-ai-product/ut-tdd-consumer-canary")
    throw new Error("agent-review-wrong-consumer-repository");
  const localHead = String(git("rev-parse", "HEAD").stdout ?? "").trim();
  if (localHead !== input.head) throw new Error("agent-review-local-head-mismatch");
  const cliPath = realpathSync.native(resolve(root, ".ut-tdd", "bin", "ut-tdd.mjs"));
  if (!isInside(root, cliPath)) throw new Error("agent-review-runtime-outside-consumer");
  const identity = JSON.parse(readFileSync(join(root, "ut-tdd.project.json"), "utf8"));
  if (identity?.schema_version !== "ut-tdd.project/v1" ||
      identity.repository_identity !== "unison-ai-product/ut-tdd-consumer-canary")
    throw new Error("agent-review-consumer-identity-invalid");
  const requestIdentity = {
    schemaVersion: "review-request/v1", memoryId: input.memoryId,
    pr: input.pr, exactHead: input.head, authorFamily: "codex",
  };
  const digest = reviewIdentityDigest(requestIdentity);
  const revision = `rv1-${digest}`;
  const dispatchInvocation = ["ut-tdd", "review", "live-dispatch", "--memory-id", input.memoryId,
    "--memory-path", input.memoryPath, "--pr", String(input.pr), "--head", input.head,
    "--revision", revision, "--author-family", "codex", "--json"];
  const dispatch = run(process.execPath, [cliPath, ...dispatchInvocation.slice(1)], {
    cwd: root, env: process.env, timeout: 300_000,
  });
  const dispatchTranscript = `${dispatch.stdout ?? ""}${dispatch.stderr ?? ""}`;
  if (dispatch.error || dispatch.status !== 0)
    throw new Error(`agent-review-live-dispatch-failed:${dispatch.error?.message ?? dispatchTranscript}`);
  const dispatchResult = parseCliJson(dispatch.stdout, "agent-review-dispatch");
  const requestDigest = dispatchResult?.request?.digest;
  if (!/^[a-f0-9]{64}$/.test(requestDigest ?? ""))
    throw new Error("agent-review-live-dispatch-result-invalid");

  const projectNamespace = createHash("sha256")
    .update(`ut-tdd-project\0${identity.repository_identity}`, "utf8").digest("hex");
  const commonDir = resolve(root, runGitBuffer(root, ["rev-parse", "--git-common-dir"]).toString("utf8").trim());
  const inbox = join(commonDir, "ut-tdd-runtime", "projects", projectNamespace,
    "claude-memory-wake", "inbox");
  const envelopes = readdirSync(inbox).filter((name) => name.endsWith(".json")).map((name) => {
    const path = join(inbox, name);
    try { return { path, value: JSON.parse(readFileSync(path, "utf8")) }; }
    catch { return undefined; }
  }).filter((entry) => entry?.value?.requestDigest === requestDigest);
  if (envelopes.length !== 1) throw new Error("agent-review-envelope-not-unique");
  const consumeInvocation = ["ut-tdd", "review", "live-consume", "--envelope", envelopes[0].path, "--json"];
  const consume = run(process.execPath, [cliPath, ...consumeInvocation.slice(1)], {
    cwd: root, env: process.env, timeout: 1_800_000,
  });
  const consumeTranscript = `${consume.stdout ?? ""}${consume.stderr ?? ""}`;
  if (consume.error || consume.status !== 0)
    throw new Error(`agent-review-live-consume-failed:${consume.error?.message ?? consumeTranscript}`);
  return verifyAgentReviewJoin({
    consumerRoot: root,
    repository: "unison-ai-product/ut-tdd-consumer-canary",
    pr: input.pr,
    head: input.head,
    dispatchResult,
    consumeResult: consume.stdout,
    dispatchInvocation,
    consumeInvocation,
    dispatchTranscript,
    consumeTranscript,
  });
}

/** Offline structural join for fixtures; never use this as an AT-DIST-003 execution result. */
export function verifyAgentE2EEvidence(value) {
  if (!agentEvidenceObject(value) || value.tag !== AGENT_E2E_TAG ||
      !hasText(value.commentUrl) || !agentCommit(value.subjectRevision))
    throw new Error("agent-e2e-evidence-invalid");
  const record = parseAgentE2ERecord(value.publishRecord, value.commentUrl);
  const verifiedRelease = verifyReleaseDirectory(value.releaseDirectory, record);
  verifyAgentAuthoringEvidence(value.authoring);
  if (value.authoring.subject_revision !== value.subjectRevision)
    throw new Error("agent-authoring-subject-revision-mismatch");
  verifyAgentG1Positive(value.positive, value.subjectRevision);
  verifyAgentG1Negative(value.negative, value.subjectRevision);
  const review = verifyAgentReviewJoin(value.review);
  if (review.subject.revision !== value.subjectRevision)
    throw new Error("agent-review-subject-revision-mismatch");
  return {
    tag: AGENT_E2E_TAG,
    assetDigests: verifiedRelease.actualDigests,
    consumerAnchorDigest: record.consumerAnchorDigest,
    subjectRevision: value.subjectRevision,
    review,
  };
}

function parseArgs(argv) {
  const values = new Map();
  const repeated = [];
  for (let i = 0; i < argv.length; ) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("invalid-arguments");
    if (key === "--removed-path") repeated.push(value);
    else if (values.has(key)) throw new Error(`duplicate-argument:${key}`);
    else values.set(key, value);
    i += 2;
  }
  const phase = values.get("--phase") ?? "install";
  const required = phase === "install"
    ? ["--record", "--comment-url", "--release-dir", "--consumer-root", "--evidence"]
    : phase === "verify"
      ? ["--consumer-root", "--alternate-cwd", "--evidence"]
      : [];
  if (!required.length || required.some((key) => !values.has(key)))
    throw new Error("usage: install --record <json> --comment-url <url> --release-dir <dir> --consumer-root <empty-dir> --evidence <json> | verify --consumer-root <dir> --alternate-cwd <dir> --removed-path <path>... --evidence <json>");
  return { phase, values: Object.fromEntries(values), removedPaths: repeated };
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const run = deps.spawnSync ?? spawnSync;
  const parsed = parseArgs(argv);
  if (parsed.phase === "verify") return verifySmoke(parsed, { now, run });
  const args = parsed.values;
  const requestedTag = args["--tag"] ?? CANARY_TAG;
  if (args["--tag"] && requestedTag !== CANARY_TAG && requestedTag !== AGENT_E2E_TAG)
    throw new Error("acceptance-tag-not-exact");
  if (deps.fixtureTag && deps.fixtureTag !== "v0.0.0-canary.0")
    throw new Error("fixture-tag-not-allowed");
  const tag = deps.fixtureTag ?? requestedTag;
  if (deps.fixtureTag && args["--tag"] && deps.fixtureTag !== args["--tag"])
    throw new Error("fixture-tag-not-allowed");
  const recordBytes = readFileSync(args["--record"]);
  const record = parsePublishRecord(JSON.parse(recordBytes.toString("utf8")), args["--comment-url"], { expectedTag: tag });
  const { directory, actualDigests } = verifyReleaseDirectory(args["--release-dir"], record);
  const consumerRoot = realpathSync.native(resolve(args["--consumer-root"]));
  if (!isInside(realpathSync.native(tmpdir()), consumerRoot))
    throw new Error("consumer-root-not-disposable-temp");
  if (readdirSync(consumerRoot).length !== 0) throw new Error("consumer-root-not-empty");
  const anchorDenial = verifyWrongAnchorDenial(directory, record.consumerAnchorDigest, run, tag);
  verifyReleaseDirectory(directory, record);
  runProductGit(run, consumerRoot, ["init", "--quiet"]);
  runProductGit(run, consumerRoot, ["config", "user.email", "canary@example.invalid"]);
  runProductGit(run, consumerRoot, ["config", "user.name", "Canary acceptance"]);
  runProductGit(run, consumerRoot, ["remote", "add", "origin", "https://github.com/example/canary-consumer.git"]);
  writeFileSync(join(consumerRoot, "README.md"), "# Isolated canary consumer\n", { flag: "wx" });
  runProductGit(run, consumerRoot, ["add", "--", "README.md"]);
  runProductGit(run, consumerRoot, ["commit", "--quiet", "-m", "canary consumer baseline"]);
  const setupArgs = buildInstallerInvocation(directory, record.consumerAnchorDigest, tag);
  const startedAt = now();
  const setupHome = mkdtempSync(join(tmpdir(), "ut-canary-setup-home-"));
  for (const path of ["home", "appdata", "localappdata", "codex-home"])
    mkdirSync(join(setupHome, path));
  let child;
  try {
    child = run(process.execPath, setupArgs, {
      cwd: consumerRoot, encoding: "utf8", windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "", HOME: join(setupHome, "home"),
        USERPROFILE: join(setupHome, "home"), APPDATA: join(setupHome, "appdata"),
        LOCALAPPDATA: join(setupHome, "localappdata"), CODEX_HOME: join(setupHome, "codex-home"),
        UT_TDD_SKIP_UPDATE_CHECK: "1",
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", ComSpec: process.env.ComSpec,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      }, timeout: 300_000,
    });
  } finally {
    rmSync(setupHome, { recursive: true, force: true });
  }
  const transcript = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  let authoringTemplate = null;
  if (!child.error && child.status === 0) {
    const identityPath = join(consumerRoot, "ut-tdd.project.json");
    if (!existsSync(identityPath)) throw new Error("consumer-project-identity-not-generated");
    runProductGit(run, consumerRoot, ["add", "--", "ut-tdd.project.json"]);
    runProductGit(run, consumerRoot, ["commit", "--quiet", "-m", "canary consumer identity"]);
    // Keep only the consumer-owned authoring input, derived from verified release bytes.
    verifyReleaseDirectory(directory, record);
    const template = run("tar", ["-xOf", join(directory, `${tag}.tar.gz`),
      "docs/templates/plan/design/template.md"], {
      cwd: consumerRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    if (template.error || template.status !== 0)
      throw new Error(`shipped-plan-template-unavailable:${template.error?.message ?? template.stderr}`);
    createConsumerPlan(consumerRoot, template.stdout);
    authoringTemplate = {
      asset_name: `${tag}.tar.gz`,
      path: "docs/templates/plan/design/template.md",
      sha256: `sha256:${createHash("sha256").update(template.stdout, "utf8").digest("hex")}`,
    };
  }
  const evidence = {
    phase: "installed-awaiting-clean-restart",
    schema_version: "ut-tdd.pack-canary-acceptance/v1",
    tag,
    release_url: record.value.release_url,
    source_publish_comment_url: record.commentUrl,
    publish_record_sha256: `sha256:${createHash("sha256").update(recordBytes).digest("hex")}`,
    platform: process.platform,
    node_version: process.version,
    started_at: startedAt,
    completed_at: now(),
    setup_exit_code: child.status,
    setup_signal: child.signal ?? null,
    setup_command: [process.execPath, ...setupArgs],
    transcript,
    asset_sha256: actualDigests,
    consumer_anchor_digest: record.consumerAnchorDigest,
    wrong_anchor_denial: anchorDenial,
    consumer_root: consumerRoot,
    release_directory: directory,
    consumer_head: child.status === 0 ? productHead(run, consumerRoot) : null,
    authoring_input_sha256: child.status === 0
      ? `sha256:${createHash("sha256").update(readFileSync(join(consumerRoot, "canary-plan-draft.json"))).digest("hex")}`
      : null,
    authoring_template: authoringTemplate,
    reviewer_independent_digest_verification: "pending",
  };
  writeFileSync(resolve(args["--evidence"]), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(`consumer-setup-failed:${child.status ?? child.signal ?? "unknown"}:${transcript.slice(-2000)}`);
  process.stdout.write(`${JSON.stringify({ ok: true, evidence: resolve(args["--evidence"]), setup_exit_code: child.status })}\n`);
}

/** Observe the released installer fail before any consumer write on a wrong anchor. */
export function verifyWrongAnchorDenial(releaseDirectory, expectedAnchor, run = spawnSync, tag = CANARY_TAG) {
  if (!digestPattern.test(expectedAnchor)) throw new Error("wrong-anchor-input-invalid");
  const wrongAnchor = `sha256:${expectedAnchor[7] === "0" ? "1" : "0"}${expectedAnchor.slice(8)}`;
  const denyRoot = mkdtempSync(join(tmpdir(), "ut-canary-anchor-deny-"));
  try {
    const args = buildInstallerInvocation(releaseDirectory, wrongAnchor, tag);
    const child = run(process.execPath, args, {
      cwd: denyRoot, encoding: "utf8", windowsHide: true,
      env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        UT_TDD_SKIP_UPDATE_CHECK: "1" }, timeout: 120_000,
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    if (child.error || child.status === 0 || !output.includes("consumer_runtime_anchor_mismatch"))
      throw new Error(`wrong-anchor-not-typed-denied:${child.error?.message ?? child.status}`);
    if (readdirSync(denyRoot).length !== 0) throw new Error("wrong-anchor-wrote-consumer-root");
    return { exit_code: child.status, typed_reason: "consumer_runtime_anchor_mismatch",
      consumer_write_count: 0, argv: [process.execPath, ...args] };
  } finally {
    rmSync(denyRoot, { recursive: true, force: true });
  }
}

function runProductGit(run, consumerRoot, args) {
  const child = run("git", args, { cwd: consumerRoot, encoding: "utf8", windowsHide: true });
  if (child.error || child.status !== 0)
    throw new Error(`consumer-git-failed:${args[0]}:${child.error?.message ?? child.stderr ?? child.status}`);
  return (child.stdout ?? "").trim();
}

function productHead(run, consumerRoot) {
  const head = runProductGit(run, consumerRoot, ["rev-parse", "HEAD"]);
  if (!commitPattern.test(head)) throw new Error("consumer-head-invalid");
  return head;
}

function verifySmoke(parsed, { now, run }) {
  if (parsed.removedPaths.length < 2) throw new Error("verify-requires-removed-source-and-release-paths");
  const args = parsed.values;
  const expectedTag = args["--tag"] ?? CANARY_TAG;
  if (expectedTag !== CANARY_TAG && expectedTag !== AGENT_E2E_TAG)
    throw new Error("acceptance-tag-not-exact");
  const consumerRoot = realpathSync.native(resolve(args["--consumer-root"]));
  if (!isInside(realpathSync.native(tmpdir()), consumerRoot))
    throw new Error("consumer-root-not-disposable-temp");
  const alternateCwd = realpathSync.native(resolve(args["--alternate-cwd"]));
  if (isInside(consumerRoot, alternateCwd))
    throw new Error("verify-cwd-must-be-distinct-from-consumer-root");
  const evidencePath = resolve(args["--evidence"]);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  verifyInstallEvidence(evidence, consumerRoot, parsed.removedPaths, expectedTag);
  if (productHead(run, consumerRoot) !== evidence.consumer_head)
    throw new Error("consumer-head-drift-since-install");
  for (const path of parsed.removedPaths)
    if (existsSync(resolve(path))) throw new Error(`removed-path-still-exists:${path}`);
  const wrapper = join(consumerRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
  if (!existsSync(wrapper)) throw new Error("consumer-local-wrapper-missing");
  const active = JSON.parse(readFileSync(join(consumerRoot, ".ut-tdd", "runtime", "activation", "active.json"), "utf8"));
  if (typeof active.bundle_path !== "string" || typeof active.entry_path !== "string" ||
      !isInside(consumerRoot, active.bundle_path) || !isInside(consumerRoot, active.entry_path) ||
      !existsSync(active.bundle_path) || !existsSync(active.entry_path))
    throw new Error("consumer-runtime-activation-not-local");
  const auditRoot = mkdtempSync(join(tmpdir(), "ut-canary-audit-"));
  const isolatedHome = join(auditRoot, "home");
  const binDir = join(auditRoot, "bin");
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const forbidden = parsed.removedPaths.map((path) => resolve(path));
  const accessLog = join(auditRoot, "forbidden-access.jsonl");
  const processLog = join(auditRoot, "child-processes.jsonl");
  const reviewProviders = createClosedReviewProviders(auditRoot, evidence.consumer_head);
  const auditModule = join(auditRoot, "audit-forbidden.mjs");
  writeFileSync(auditModule, makeAccessAuditModule(forbidden, accessLog, {
    path: processLog, providerCommands: {
      claude: reviewProviders.claudeCommand, codexProbe: reviewProviders.codexProbeCommand,
      commandProcessor: process.env.ComSpec,
    },
  }), "utf8");
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const pathEntries = [binDir, dirname(process.execPath),
    ...(process.env.PATH ?? "").split(pathSeparator).filter((path) =>
      path && !forbidden.some((removed) => isInside(removed, resolve(path)))),
  ];
  const env = {
    PATH: pathEntries.join(pathSeparator),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(auditRoot, "appdata"),
    LOCALAPPDATA: join(auditRoot, "localappdata"),
    CODEX_HOME: join(auditRoot, "codex-home"),
    UT_TDD_SKIP_UPDATE_CHECK: "1",
    NODE_OPTIONS: `--import=${pathToFileURL(auditModule).href}`,
    UT_TDD_CANARY_ACCESS_LOG: accessLog,
    UT_TDD_CLAUDE_BIN: reviewProviders.claudeCommand,
    UT_TDD_CODEX_BIN: reviewProviders.codexProbeCommand,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    ComSpec: process.env.ComSpec,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const transcript = [];
  const runCli = (label, cliArgs, { status = 0 } = {}) => {
    const child = run(process.execPath, [wrapper, ...cliArgs], {
      cwd: alternateCwd,
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    transcript.push({ label, argv: cliArgs, exit_code: child.status, output });
    if (child.error || child.status !== status)
      throw new Error(`smoke-command-failed:${label}:${child.error?.message ?? child.status}:${output.slice(-2000)}`);
    return { child, output };
  };
  try {
    runCli("doctor-setup-smoke", ["doctor", "--setup-smoke"]);
    runCli("doctor-consumer-profile", ["doctor", "--profile", "consumer-setup-smoke"]);
    const authoringInput = readFileSync(join(consumerRoot, "canary-plan-draft.json"));
    if (`sha256:${createHash("sha256").update(authoringInput).digest("hex")}` !== evidence.authoring_input_sha256)
      throw new Error("consumer-authoring-input-drift");
    runCli("plan-authoring", ["plan", "draft", "--manifest", join(consumerRoot, "canary-plan-draft.json")]);
    runCli("plan-lint", ["plan", "lint"]);
    runCli("db-rebuild", ["db", "rebuild", "--json"]);
    if (!existsSync(join(consumerRoot, ".ut-tdd", "harness.db")))
      throw new Error("consumer-local-db-missing");
    env.PATH = `${reviewProviders.ghBin}${pathSeparator}${env.PATH}`;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=${pathToFileURL(reviewProviders.ghLoader).href}`;
    env.UT_TDD_CLAUDE_BIN = reviewProviders.claudeCommand;
    env.CANARY_CLAUDE_MARKER = reviewProviders.claudeMarker;
    const memory = runCli("memory-add", ["memory", "add", "--title", "Canary 418 review task",
      "--kind", "feedback", "--body", "Review the isolated canary consumer fixture.",
      "--tags", "canary,review", "--operation-id", "canary-418-memory", "--receipt-json"]);
    const memoryReceipt = JSON.parse(memory.child.stdout.trim().split(/\r?\n/).at(-1));
    if (memoryReceipt.exit_code !== 0 || !memoryReceipt.memory_id?.startsWith("memory:feedback:") ||
        !memoryReceipt.source_path?.startsWith(".ut-tdd/memory/"))
      throw new Error("canary-memory-registration-invalid");
    const dispatch = runCli("review-request", ["review", "live-dispatch",
      "--memory-id", memoryReceipt.memory_id, "--memory-path", memoryReceipt.source_path,
      "--pr", "418", "--head", evidence.consumer_head,
      "--revision", "canary-418-review", "--author-family", "codex"], { status: 1 });
    if (dispatch.child.stdout.trim() !== "review live-dispatch: no_live_claude_workspace")
      throw new Error(`canary-review-dispatch-not-canonical-pending:${dispatch.output.slice(-2000)}`);
    const requestDir = join(consumerRoot, ".ut-tdd", "review", "requests");
    const requestFiles = readdirSync(requestDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (requestFiles.length !== 1) throw new Error("canary-review-request-not-unique");
    const requestDigest = requestFiles[0].slice(0, -5);
    const request = JSON.parse(readFileSync(join(requestDir, requestFiles[0]), "utf8"));
    if (request.pr !== 418 || request.exactHead !== evidence.consumer_head ||
        request.memoryId !== memoryReceipt.memory_id || request.authorFamily !== "codex" ||
        !/^rv1-[a-f0-9]{64}$/.test(request.reviewRevision))
      throw new Error("canary-review-request-identity-invalid");
    const pending = runCli("pr-merge-gate-pending", ["pr", "merge", "--pr", "418", "--json"], { status: 1 });
    const pendingDecision = JSON.parse(pending.child.stdout);
    if (pendingDecision.ok !== false || pendingDecision.decision !== "deny" ||
        pendingDecision.headSha !== evidence.consumer_head ||
        !/pending_request_for_head|verdict_missing/.test(pendingDecision.reason))
      throw new Error("canary-review-pending-gate-not-denied");
    const envelope = writeReviewEnvelope(consumerRoot, requestDigest, request, memoryReceipt.source_path);
    runCli("review-receipt", ["review", "live-consume", "--envelope", envelope, "--json"]);
    const receiptPath = join(consumerRoot, ".ut-tdd", "review", "receipts", `${requestDigest}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.memoryId !== memoryReceipt.memory_id || receipt.pr !== 418 ||
        receipt.head !== evidence.consumer_head || receipt.reviewRevision !== request.reviewRevision ||
        receipt.reviewerFamily !== "claude" || receipt.kind !== "verdict" ||
        receipt.verdict !== "PASS" || !Array.isArray(receipt.blockingFindings) ||
        receipt.blockingFindings.length !== 0 || !existsSync(reviewProviders.claudeMarker))
      throw new Error("canary-review-receipt-invalid");
    const merge = runCli("pr-merge-gate-closed-stub", ["pr", "merge", "--pr", "418", "--json"]);
    const mergeDecision = JSON.parse(merge.child.stdout);
    if (mergeDecision.ok !== true || mergeDecision.decision !== "merge" ||
        mergeDecision.headSha !== evidence.consumer_head || mergeDecision.verdict !== "PASS" ||
        mergeDecision.reason !== "merge_ready")
      throw new Error("canary-review-merge-gate-not-ready");
    const ghCalls = readFileSync(reviewProviders.ghTrace, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    if (!ghCalls.some((call) => call.join("\0") === ["pr", "merge", "418", "--merge",
      "--match-head-commit", evidence.consumer_head].join("\0")))
      throw new Error("canary-closed-gh-merge-not-observed");
    verifyRegisteredHooks(consumerRoot, env, run, transcript);
    const leakedReferences = findForbiddenReferences(consumerRoot, forbidden);
    if (leakedReferences.length) throw new Error(`forbidden-path-reference-observed:${leakedReferences[0]}`);
    const childProcesses = existsSync(processLog)
      ? readFileSync(processLog, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)
      : [];
    if (childProcesses.some((entry) => entry.allowed !== true))
      throw new Error("unapproved-child-process-observed");
    if (existsSync(accessLog) && readFileSync(accessLog, "utf8").trim())
      throw new Error(`forbidden-path-access-observed:${readFileSync(accessLog, "utf8").trim()}`);
    const after = {
      ...evidence,
      phase: "verified-clean-restart-smoke",
      verified_at: now(),
      removed_paths: forbidden,
      alternate_cwd: alternateCwd,
      smoke_transcript: transcript,
      child_process_trace: childProcesses,
      bun_invocation_trace_count: 0,
      forbidden_path_access_count: 0,
      forbidden_path_reference_count: 0,
      closed_review_stub: true,
      review_request_digest: requestDigest,
      review_receipt_path: relative(consumerRoot, receiptPath),
      status: "pack-only-smoke-complete-awaiting-independent-review",
    };
    writeFileSync(evidencePath, `${JSON.stringify(after, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, evidence: evidencePath, smoke_commands: transcript.length })}\n`);
  } finally {
    rmSync(auditRoot, { recursive: true, force: true });
  }
}

export function findForbiddenReferences(root, forbiddenPaths) {
  const needles = forbiddenPaths.map((path) => path.replaceAll("\\", "/").toLowerCase());
  const findings = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`consumer-symlink-unverified:${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        if (bytes.includes(0)) continue;
        const content = bytes.toString("utf8").replaceAll(/\\+/g, "/").toLowerCase();
        for (const needle of needles)
          if (content.includes(needle)) findings.push(`${path}:${needle}`);
      }
    }
  };
  visit(root);
  return findings;
}

function isInside(root, path) {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(offset));
}

/** Bind the restart proof to the exact installed consumer and removed Release directory. */
export function verifyInstallEvidence(evidence, consumerRoot, removedPaths, expectedTag = CANARY_TAG) {
  if (expectedTag !== CANARY_TAG && expectedTag !== AGENT_E2E_TAG)
    throw new Error("install-evidence-not-verifiable");
  if (evidence?.schema_version !== "ut-tdd.pack-canary-acceptance/v1" ||
      evidence.phase !== "installed-awaiting-clean-restart" || evidence.setup_exit_code !== 0 ||
      evidence.tag !== expectedTag || evidence.consumer_root !== consumerRoot ||
      typeof evidence.release_directory !== "string" || !isAbsolute(evidence.release_directory) ||
      typeof evidence.consumer_head !== "string" || !commitPattern.test(evidence.consumer_head))
    throw new Error("install-evidence-not-verifiable");
  const removed = removedPaths.map((path) => resolve(path));
  if (!removed.includes(evidence.release_directory) || new Set(removed).size !== removed.length ||
      removed.some((path) => isInside(consumerRoot, path)))
    throw new Error("verify-removed-paths-not-bound-to-install");
}

export function createConsumerPlan(consumerRoot, source) {
  if (typeof source !== "string") throw new Error("consumer-plan-template-invalid");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("consumer-plan-template-invalid");
  let frontmatter = match[1];
  const replaceScalar = (key, value) => {
    const pattern = new RegExp(`^${key}:.*$`, "m");
    if (!pattern.test(frontmatter)) throw new Error(`consumer-plan-template-missing:${key}`);
    frontmatter = frontmatter.replace(pattern, `${key}: ${value}`);
  };
  replaceScalar("plan_id", "PLAN-L2-999-canary-authoring");
  replaceScalar("title", '"Canary consumer の設計起票"');
  replaceScalar("drive", "agent");
  replaceScalar("created", "2026-09-30");
  replaceScalar("owner", '"Canary consumer"');
  const generatesStart = frontmatter.indexOf("\ngenerates:\n");
  const dependenciesStart = frontmatter.indexOf("\ndependencies:\n", generatesStart);
  const relatedDocsStart = frontmatter.indexOf("\nrelated_docs:\n", dependenciesStart);
  if (generatesStart < 0 || dependenciesStart < 0 || relatedDocsStart < 0)
    throw new Error("consumer-plan-template-structure-invalid");
  frontmatter = `${frontmatter.slice(0, generatesStart)}\ngenerates: []${frontmatter.slice(dependenciesStart, relatedDocsStart)}\nrelated_docs: []\nroute_signal: forward\nroute_mode: forward\nsub_doc: screen-list`;
  const body = match[2].replaceAll(
    "(本 PLAN でどの範囲の設計を凍結するかを 1-2 段落で記述)",
    "配布された PLAN テンプレートから consumer 固有の draft を正規 CLI で起票する。",
  );
  const planPath = "docs/plans/PLAN-L2-999-canary-authoring.md";
  mkdirSync(join(consumerRoot, "docs", "plans"), { recursive: true });
  mkdirSync(join(consumerRoot, "docs", "governance"), { recursive: true });
  writeFileSync(join(consumerRoot, "docs", "governance", "plan-admission-receipts.json"),
    JSON.stringify({ schema_version: "ut-tdd.plan-admission-receipts/v1", records: [] }), "utf8");
  writeFileSync(join(consumerRoot, "canary-plan-draft.json"), JSON.stringify({
    version: 2,
    command_id: "canary:plan-authoring",
    plan_id: "PLAN-L2-999-canary-authoring",
    recorded_at: "2026-09-30T00:00:00.000Z",
    admission: { route_signal: "forward", route_mode: "forward", kind: "design", layer: "L2", drive: "agent", branch: "work/forward-canary", status: "draft", sub_doc: "screen-list" },
    source: { path: planPath, content: `---\n${frontmatter}\n---\n${body}` },
    projection: { path: "docs/governance/plan-admission-receipts.json" },
  }), "utf8");
}

export function makeAccessAuditModule(forbiddenPaths, accessLog, processLog) {
  const settings = typeof processLog === "string" ? { path: processLog } : processLog;
  return `import fs from "node:fs";\nimport cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\nimport path from "node:path";\nconst blocked=${JSON.stringify(forbiddenPaths.map((item) => item.toLowerCase()))};\nconst log=${JSON.stringify(accessLog)};\nconst processLog=${JSON.stringify(settings.path)};\nconst allowed=new Set(["node","node.exe","git","git.exe","gh","gh.exe","claude","claude.exe"]);\nconst providers=${JSON.stringify(settings.providerCommands ?? {})};\nconst closedShim=(api,command,argv,options)=>{if(api!=="spawnSync" || options?.shell!==false || !Array.isArray(argv))return false;if(command===providers.codexProbe)return argv.length===1 && argv[0]==="--version";if(typeof providers.commandProcessor!=="string" || String(command).toLowerCase()!==providers.commandProcessor.toLowerCase() || argv.length!==4 || argv.slice(0,3).join("|")!=="/d|/s|/c" || typeof argv[3]!=="string")return false;const inner=argv[3].slice(1,-1);const tokens=[...inner.matchAll(/"([^"]*)"/g)].map(match=>match[1]);return argv[3]=== '"'+inner+'"' && tokens.length>=2 && tokens[0]===providers.claude && tokens.map(token=>'"'+token+'"').join(" ")===inner && tokens.every(token=>!/[<>!%&|^\\r\\n]/.test(token));};\nconst hit=(value)=>{if(typeof value!=="string" && !Buffer.isBuffer(value)) return false; const p=path.resolve(String(value)).toLowerCase(); return blocked.some((b)=>p===b || p.startsWith(b+path.sep));};\nconst deny=(api)=>function(value,...args){if(hit(value)){fs.appendFileSync(log,JSON.stringify({api,path:String(value)})+"\\n"); const e=new Error("forbidden removed path access"); e.code="ENOENT"; throw e;} return api.call(this,value,...args);};\nfor(const key of ["access","accessSync","existsSync","lstatSync","open","openSync","readFile","readFileSync","realpath","realpathSync","stat","statSync"]) if(typeof fs[key]==="function"){const original=fs[key];const guarded=deny(original);if(typeof original.native==="function")guarded.native=deny(original.native);fs[key]=guarded;}\nfor(const key of ["spawn","spawnSync","execFile","execFileSync","exec","execSync","fork"]){const original=cp[key];cp[key]=function(command,...args){const name=path.basename(String(command)).toLowerCase();const ok=key!=="exec" && key!=="execSync" && (allowed.has(name) || closedShim(key,command,args[0],args[1]));fs.appendFileSync(processLog,JSON.stringify({api:key,command:String(command),args:Array.isArray(args[0])?args[0]:[],allowed:ok})+"\\n");if(!ok)throw new Error("unapproved child process");return original.call(this,command,...args);};}\nsyncBuiltinESMExports();\n`;
}

export function createClosedReviewProviders(auditRoot, head) {
  if (!commitPattern.test(head)) throw new Error("consumer-review-head-invalid");
  const ghBin = join(auditRoot, "review-bin");
  mkdirSync(ghBin, { recursive: true });
  const ghExecutable = join(ghBin, process.platform === "win32" ? "gh.exe" : "gh");
  copyFileSync(process.execPath, ghExecutable);
  if (process.platform !== "win32") chmodSync(ghExecutable, 0o755);
  const codexProbeCommand = join(ghBin, process.platform === "win32" ? "codex.exe" : "codex");
  copyFileSync(process.execPath, codexProbeCommand);
  if (process.platform !== "win32") chmodSync(codexProbeCommand, 0o755);
  const ghTrace = join(auditRoot, "closed-gh-argv.jsonl");
  const ghLoader = join(auditRoot, "closed-gh.mjs");
  writeFileSync(ghLoader, `import fs from "node:fs";
import path from "node:path";
const executable=path.basename(process.execPath).toLowerCase();
if(executable==="gh" || executable==="gh.exe"){
  const argv=process.argv.slice(1);
  const trace=${JSON.stringify(ghTrace)};
  const head=${JSON.stringify(head)};
  if(argv[0]===path.resolve(process.cwd(),"pr"))argv[0]="pr";
  const record=(response="",code=0)=>{fs.appendFileSync(trace,JSON.stringify(argv)+"\\n");if(response)fs.writeSync(1,response);process.exit(code);};
  const exact=(...expected)=>argv.length===expected.length && expected.every((v,i)=>argv[i]===v);
  if(exact("pr","view","418","--json","headRefOid","--jq",".headRefOid"))record(head+"\\n");
  if(exact("pr","view","418","--json","headRefOid,state,statusCheckRollup"))record(JSON.stringify({headRefOid:head,state:"OPEN",statusCheckRollup:[{conclusion:"SUCCESS"}]})+"\\n");
  if(argv.length===5 && argv[0]==="pr" && argv[1]==="comment" && argv[2]==="418" && argv[3]==="--body" && new RegExp("^PR #418 exact HEAD "+head+" のcanonical review receipt。\\\\nverdict=PASS blocking=0\\\\nreviewRevision=rv1-[a-f0-9]{64}\\\\nreviewerFamily=claude\\\\nreceiptDigest=[a-f0-9]{64}$").test(argv[4]))record();
  if(exact("pr","merge","418","--merge","--match-head-commit",head))record();
  record(JSON.stringify({denied:true,argv})+"\\n",2);
}
`, "utf8");
  const claudeHelper = join(auditRoot, "closed-claude-provider.cjs");
  const claudeMarker = join(auditRoot, "closed-claude-invoked.log");
  writeFileSync(claudeHelper, `const fs=require("node:fs");
let prompt="";process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{prompt+=chunk;});
process.stdin.on("end",()=>{
  fs.appendFileSync(process.env.CANARY_CLAUDE_MARKER,"invoked\\n");
  const fields=["schema_version","request_digest","attempt","pr","exact_head","review_revision","reviewer_provider","reviewer_model","invocation_nonce"].map(key=>{
    const match=prompt.match(new RegExp("^"+key+":\\\\s*(.*)$","m"));
    if(!match || !match[1].trim())process.exit(2);
    return key+": "+match[1].trim();
  }).join("\\n");
  const verdictFile=process.env.UT_TDD_REVIEW_VERDICT_FILE;
  if(!verdictFile)process.exit(2);
  fs.writeFileSync(verdictFile,fields+"\\nVERDICT: PASS\\n","utf8");
  process.stdout.write("VERDICT: PASS\\n");
});
`, "utf8");
  const claudeCommand = join(ghBin, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFileSync(claudeCommand, process.platform === "win32"
    ? `@echo off\r\nif "%~1"=="--version" (echo claude 0.0.0-canary& exit /b 0)\r\nnode "${claudeHelper}"\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-canary"; exit 0; fi\nexec node "${claudeHelper}"\n`,
  process.platform === "win32" ? "utf8" : { encoding: "utf8", mode: 0o755 });
  return { ghBin, ghTrace, ghLoader, claudeCommand, claudeMarker, codexProbeCommand };
}

function writeReviewEnvelope(consumerRoot, requestDigest, request, memoryPath) {
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new Error("canary-review-digest-invalid");
  const envelopePath = join(consumerRoot, ".ut-tdd", "review", "canary-review-envelope.json");
  const envelope = {
    schemaVersion: "ut-tdd.claude-inbox/v3", purpose: "review",
    id: `${request.memoryId}:canary-review`, memoryId: request.memoryId,
    body: "Consume the canonical canary review request.", originRuntime: "codex",
    operationId: `canary-review-${requestDigest.slice(0, 16)}`,
    targetWorkspaceId: "f".repeat(64), createdAt: request.requestedAt,
    requestDigest, requestPath: `.ut-tdd/review/requests/${requestDigest}.json`,
    memoryPath, pr: request.pr, exactHead: request.exactHead,
    reviewRevision: request.reviewRevision, authorFamily: request.authorFamily,
  };
  writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
  return envelopePath;
}

export function verifyRegisteredHooks(consumerRoot, env, run, transcript) {
  const claudeSettings = JSON.parse(readFileSync(join(consumerRoot, ".claude", "settings.json"), "utf8"));
  const codexSettings = JSON.parse(readFileSync(join(consumerRoot, ".codex", "hooks.json"), "utf8"));
  const claude = claudeSettings.hooks?.PreToolUse?.flatMap((item) => item.hooks ?? [])
    .find((hook) => `${hook.command} ${(hook.args ?? []).join(" ")}`.includes("work-guard"));
  const codex = codexSettings.hooks?.PreToolUse?.flatMap((item) => item.hooks ?? [])
    .find((hook) => hook.command?.includes("work-guard"));
  if (!claude || !codex) throw new Error("canary-registered-work-guard-missing");
  const runHook = (provider, registration, payload, expected) => {
    const options = { cwd: consumerRoot, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: consumerRoot },
      input: JSON.stringify(payload), windowsHide: true, timeout: 30_000 };
    const child = provider === "claude"
      ? run(registration.command, registration.args ?? [], options)
      : process.platform === "win32"
        ? run("pwsh", ["-NoProfile", "-Command",
          `$global:PSNativeCommandUseErrorActionPreference = $false; ${registration.command}; exit $LASTEXITCODE`], options)
        : run("sh", ["-c", registration.command], options);
    transcript.push({ label: `hook-${provider}-${expected === 0 ? "allow" : "deny"}`,
      exit_code: child.status, output: `${child.stdout ?? ""}${child.stderr ?? ""}` });
    if (child.error || child.status !== expected ||
        (expected === 2 && !`${child.stdout ?? ""}${child.stderr ?? ""}`.includes("[ut-tdd-work-guard] BLOCK:")))
      throw new Error(`canary-registered-hook-failed:${provider}:${child.error?.message ?? child.status}`);
  };
  const normal = { session_id: "canary-normal", tool_name: "Edit",
    tool_input: { file_path: "README.md" } };
  const forbiddenPath = join(consumerRoot, "foreign-uncommitted.ts");
  writeFileSync(forbiddenPath, "export const foreign = true;\n", { flag: "wx" });
  const forbidden = { session_id: "canary-forbidden", tool_name: "Edit",
    tool_input: { file_path: "foreign-uncommitted.ts" } };
  for (const [provider, registration] of [["claude", claude], ["codex", codex]]) {
    runHook(provider, registration, normal, 0);
    runHook(provider, registration, forbidden, 2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
