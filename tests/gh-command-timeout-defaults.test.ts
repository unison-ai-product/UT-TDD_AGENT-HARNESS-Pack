import type { SpawnSyncReturns } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validateLiveReviewSubject } from "../src/cli/review-live.ts";
import { createGhAttestationVerifier } from "../src/feedback/adapters/gh-attestation-verifier.ts";
import { nodeGh } from "../src/setup/index.ts";

interface LaunchOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

type LaunchArgs = [command: string, args: readonly string[], options?: LaunchOptions];

const child = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: LaunchArgs) => string>(),
  spawnSync: vi.fn<(...args: LaunchArgs) => SpawnSyncReturns<string>>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...child,
}));

const repository = "example/repo";
const head = "a".repeat(40);
const artifactDigest = "b".repeat(64);
const setupArgs = ["api", `repos/${repository}`];
const setupJson = JSON.stringify({ full_name: repository });
const reviewSubject = { repoRoot: "fixture", pr: 23, head };
const attestationQuery = {
  artifactPath: "review-receipt.json",
  artifactDigest,
  repository,
  expectedWorkflowRef: `${repository}/.github/workflows/review-attestation.yml@refs/heads/main`,
  expectedIssuer: "https://token.actions.githubusercontent.com",
};
const attestationJson = JSON.stringify([
  {
    verificationResult: {
      signature: {
        certificate: {
          sourceRepositoryURI: `https://github.com/${repository}`,
          buildSignerURI: `https://github.com/${attestationQuery.expectedWorkflowRef}`,
          buildSignerDigest: head,
          issuer: attestationQuery.expectedIssuer,
          runInvocationURI: `https://github.com/${repository}/actions/runs/42/attempts/1`,
        },
      },
      statement: {
        subject: [{ name: attestationQuery.artifactPath, digest: { sha256: artifactDigest } }],
      },
    },
  },
]);

const sentinelKey = "UT_TDD_TEST_GH_LAUNCH_SENTINEL";
const sentinelValue = "keep";

function successfulSpawn(stdout: string): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

function timeoutError(stdout: string): NodeJS.ErrnoException & { stdout: string } {
  return Object.assign(new Error("mock command timed out"), { code: "ETIMEDOUT", stdout });
}

function timedOutSpawn(stdout: string): SpawnSyncReturns<string> {
  return {
    ...successfulSpawn(stdout),
    status: null,
    signal: "SIGTERM",
    error: timeoutError(stdout),
  };
}

function capturedOptions(call: LaunchArgs | undefined): LaunchOptions {
  if (!call) throw new Error("Expected the default runner to invoke the subprocess");
  const options = call[2];
  return options?.env ? { ...options, env: { ...options.env } } : { ...options };
}

describe("GitHub CLI default launch options", () => {
  let setup: LaunchOptions;
  let attestation: LaunchOptions;
  let liveGh: LaunchOptions;
  let liveGit: LaunchOptions;

  beforeAll(async () => {
    vi.stubEnv(sentinelKey, sentinelValue);
    vi.stubEnv("GH_PROMPT_DISABLED", "0");
    try {
      child.execFileSync.mockReturnValueOnce(setupJson);
      child.spawnSync
        .mockReturnValueOnce(successfulSpawn(attestationJson))
        .mockReturnValueOnce(successfulSpawn(""))
        .mockReturnValueOnce(successfulSpawn(`${head}\n`));

      // Check that each fixture really reaches the default runner outside the expected failures.
      expect(nodeGh(setupArgs)).toEqual({ ok: true, stdout: setupJson });
      expect(await createGhAttestationVerifier().verify(attestationQuery)).toMatchObject({
        ok: true,
      });
      expect(validateLiveReviewSubject(reviewSubject)).toEqual({ ok: true });
      expect(child.execFileSync.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["gh", setupArgs],
      ]);
      expect(
        child.spawnSync.mock.calls.map(([command, args]) => [command, ...args.slice(0, 2)]),
      ).toEqual([
        ["gh", "attestation", "verify"],
        ["git", "cat-file", "-e"],
        ["gh", "pr", "view"],
      ]);

      setup = capturedOptions(child.execFileSync.mock.calls[0]);
      attestation = capturedOptions(child.spawnSync.mock.calls[0]);
      liveGit = capturedOptions(child.spawnSync.mock.calls[1]);
      liveGh = capturedOptions(child.spawnSync.mock.calls[2]);
    } finally {
      vi.unstubAllEnvs();
      child.execFileSync.mockReset();
      child.spawnSync.mockReset();
    }
  });

  it("U-CMDINPUT-018: nodeGh sets a 30-second timeout", () => {
    expect(setup.timeout).toBe(30_000);
  });

  it("U-CMDINPUT-018: default attestation sets a 30-second timeout", () => {
    expect(attestation.timeout).toBe(30_000);
  });

  it("U-CMDINPUT-018: live review gh sets a 30-second timeout", () => {
    expect(liveGh.timeout).toBe(30_000);
  });

  it("U-CMDINPUT-019: nodeGh disables prompting and preserves environment", () => {
    expect({
      promptDisabled: setup.env?.GH_PROMPT_DISABLED,
      sentinel: setup.env?.[sentinelKey],
    }).toEqual({ promptDisabled: "1", sentinel: sentinelValue });
  });

  it("U-CMDINPUT-019: default attestation disables prompting and preserves environment", () => {
    expect({
      promptDisabled: attestation.env?.GH_PROMPT_DISABLED,
      sentinel: attestation.env?.[sentinelKey],
    }).toEqual({ promptDisabled: "1", sentinel: sentinelValue });
  });

  it("U-CMDINPUT-019: live review gh disables prompting and preserves environment", () => {
    expect({
      promptDisabled: liveGh.env?.GH_PROMPT_DISABLED,
      sentinel: liveGh.env?.[sentinelKey],
    }).toEqual({ promptDisabled: "1", sentinel: sentinelValue });
  });

  it("U-CMDINPUT-026: live review leaves local git timeout and environment unset", () => {
    expect(liveGit).not.toHaveProperty("timeout");
    expect(Object.hasOwn(liveGit, "env")).toBe(false);
  });
});

it("U-CMDINPUT-017: ghCommandEnv copies input and forces prompt suppression", async () => {
  const specifier = ["..", "src", "github", "gh-command.ts"].join("/");
  const { ghCommandEnv } = (await import(/* @vite-ignore */ specifier)) as {
    ghCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  };
  const fields = { PATH: "fixture-path", GH_TOKEN: "fixture-token" };
  vi.stubEnv("GH_PROMPT_DISABLED", "unchanged");
  try {
    for (const input of [
      { ...fields },
      { ...fields, GH_PROMPT_DISABLED: "" },
      { ...fields, GH_PROMPT_DISABLED: "0" },
    ]) {
      const before = { ...input };
      const result = ghCommandEnv(input);
      expect(result).not.toBe(input);
      expect(result).toEqual({ ...before, GH_PROMPT_DISABLED: "1" });
      expect(input).toEqual(before);
    }
    expect(process.env.GH_PROMPT_DISABLED).toBe("unchanged");
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("GitHub CLI default timeout handling", () => {
  beforeEach(() => {
    child.execFileSync.mockReset();
    child.spawnSync.mockReset();
  });

  it("U-CMDINPUT-021: attestation rejects a timeout with valid JSON stdout", async () => {
    child.spawnSync.mockReturnValueOnce(timedOutSpawn(attestationJson));

    expect(await createGhAttestationVerifier().verify(attestationQuery)).toEqual({
      ok: false,
      reason: "audit_unavailable",
    });
    expect(child.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("U-CMDINPUT-021: live review rejects a gh timeout with the expected HEAD", () => {
    child.spawnSync
      .mockReturnValueOnce(successfulSpawn(""))
      .mockReturnValueOnce(timedOutSpawn(`${head}\n`));

    expect(validateLiveReviewSubject(reviewSubject)).toEqual({
      ok: false,
      reason: "pull_request_head_unavailable",
    });
    expect(child.spawnSync.mock.calls.map(([command]) => command)).toEqual(["git", "gh"]);
  });

  it("U-CMDINPUT-022: nodeGh reports failure on a timeout with valid JSON stdout", () => {
    child.execFileSync.mockImplementationOnce(() => {
      throw timeoutError(setupJson);
    });

    expect(nodeGh(setupArgs).ok).toBe(false);
    expect(child.execFileSync).toHaveBeenCalledTimes(1);
  });
});
