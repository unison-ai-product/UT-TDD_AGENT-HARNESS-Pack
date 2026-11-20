import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitTextTrimmed as git } from "../support/git.ts";
import {
  createCleanPack,
  createConsumerProject,
  fixtureRoots,
  removeFixtureTree,
  setupConsumerFromPack,
  writeConsumerRuntimeInput,
} from "../support/pack-consumer-runtime.ts";
import {
  createSmallAttestationInput,
  createVersionBInput,
  WORKTREE_RUNTIME_TAG_B,
  writeReleaseFromInput,
} from "./consumer-worktree-runtime-release-fixture.ts";

export {
  WORKTREE_RUNTIME_TAG,
  WORKTREE_RUNTIME_TAG_B,
} from "./consumer-worktree-runtime-release-fixture.ts";

const CLI = resolve("src/cli.ts");
const tempRoots: string[] = [];

export interface ConsumerWorktreeRuntimeFixture {
  readonly pack: string;
  readonly main: string;
  readonly linked: Readonly<Record<string, string>>;
  readonly release: string;
  readonly anchor: string;
  readonly releaseId: string;
  readonly cache: string;
  readonly releaseB: string;
  readonly anchorB: string;
  readonly releaseIdB: string;
  readonly cacheB: string;
  readonly versionBInput: string;
  readonly networkStub: string;
  readonly networkMarker: string;
}

export function runConsumerWorktreeCommand(
  cwd: string,
  args: readonly string[],
  options: {
    readonly sourceCli?: boolean;
    readonly input?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) {
  const entrypoint = options.sourceCli ? CLI : join(cwd, ".ut-tdd", "bin", "ut-tdd.mjs");
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: "",
      UT_TDD_PROJECT_DIR: "",
      UT_TDD_SKIP_UPDATE_CHECK: "1",
      ...options.env,
    },
  });
}

export function activeCompiledEsmPath(root: string): string {
  const pointerPath = join(root, ".ut-tdd", "runtime", "activation", "active.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { entry_path: string };
  return pointer.entry_path;
}

export function runtimeIdentity(root: string): Record<string, string> {
  const pointerPath = join(root, ".ut-tdd", "runtime", "activation", "active.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { bundle_path: string };
  const bundle = JSON.parse(
    readFileSync(join(pointer.bundle_path, "bundle-manifest.json"), "utf8"),
  ) as { identity: Record<string, string> };
  return bundle.identity;
}

export async function createConsumerWorktreeRuntimeFixture(
  extraLinkedIds: readonly string[] = [],
): Promise<ConsumerWorktreeRuntimeFixture> {
  const pack = createCleanPack();
  const main = createConsumerProject("fixture/consumer-worktree-runtime");
  const rawInputPath = await writeConsumerRuntimeInput(pack, main);
  const inputPath = join(main, "consumer-runtime-input-small.json");
  createSmallAttestationInput(rawInputPath, inputPath);
  const setup = setupConsumerFromPack(pack, main, inputPath);
  if (setup.status !== 0) throw new Error(`main runtime setup failed: ${setup.stderr}`);
  const release = join(main, "test-release");
  const releaseInfo = writeReleaseFromInput(inputPath, release);
  const versionBInput = join(main, "consumer-runtime-input-b.json");
  const versionB = createVersionBInput(inputPath, versionBInput);
  const releaseB = join(main, "test-release-b");
  const releaseInfoB = writeReleaseFromInput(versionB.inputPath, releaseB, WORKTREE_RUNTIME_TAG_B);
  const common = resolve(main, git(main, ["rev-parse", "--git-common-dir"]));
  const cacheKey = (releaseId: string): string => {
    if (!/^rel-sha256:[0-9a-f]{64}$/.test(releaseId))
      throw new Error("fixture release ID is not a canonical rel-sha256 identity");
    return releaseId.slice("rel-sha256:".length);
  };
  const cache = join(common, "ut-tdd", "runtime-cache", cacheKey(releaseInfo.releaseId));
  const cacheB = join(common, "ut-tdd", "runtime-cache", cacheKey(releaseInfoB.releaseId));
  for (const [source, target] of [
    [release, cache],
    [releaseB, cacheB],
  ]) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) cpSync(join(source, name), join(target, name));
  }

  const linked: Record<string, string> = {};
  const worktreeBase = mkdtempSync(join(tmpdir(), "ut-tdd-cwtrt-linked-"));
  tempRoots.push(worktreeBase);
  for (const id of [
    "001",
    "002",
    "002-empty",
    "002-anchor",
    "002-b",
    "002-network",
    "003",
    "004",
    "005",
    "005-existing",
    "010-a",
    "010-prefix",
    "010-length",
    "010-upper",
    "010-separator",
    "010-b",
    ...extraLinkedIds,
  ]) {
    const path = join(worktreeBase, `linked-${id}`);
    git(main, ["worktree", "add", "-q", "-b", `candidate-${id}`, path, "HEAD"]);
    linked[id] = path;
  }
  const existingInput = JSON.parse(readFileSync(versionBInput, "utf8")) as {
    identity: Record<string, string>;
    admission_input: {
      consumerRoot: string;
      runtimeRoot: string;
      receipt: Record<string, string>;
    };
  };
  const existingRoot = linked["005-existing"];
  const existingRuntimeRoot = join(existingRoot, ".ut-tdd", "runtime");
  existingInput.identity.consumer_root = existingRoot;
  existingInput.identity.runtime_root = existingRuntimeRoot;
  existingInput.admission_input.consumerRoot = existingRoot;
  existingInput.admission_input.runtimeRoot = existingRuntimeRoot;
  existingInput.admission_input.receipt.consumerRoot = existingRoot;
  existingInput.admission_input.receipt.runtimeRoot = existingRuntimeRoot;
  const existingInputPath = join(existingRoot, "consumer-runtime-input-b.json");
  writeFileSync(existingInputPath, `${JSON.stringify(existingInput)}\n`);
  const existingSetup = spawnSync(
    process.execPath,
    [join(pack, "src", "cli.ts"), "setup", "--solo", "--consumer-runtime-input", existingInputPath],
    {
      cwd: existingRoot,
      encoding: "utf8",
      timeout: 300_000,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: existingRoot,
        UT_TDD_PROJECT_DIR: existingRoot,
        UT_TDD_SKIP_UPDATE_CHECK: "1",
      },
    },
  );
  if (existingSetup.status !== 0)
    throw new Error(`different-version worktree setup failed: ${existingSetup.stderr}`);
  if (!existsSync(join(existingRoot, "ut-tdd.project.json")))
    throw new Error("different-version worktree project identity is missing after setup");

  const unmanaged = mkdtempSync(join(tmpdir(), "ut-tdd-cwtrt-unmanaged-"));
  const networkRoot = mkdtempSync(join(tmpdir(), "ut-tdd-cwtrt-network-"));
  tempRoots.push(unmanaged, networkRoot);
  const networkStub = join(networkRoot, "deny-network.cjs");
  const networkMarker = join(networkRoot, "network-attempts.log");
  writeFileSync(
    networkStub,
    `const fs=require("node:fs");const marker=process.env.UT_TDD_NETWORK_MARKER;const deny=()=>{fs.appendFileSync(marker,"attempt\\n");throw new Error("network disabled by test");};globalThis.__utNetworkDenyInstalled=true;globalThis.fetch=deny;for(const name of ["node:http","node:https"]){const api=require(name);api.request=deny;api.get=deny;}const net=require("node:net");net.connect=deny;net.createConnection=deny;require("node:tls").connect=deny;require("node:module").syncBuiltinESMExports();\n`,
  );
  return {
    pack,
    main,
    linked: { ...linked, unmanaged },
    release,
    anchor: releaseInfo.anchor,
    releaseId: releaseInfo.releaseId,
    cache,
    releaseB,
    anchorB: releaseInfoB.anchor,
    releaseIdB: releaseInfoB.releaseId,
    cacheB,
    versionBInput,
    networkStub,
    networkMarker,
  };
}

export function cleanupConsumerWorktreeRuntimeFixture(): void {
  for (const path of tempRoots.splice(0)) removeFixtureTree(path);
  for (const path of fixtureRoots.splice(0)) removeFixtureTree(path);
}
