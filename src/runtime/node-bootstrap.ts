import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
export const REVIEWED_NODE_VERSION = "v24.13.0";
export const REVIEWED_NPM_VERSION = "11.6.2";
export const NODE_GENERATIONS = "dist/node-generations";
export const NODE_LEASE = "dist/node-publish.lock";
const HEX = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;

export interface ToolIdentity {
  path: string;
  version: string;
  sha256: string;
}
export interface ExternalDependencyIdentity {
  package_name: string;
  package_version: string;
  package_json_path: string;
  package_json_sha256: string;
  bundle_files: Array<{ path: string; sha256: string }>;
}
export interface NodeBootstrapReceipt {
  schema_version: 2;
  generation_id: string;
  subject_revision: string;
  runtime: "node";
  node: ToolIdentity;
  npm: { cli_path: string; version: string; sha256: string };
  toolchain_provenance_sha256: string;
  package_lock_sha256: string;
  tsconfig_node: { path: string; sha256: string };
  builder: { path: string; policy: "compiled-esm-only"; sha256: string };
  compiled_cli: { path: string; sha256: string; local_version: string };
  source_graph_sha256: string;
  source_files: Array<{ path: string; sha256: string }>;
  external_dependencies: ExternalDependencyIdentity[];
  external_dependency_closure_sha256: string;
  receipt_digest: string;
}
export interface NodeGeneration {
  nodePath: string;
  compiledCliPath: string;
  generationPath: string;
  receipt: Readonly<NodeBootstrapReceipt>;
}
export interface NodeInvocation {
  command: string;
  args: string[];
  options: { shell: false; windowsHide: true };
}
export interface NodeGenerationBuildInput {
  readonly repoRoot?: string;
  /** Optional isolated publication root used by callers that need separate build output. */
  readonly outputRoot?: string;
  readonly candidateRevision: string;
  readonly nodePath?: string;
  readonly npmCliPath?: string;
  readonly compile?: (outfile: string, root: string) => Promise<BuildMetadata>;
  readonly fault?: (barrier: string) => void;
}
interface BuildMetadata {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>;
}
export class NodeBootstrapError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "NodeBootstrapError";
    this.code = code;
  }
}

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const sha256 = hash;
const hashFile = (path: string): string => hash(readFileSync(path));
const slash = (path: string): string => path.split(sep).join("/");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function revision(value: string): string {
  if (!REVISION.test(value))
    throw new NodeBootstrapError("node-bootstrap-subject-revision-invalid");
  return value;
}
function contained(root: string, value: string, code: string): string {
  if (isAbsolute(value)) throw new NodeBootstrapError(code);
  const rootReal = realpathSync(root);
  const candidate = resolve(root, value);
  const lexical = relative(rootReal, candidate);
  if (!lexical || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical))
    throw new NodeBootstrapError(code);
  const real = realpathSync(candidate);
  const realRelative = relative(rootReal, real);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative))
    throw new NodeBootstrapError(code);
  return real;
}
function digest(value: unknown, code = "node-bootstrap-receipt-invalid"): string {
  if (typeof value !== "string" || !HEX.test(value)) throw new NodeBootstrapError(code);
  return value;
}
function assertBundleFile(value: unknown): asserts value is { path: string; sha256: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { path?: unknown }).path !== "string" ||
    typeof (value as { sha256?: unknown }).sha256 !== "string" ||
    !HEX.test((value as { sha256: string }).sha256)
  )
    throw new NodeBootstrapError("node-bootstrap-dependency-invalid");
}
function assertExternalDependency(value: unknown): asserts value is ExternalDependencyIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { package_name?: unknown }).package_name !== "string" ||
    typeof (value as { package_version?: unknown }).package_version !== "string" ||
    typeof (value as { package_json_path?: unknown }).package_json_path !== "string" ||
    typeof (value as { package_json_sha256?: unknown }).package_json_sha256 !== "string" ||
    !HEX.test((value as { package_json_sha256: string }).package_json_sha256) ||
    !Array.isArray((value as { bundle_files?: unknown }).bundle_files)
  )
    throw new NodeBootstrapError("node-bootstrap-dependency-invalid");
  for (const file of (value as { bundle_files: unknown[] }).bundle_files) assertBundleFile(file);
}
function assertToolchainProvenance(path: string, nodeDigest: string, npmDigest: string): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new NodeBootstrapError("node-bootstrap-provenance-invalid");
  }
  const provenance = value as {
    schema_version?: unknown;
    runtime?: unknown;
    node?: { version?: unknown; executable_sha256?: unknown };
    npm?: { version?: unknown; cli_sha256?: unknown };
    build?: { policy?: unknown };
    platforms?: Record<string, { node_executable_sha256?: unknown; npm_cli_sha256?: unknown }>;
  };
  const platform = `${process.platform}-${process.arch}`;
  const tuple = provenance.platforms?.[platform];
  if (
    provenance.schema_version !== 1 ||
    provenance.runtime !== "node" ||
    provenance.node?.version !== REVIEWED_NODE_VERSION ||
    tuple?.node_executable_sha256 !== nodeDigest ||
    provenance.npm?.version !== REVIEWED_NPM_VERSION ||
    tuple?.npm_cli_sha256 !== npmDigest ||
    provenance.build?.policy !== "compiled-esm-only"
  )
    throw new NodeBootstrapError("node-bootstrap-provenance-invalid");
}
export function assertReviewedExternalImports(imports: readonly string[]): void {
  const builtins = new Set([...builtinModules, ...builtinModules.map((item) => `node:${item}`)]);
  const allowed = new Set(["source-map-support"]);
  const forbidden = [
    ...new Set(imports.filter((item) => !builtins.has(item) && !allowed.has(item))),
  ].sort();
  if (forbidden.length)
    throw new NodeBootstrapError(`node-bootstrap-external-dependency:${forbidden.join(",")}`);
}
function git(root: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new NodeBootstrapError("node-bootstrap-candidate-not-git-object");
  }
}
function assertCandidate(root: string, candidate: string): void {
  git(root, ["rev-parse", "--verify", `${candidate}^{commit}`]);
  if (git(root, ["rev-parse", "HEAD"]) !== candidate)
    throw new NodeBootstrapError("node-bootstrap-candidate-head-mismatch");
  try {
    execFileSync("git", ["-C", root, "diff", "--quiet", "--ignore-submodules", "HEAD", "--"], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-C", root, "diff", "--cached", "--quiet", "--ignore-submodules", "HEAD", "--"],
      { stdio: "ignore" },
    );
  } catch {
    throw new NodeBootstrapError("node-bootstrap-source-dirty");
  }
}
function parseReceiptValue(value: unknown): NodeBootstrapReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NodeBootstrapError("node-bootstrap-receipt-invalid");
  const receipt = value as Record<string, unknown>;
  const fields = [
    "schema_version",
    "generation_id",
    "subject_revision",
    "runtime",
    "node",
    "npm",
    "toolchain_provenance_sha256",
    "package_lock_sha256",
    "tsconfig_node",
    "builder",
    "compiled_cli",
    "source_graph_sha256",
    "source_files",
    "external_dependencies",
    "external_dependency_closure_sha256",
    "receipt_digest",
  ];
  if (
    Object.keys(receipt).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in receipt))
  )
    throw new NodeBootstrapError("node-bootstrap-receipt-invalid");
  if (
    receipt.schema_version !== 2 ||
    receipt.runtime !== "node" ||
    typeof receipt.generation_id !== "string" ||
    !/^[a-z0-9._-]+$/.test(receipt.generation_id) ||
    typeof receipt.subject_revision !== "string" ||
    !REVISION.test(receipt.subject_revision) ||
    !Array.isArray(receipt.source_files) ||
    !Array.isArray(receipt.external_dependencies)
  )
    throw new NodeBootstrapError("node-bootstrap-receipt-invalid");
  for (const dependency of receipt.external_dependencies) assertExternalDependency(dependency);
  for (const key of [
    "toolchain_provenance_sha256",
    "package_lock_sha256",
    "source_graph_sha256",
    "external_dependency_closure_sha256",
    "receipt_digest",
  ])
    digest(receipt[key]);
  const { receipt_digest: _self, ...unsigned } = receipt;
  if (hash(canonical(unsigned)) !== receipt.receipt_digest)
    throw new NodeBootstrapError("node-bootstrap-receipt-digest-mismatch");
  return receipt as unknown as NodeBootstrapReceipt;
}

/**
 * Parse and authenticate the sealed receipt bytes without consulting the source
 * checkout.  Consumer installation uses this boundary after the producer has
 * supplied the receipt as an input artifact.
 */
export function parseNodeBootstrapReceiptBytes(bytes: Uint8Array): NodeBootstrapReceipt {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new NodeBootstrapError("node-bootstrap-receipt-invalid");
  }
  return parseReceiptValue(value);
}

function parseReceipt(path: string): NodeBootstrapReceipt {
  try {
    return parseReceiptValue(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof NodeBootstrapError) throw error;
    throw new NodeBootstrapError("node-bootstrap-receipt-invalid");
  }
}
function verifyToolchain(receipt: NodeBootstrapReceipt): string {
  if (receipt.node.version !== REVIEWED_NODE_VERSION)
    throw new NodeBootstrapError("node-bootstrap-node-version-mismatch");
  if (receipt.npm.version !== REVIEWED_NPM_VERSION)
    throw new NodeBootstrapError("node-bootstrap-npm-version-mismatch");
  let nodePath: string;
  let npmPath: string;
  try {
    nodePath = realpathSync(receipt.node.path);
    npmPath = realpathSync(receipt.npm.cli_path);
  } catch {
    throw new NodeBootstrapError("node-bootstrap-toolchain-missing");
  }
  if (!/^(node|node\.exe)$/i.test(basename(nodePath)))
    throw new NodeBootstrapError("node-bootstrap-runtime-not-node");
  if (hashFile(nodePath) !== receipt.node.sha256)
    throw new NodeBootstrapError("node-bootstrap-node-digest-mismatch");
  if (hashFile(npmPath) !== receipt.npm.sha256)
    throw new NodeBootstrapError("node-bootstrap-npm-digest-mismatch");
  let actual: string;
  try {
    actual = execFileSync(nodePath, [npmPath, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new NodeBootstrapError("node-bootstrap-npm-unexecutable");
  }
  if (actual !== REVIEWED_NPM_VERSION)
    throw new NodeBootstrapError("node-bootstrap-npm-version-mismatch");
  return nodePath;
}
export function verifyNodeGeneration(
  repoRoot: string,
  generationPath: string,
  expectedRevision: string,
): NodeGeneration {
  const expected = revision(expectedRevision);
  const receipt = parseReceipt(resolve(generationPath, "receipt.json"));
  if (receipt.subject_revision !== expected)
    throw new NodeBootstrapError("node-bootstrap-subject-revision-mismatch");
  const nodePath = verifyToolchain(receipt);
  const cli = contained(
    generationPath,
    receipt.compiled_cli.path,
    "node-bootstrap-cli-path-escape",
  );
  if (hashFile(cli) !== receipt.compiled_cli.sha256)
    throw new NodeBootstrapError("node-bootstrap-cli-digest-mismatch");
  const lock = contained(repoRoot, "package-lock.json", "node-bootstrap-lock-path-escape");
  if (hashFile(lock) !== receipt.package_lock_sha256)
    throw new NodeBootstrapError("node-bootstrap-lock-digest-mismatch");
  const packageJson = JSON.parse(
    readFileSync(contained(repoRoot, "package.json", "node-bootstrap-package-path-escape"), "utf8"),
  ) as { version?: unknown };
  if (packageJson.version !== receipt.compiled_cli.local_version)
    throw new NodeBootstrapError("node-bootstrap-local-version-mismatch");
  const builder = contained(repoRoot, receipt.builder.path, "node-bootstrap-builder-path-escape");
  if (
    receipt.builder.policy !== "compiled-esm-only" ||
    hashFile(builder) !== receipt.builder.sha256
  )
    throw new NodeBootstrapError("node-bootstrap-builder-digest-mismatch");
  const tsconfig = contained(
    repoRoot,
    receipt.tsconfig_node.path,
    "node-bootstrap-tsconfig-path-escape",
  );
  if (hashFile(tsconfig) !== receipt.tsconfig_node.sha256)
    throw new NodeBootstrapError("node-bootstrap-tsconfig-digest-mismatch");
  const provenance = contained(
    repoRoot,
    "docs/governance/node-toolchain-provenance.json",
    "node-bootstrap-provenance-path-escape",
  );
  if (hashFile(provenance) !== receipt.toolchain_provenance_sha256)
    throw new NodeBootstrapError("node-bootstrap-provenance-digest-mismatch");
  assertToolchainProvenance(provenance, receipt.node.sha256, receipt.npm.sha256);
  const sources = [...receipt.source_files].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(sources.map((item) => item.path)).size !== sources.length)
    throw new NodeBootstrapError("node-bootstrap-source-duplicate");
  for (const source of sources) {
    digest(source.sha256, "node-bootstrap-source-digest-invalid");
    if (
      hashFile(contained(repoRoot, source.path, "node-bootstrap-source-path-escape")) !==
      source.sha256
    )
      throw new NodeBootstrapError("node-bootstrap-source-digest-mismatch");
  }
  if (
    hash(sources.map((item) => `${item.path}\0${item.sha256}`).join("\n")) !==
    receipt.source_graph_sha256
  )
    throw new NodeBootstrapError("node-bootstrap-source-graph-mismatch");
  const deps = [...receipt.external_dependencies].sort((a, b) =>
    a.package_name.localeCompare(b.package_name),
  );
  if (new Set(deps.map((item) => item.package_name)).size !== deps.length)
    throw new NodeBootstrapError("node-bootstrap-dependency-duplicate");
  for (const dep of deps) {
    const p = contained(repoRoot, dep.package_json_path, "node-bootstrap-dependency-path-escape");
    if (hashFile(p) !== dep.package_json_sha256)
      throw new NodeBootstrapError("node-bootstrap-dependency-digest-mismatch");
    const identity = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown; version?: unknown };
    if (identity.name !== dep.package_name || identity.version !== dep.package_version)
      throw new NodeBootstrapError("node-bootstrap-dependency-identity-mismatch");
    const packageRoot = dirname(p);
    for (const file of dep.bundle_files) {
      const input = contained(repoRoot, file.path, "node-bootstrap-dependency-path-escape");
      const packageRelative = relative(packageRoot, input);
      if (
        !packageRelative ||
        packageRelative === ".." ||
        packageRelative.startsWith(`..${sep}`) ||
        isAbsolute(packageRelative)
      )
        throw new NodeBootstrapError("node-bootstrap-dependency-path-escape");
      if (hashFile(input) !== file.sha256)
        throw new NodeBootstrapError("node-bootstrap-dependency-digest-mismatch");
    }
  }
  if (
    hash(
      deps
        .flatMap((item) => [
          `${item.package_name}\0${item.package_version}\0${item.package_json_sha256}`,
          ...item.bundle_files
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((file) => `${file.path}\0${file.sha256}`),
        ])
        .join("\n"),
    ) !== receipt.external_dependency_closure_sha256
  )
    throw new NodeBootstrapError("node-bootstrap-dependency-closure-mismatch");
  return { nodePath, compiledCliPath: cli, generationPath, receipt: deepFreeze(receipt) };
}

function inputPath(
  root: string,
  input: string,
  code: string,
): { absolute: string; relative: string } {
  const absolute = resolve(root, input);
  const relativePath = slash(relative(root, absolute));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  )
    throw new NodeBootstrapError(code);
  return { absolute, relative: relativePath };
}
function isNodeModulesInput(path: string): boolean {
  return path.split("/").includes("node_modules");
}
function packageJsonForInput(root: string, input: string): string {
  let current = dirname(input);
  const rootReal = realpathSync(root);
  while (true) {
    const packageJson = resolve(current, "package.json");
    if (existsSync(packageJson)) return realpathSync(packageJson);
    if (current === rootReal) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new NodeBootstrapError("node-bootstrap-dependency-package-missing");
}
function externalImports(meta: BuildMetadata): string[] {
  return Object.values(meta.outputs ?? {}).flatMap((output) =>
    (output.imports ?? []).filter((item) => item.external).map((item) => item.path),
  );
}
function externalDependencies(root: string, meta: BuildMetadata): ExternalDependencyIdentity[] {
  const byPackage = new Map<string, ExternalDependencyIdentity>();
  for (const input of Object.keys(meta.inputs ?? {})) {
    const resolvedInput = inputPath(root, input, "node-bootstrap-dependency-path-escape");
    if (!isNodeModulesInput(resolvedInput.relative)) continue;
    const packageJson = packageJsonForInput(root, resolvedInput.absolute);
    const packageJsonPath = slash(relative(root, packageJson));
    const identity = JSON.parse(readFileSync(packageJson, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof identity.name !== "string" || typeof identity.version !== "string")
      throw new NodeBootstrapError("node-bootstrap-dependency-invalid");
    const existing = byPackage.get(identity.name);
    const bundleFile = { path: resolvedInput.relative, sha256: hashFile(resolvedInput.absolute) };
    if (existing) {
      if (
        existing.package_json_path !== packageJsonPath ||
        existing.package_version !== identity.version
      )
        throw new NodeBootstrapError("node-bootstrap-dependency-identity-mismatch");
      if (!existing.bundle_files.some((file) => file.path === bundleFile.path))
        existing.bundle_files.push(bundleFile);
      continue;
    }
    byPackage.set(identity.name, {
      package_name: identity.name,
      package_version: identity.version,
      package_json_path: packageJsonPath,
      package_json_sha256: hashFile(packageJson),
      bundle_files: [bundleFile],
    });
  }
  return [...byPackage.values()]
    .map((dependency) => ({
      ...dependency,
      bundle_files: dependency.bundle_files.sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.package_name.localeCompare(b.package_name));
}
function dependencyClosure(dependencies: readonly ExternalDependencyIdentity[]): string {
  return hash(
    dependencies
      .flatMap((item) => [
        `${item.package_name}\0${item.package_version}\0${item.package_json_sha256}`,
        ...item.bundle_files.map((file) => `${file.path}\0${file.sha256}`),
      ])
      .join("\n"),
  );
}
function runAuthoritativeBuilder(input: {
  nodePath: string;
  builder: string;
  outfile: string;
  root: string;
}): BuildMetadata {
  const { nodePath, builder, outfile, root } = input;
  const metafile = `${outfile}.metafile.json`;
  try {
    execFileSync(nodePath, [builder, outfile, metafile], {
      cwd: root,
      env: { ...process.env, UT_TDD_REPO_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const metadata = JSON.parse(readFileSync(metafile, "utf8")) as BuildMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error("invalid builder metafile");
    return metadata;
  } catch {
    throw new NodeBootstrapError("node-bootstrap-builder-failed");
  } finally {
    rmSync(metafile, { force: true });
  }
}
function syncWrite(path: string, text: string): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function chmodTree(path: string): void {
  chmodSync(path, 0o555);
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (statSync(child).isDirectory()) chmodTree(child);
    else chmodSync(child, 0o444);
  }
}
export function createNodeInvocation(
  generation: NodeGeneration,
  args: readonly string[],
): NodeInvocation {
  return {
    command: generation.nodePath,
    args: [generation.compiledCliPath, ...args],
    options: { shell: false, windowsHide: true },
  };
}

export async function buildNodeGeneration(
  input: NodeGenerationBuildInput | string,
): Promise<NodeGeneration> {
  const request: NodeGenerationBuildInput =
    typeof input === "string" ? { candidateRevision: input } : input;
  const root = resolve(request.repoRoot ?? process.cwd());
  const candidate = revision(request.candidateRevision);
  assertCandidate(root, candidate);
  if (process.version !== REVIEWED_NODE_VERSION)
    throw new NodeBootstrapError("node-bootstrap-node-version-mismatch");
  const nodePath = realpathSync(request.nodePath ?? process.execPath);
  if (
    nodePath !== realpathSync(process.execPath) ||
    !/^(node|node\.exe)$/i.test(basename(nodePath))
  )
    throw new NodeBootstrapError("node-bootstrap-runtime-not-node");
  const npmCandidates =
    process.platform === "win32"
      ? [resolve(dirname(nodePath), "node_modules/npm/bin/npm-cli.js")]
      : [
          resolve(dirname(nodePath), "lib/node_modules/npm/bin/npm-cli.js"),
          resolve(dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js"),
        ];
  const expectedNpm =
    npmCandidates.find((candidatePath) => existsSync(candidatePath)) ?? npmCandidates[0];
  const npmPath = realpathSync(request.npmCliPath ?? expectedNpm);
  if (npmPath !== realpathSync(expectedNpm))
    throw new NodeBootstrapError("node-bootstrap-npm-path-invalid");
  const provenance = contained(
    root,
    "docs/governance/node-toolchain-provenance.json",
    "node-bootstrap-provenance-missing",
  );
  const lock = contained(root, "package-lock.json", "node-bootstrap-lock-missing");
  const tsconfig = contained(root, "tsconfig.node.json", "node-bootstrap-tsconfig-missing");
  const builder = contained(root, "scripts/build-node.mjs", "node-bootstrap-builder-missing");
  assertToolchainProvenance(provenance, hashFile(nodePath), hashFile(npmPath));
  const outputRoot = resolve(request.outputRoot ?? root);
  const generations = resolve(outputRoot, NODE_GENERATIONS);
  const lease = resolve(outputRoot, NODE_LEASE);
  mkdirSync(generations, { recursive: true });
  try {
    mkdirSync(lease, { recursive: false });
  } catch {
    throw new NodeBootstrapError("publish-lease-busy");
  }
  let crashed = false;
  const barrier = (name: string) => {
    try {
      request.fault?.(name);
    } catch (error) {
      crashed = true;
      throw error;
    }
  };
  const staging = resolve(generations, `.staging-${candidate}`);
  try {
    mkdirSync(staging, { recursive: false });
    const compiled = resolve(staging, "ut-tdd.mjs");
    const meta: BuildMetadata = request.compile
      ? await request.compile(compiled, root)
      : runAuthoritativeBuilder({ nodePath, builder, outfile: compiled, root });
    assertReviewedExternalImports(externalImports(meta));
    if (!existsSync(compiled) || statSync(compiled).size === 0)
      throw new NodeBootstrapError("node-bootstrap-compiled-cli-missing");
    const sourcePaths = Object.keys(meta.inputs ?? {})
      .map((path) => inputPath(root, path, "node-bootstrap-source-path-escape"))
      .filter(({ relative: relativePath }) => !isNodeModulesInput(relativePath))
      .map(({ absolute: source, relative: relativePath }) => {
        try {
          execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relativePath], {
            stdio: "ignore",
          });
        } catch {
          throw new NodeBootstrapError("node-bootstrap-source-untracked");
        }
        return source;
      });
    if (sourcePaths.length === 0) sourcePaths.push(resolve(root, "src/cli.ts"));
    const sources = sourcePaths
      .map((path) => ({ path: slash(relative(root, path)), sha256: hashFile(path) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const sourceGraph = hash(sources.map((item) => `${item.path}\0${item.sha256}`).join("\n"));
    const dependencies = externalDependencies(root, meta);
    const manifest = JSON.parse(
      readFileSync(contained(root, "package.json", "node-bootstrap-package-path-escape"), "utf8"),
    ) as { version?: string };
    const base = {
      schema_version: 2 as const,
      generation_id: "pending",
      subject_revision: candidate,
      runtime: "node" as const,
      node: { path: nodePath, version: process.version, sha256: hashFile(nodePath) },
      npm: { cli_path: npmPath, version: REVIEWED_NPM_VERSION, sha256: hashFile(npmPath) },
      toolchain_provenance_sha256: hashFile(provenance),
      package_lock_sha256: hashFile(lock),
      tsconfig_node: { path: "tsconfig.node.json", sha256: hashFile(tsconfig) },
      builder: {
        path: "scripts/build-node.mjs",
        policy: "compiled-esm-only" as const,
        sha256: hashFile(builder),
      },
      compiled_cli: {
        path: "ut-tdd.mjs",
        sha256: hashFile(compiled),
        local_version: manifest.version ?? "",
      },
      source_graph_sha256: sourceGraph,
      source_files: sources,
      external_dependencies: dependencies,
      external_dependency_closure_sha256: dependencyClosure(dependencies),
    };
    const generationId = `node-${hash(canonical(base)).slice(0, 32)}`;
    const unsigned = { ...base, generation_id: generationId };
    const receipt: NodeBootstrapReceipt = {
      ...unsigned,
      receipt_digest: hash(canonical(unsigned)),
    };
    syncWrite(resolve(staging, "receipt.json"), `${canonical(receipt)}\n`);
    barrier("generation-staged");
    const finalPath = resolve(generations, generationId);
    if (existsSync(finalPath)) throw new NodeBootstrapError("node-bootstrap-generation-exists");
    renameSync(staging, finalPath);
    chmodTree(finalPath);
    barrier("generation-published");
    const result = verifyNodeGeneration(root, finalPath, candidate);
    rmSync(lease, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!crashed) rmSync(lease, { recursive: true, force: true });
    throw error;
  }
}
