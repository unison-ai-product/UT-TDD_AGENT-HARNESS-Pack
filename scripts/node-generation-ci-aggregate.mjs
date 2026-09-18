import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { admitNodeGenerationAggregate } from "../src/lint/node-generation-ci-policy.ts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const root = resolve(required("NODE_GENERATION_EVIDENCE_DIR"));
const evidenceFileName = "node-generation-evidence.json";
const findEvidenceFiles = (directory) => {
  const matches = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && basename(path) === evidenceFileName) matches.push(path);
    }
  };
  visit(directory);
  return matches;
};
const readEvidence = (lane) => {
  const laneRoot = resolve(root, `node-generation-${lane}`);
  const matches = findEvidenceFiles(laneRoot);
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${evidenceFileName} for ${lane}, found ${matches.length}`);
  return JSON.parse(readFileSync(matches[0], "utf8"));
};
const result = admitNodeGenerationAggregate({
  evidence: [readEvidence("linux"), readEvidence("windows")],
  expected: {
    workflow_revision: required("GITHUB_SHA"),
    subject_revision: required("GITHUB_SHA"),
    run_id: required("GITHUB_RUN_ID"),
    run_attempt: Number(required("GITHUB_RUN_ATTEMPT")),
  },
});
if (!result.ok) throw new Error(`node-generation-aggregate-rejected:${result.reason}`);
console.log(JSON.stringify({ schema_version: "node-generation-aggregate.v1", ...result }));
