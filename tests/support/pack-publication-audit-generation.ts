import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type NodeGeneration,
  type NodeGenerationBuildInput,
  parseNodeBootstrapReceiptBytes,
  REVIEWED_NODE_VERSION,
  REVIEWED_NPM_VERSION,
} from "../../src/runtime/node-bootstrap.ts";

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

const receiptUnsigned = {
  schema_version: 2,
  generation_id: "node-fixture",
  subject_revision: "a".repeat(40),
  runtime: "node",
  node: { path: "C:/toolchain/node.exe", version: "v24.13.0", sha256: "c".repeat(64) },
  npm: { cli_path: "C:/toolchain/npm-cli.js", version: "11.6.2", sha256: "d".repeat(64) },
  toolchain_provenance_sha256: "e".repeat(64),
  package_lock_sha256: "f".repeat(64),
  tsconfig_node: { path: "tsconfig.node.json", sha256: "0".repeat(64) },
  builder: { path: "scripts/build-node.mjs", policy: "compiled-esm-only", sha256: "1".repeat(64) },
  compiled_cli: { path: "ut-tdd.mjs", sha256: "b".repeat(64), local_version: "0.0.0" },
  source_graph_sha256: "3".repeat(64),
  source_files: [],
  external_dependencies: [],
  external_dependency_closure_sha256: "4".repeat(64),
};

export function fakeGenerationBuilder(): (
  input: string | NodeGenerationBuildInput,
) => Promise<NodeGeneration> {
  return async (input) => {
    if (typeof input === "string" || !input.outputRoot)
      throw new Error("fixture generation input must be structured");
    const compiledBytes = Buffer.from("export default 'fixture runtime';\n", "utf8");
    const toolchainRoot = process.platform === "win32" ? "C:/toolchain" : "/opt/ut-tdd-toolchain";
    const unsigned = {
      ...receiptUnsigned,
      generation_id: "fixture-generation",
      subject_revision: input.candidateRevision,
      node: {
        ...receiptUnsigned.node,
        path: `${toolchainRoot}/node${process.platform === "win32" ? ".exe" : ""}`,
        version: REVIEWED_NODE_VERSION,
      },
      npm: {
        ...receiptUnsigned.npm,
        cli_path: `${toolchainRoot}/npm-cli.js`,
        version: REVIEWED_NPM_VERSION,
      },
      compiled_cli: {
        ...receiptUnsigned.compiled_cli,
        sha256: createHash("sha256").update(compiledBytes).digest("hex"),
      },
    };
    const generationPath = join(input.outputRoot, "fixture-generation");
    const compiledCliPath = join(generationPath, "ut-tdd.mjs");
    mkdirSync(generationPath, { recursive: true });
    writeFileSync(compiledCliPath, compiledBytes);
    const receiptBytes = Buffer.from(
      JSON.stringify({
        ...unsigned,
        receipt_digest: createHash("sha256").update(canonical(unsigned)).digest("hex"),
      }),
      "utf8",
    );
    writeFileSync(join(generationPath, "receipt.json"), receiptBytes);
    return {
      nodePath: unsigned.node.path,
      compiledCliPath,
      generationPath,
      receipt: parseNodeBootstrapReceiptBytes(receiptBytes),
    };
  };
}
