import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildNodeGeneration,
  createNodeInvocation,
} from "../src/runtime/node-bootstrap.ts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const subject = required("GITHUB_SHA");
const runId = required("GITHUB_RUN_ID");
const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
const workflowRevision = required("GITHUB_SHA");
const lane = required("NODE_GENERATION_LANE");
const evidenceFile = resolve(required("NODE_GENERATION_EVIDENCE_FILE"));
if (!/^[0-9a-f]{40}$/.test(subject) || !/^[0-9a-f]{40}$/.test(workflowRevision))
  throw new Error("GITHUB_SHA must be a 40-character lowercase Git revision");
if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) throw new Error("invalid GITHUB_RUN_ATTEMPT");
if (lane !== "linux" && lane !== "windows") throw new Error(`invalid NODE_GENERATION_LANE: ${lane}`);

const generation = await buildNodeGeneration({ candidateRevision: subject });
const invocation = createNodeInvocation(generation, ["status", "--json"]);
execFileSync(invocation.command, invocation.args, {
  cwd: process.cwd(),
  ...invocation.options,
  stdio: "ignore",
});

const evidence = {
  schema_version: "node-generation-ci.v1",
  lane,
  // F0b's sealed generation IDs contain OS-specific executable custody. This
  // CI generation ID is the common run-scoped identity joining both OS legs.
  generation_id: `node-ci-${subject}-${runId}-${runAttempt}`,
  sealed_generation_id: generation.receipt.generation_id,
  artifact_digest: `sha256:${generation.receipt.compiled_cli.sha256}`,
  subject_revision: subject,
  workflow_revision: workflowRevision,
  run_id: runId,
  run_attempt: runAttempt,
  conclusion: "success",
};
mkdirSync(dirname(evidenceFile), { recursive: true });
writeFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`, "utf8");
console.log(JSON.stringify(evidence));
