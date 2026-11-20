import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildFullDoctorCheckDefinitions,
  collectDoctorCheckRun,
  consumerSafeDoctorRunProfiles,
  DOCTOR_RUN_PROFILE_IDS,
  DOCTOR_RUN_PROFILES,
  type DoctorRunProfileId,
  doctorRunProfilesForAudience,
  FULL_DOCTOR_OUTPUT_IDS,
  resolveDoctorRunProfile,
  selectDoctorCheckDefinitions,
} from "../src/doctor/check-registry.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

/**
 * Issue #1037 の Red: doctor の pre-flight 用 profile `source-preflight`。
 * 契約: docs/design/harness/L6-function-design/doctor-source-preflight-profile.md
 * oracle: docs/test-design/harness/L7-doctor-source-preflight-profile-test-design.md (§4、§6)
 *
 * 区分 A (001) は it.fails、区分 B は前提 (登録) を it.skipIf で包み、区分 C (006 / 007 / 010) は
 * HEAD でも緑の guard である (010 は HEAD の toolchain 値 `claude-version-floor` 込みの literal)。前提は oracle の assertion の外に置く (test 設計 §4)。
 */

const ID = "source-preflight";
// HEAD の観測と複製元は headSnapshotRoot() (変更できない detached HEAD) から読む。CLI の path は vitest の cwd (snapshot runner が作る実行 root、node_modules あり) からの相対 resolve で組み立てる (L7 §2)。

// L6 §4.2 の宣言順。FULL_DOCTOR_OUTPUT_IDS などの定数から組み立てない。
const PREFLIGHT_IDS = [
  "doc-split",
  "code-size",
  "l6-completion",
  "l6-fr-coverage",
  "oracle-test-trace",
  "test-repository-isolation",
  "rule-drift",
  "readability",
];

// L7 §4.1 の固定値は origin/main de6da7e4d の値だが、契約 merge (#1663) の直後に #1662 (f2d9558e4) が
// toolchain 2 profile へ claude-version-floor を足した。HEAD の値に合わせた literal を置く。
// L7 §4.1 / L6 I4a の固定値の改訂は別の docs PR で行う (本 PR は docs に触れない)。
// src/doctor/profiles.ts の定数から組み立てない。
const SMALL_PROFILE_OUTPUT_IDS: Record<string, string[]> = {
  "source-doc-lane": ["readability", "runtime-readability", "rule-drift", "secret-scan"],
  "source-toolchain": ["toolchain-pin", "claude-version-floor"],
  "consumer-toolchain": ["toolchain-pin", "claude-version-floor"],
  "consumer-setup-smoke": [],
};

interface LooseProfile {
  id?: string;
  invocation?: string;
  scope?: string;
  setupSmoke?: boolean;
  outputIds?: readonly string[];
}

const profileIds: readonly string[] = DOCTOR_RUN_PROFILE_IDS;
const profileEntry = (DOCTOR_RUN_PROFILES as Record<string, LooseProfile | undefined>)[ID];
const outputIds: readonly string[] = profileEntry?.outputIds ?? [];
const fullIds: readonly string[] = FULL_DOCTOR_OUTPUT_IDS;

// G_reg: 登録済みで、id / invocation / scope / setupSmoke が L6 §4.1 の値
const gReg =
  profileIds.includes(ID) &&
  profileEntry !== undefined &&
  profileEntry.id === ID &&
  profileEntry.invocation === "registry" &&
  profileEntry.scope === "full" &&
  profileEntry.setupSmoke === false;
const extraIds = outputIds.filter((id) => !PREFLIGHT_IDS.includes(id));
const noDuplicate = new Set(outputIds).size === outputIds.length;
// G_run: G_reg かつ outputIds のすべてが FULL_DOCTOR_OUTPUT_IDS にある (L6 §5 の I1)
const gRun = gReg && outputIds.every((id) => fullIds.includes(id));

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) removeTestTree(root);
}, 120_000);

function runDoctorCli(cwd: string, profile: string) {
  const run = spawnSync(
    "node",
    [resolve("src", "cli.ts"), "doctor", "--profile", profile, "--json"],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  expect(run.error?.message ?? "", "spawn error").toBe("");
  return {
    status: run.status,
    payload: JSON.parse(run.stdout) as { ok: boolean; messages: string[] },
  };
}

/** HEAD の snapshot の複製 (git 付き)。実 repo と HEAD の snapshot には書かない。 */
function copyHeadSnapshot(label: string): string {
  const source = headSnapshotRoot();
  const scratch = mkdtempSync(join(tmpdir(), `ut-tdd-preflight-${label}-`));
  scratchRoots.push(scratch);
  cpSync(source, scratch, {
    recursive: true,
    filter: (path) =>
      !relative(source, path)
        .split(/[\\/]/)
        .some((part) => [".git", ".ut-tdd", "node_modules"].includes(part)),
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: scratch, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Preflight Profile Test");
  git("add", "-A");
  git("commit", "-m", "copy of the HEAD snapshot");
  git("remote", "add", "origin", scratch);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return scratch;
}

describe("doctor source-preflight profile (issue #1037 Red)", () => {
  it.fails("CANDIDATE-U-PREFLIGHT-001: registers source-preflight right after source-doc-lane", () => {
    expect(profileIds).toContain(ID);
    expect(profileIds.filter((id) => id === ID)).toHaveLength(1);
    expect(profileIds[profileIds.indexOf(ID) - 1]).toBe("source-doc-lane");
    expect(profileEntry).toMatchObject({
      id: ID,
      invocation: "registry",
      scope: "full",
      setupSmoke: false,
    });
  });

  it.skipIf(!gReg)(
    "CANDIDATE-U-PREFLIGHT-002: outputIds contains each of the 8 declared checks",
    () => {
      for (const id of PREFLIGHT_IDS) expect(outputIds).toContain(id);
    },
  );

  it.skipIf(!gReg)(
    "CANDIDATE-U-PREFLIGHT-003: outputIds contains no id outside the 8 declared checks",
    () => {
      expect(extraIds).toEqual([]);
    },
  );

  it.skipIf(!gRun)(
    "CANDIDATE-U-PREFLIGHT-004: runs exactly the declared checks in declared order",
    () => {
      const deps = nodeDoctorDeps(headSnapshotRoot());
      const definitions = buildFullDoctorCheckDefinitions(deps);
      const selected = selectDoctorCheckDefinitions(definitions, "full", outputIds);
      const run = collectDoctorCheckRun(deps, {
        profile: ID as string as DoctorRunProfileId,
        timing: true,
      });

      expect(selected.map((definition) => definition.id)).toEqual([...outputIds]);
      expect(run.checkIds).toEqual([...outputIds]);
      expect(run.checks).toHaveLength(outputIds.length);
      expect(run.timings.map((timing) => timing.id)).toEqual(
        definitions
          .filter(
            (definition) =>
              definition.profiles.includes("full") && outputIds.includes(definition.id),
          )
          .map((definition) => definition.id),
      );
      expect(JSON.stringify(run.checks)).not.toContain("missing doctor check result");
    },
    120_000,
  );

  it.skipIf(!(gRun && outputIds.includes("l6-completion")))(
    "CANDIDATE-U-PREFLIGHT-005: a member violation exits 1 with the violation message",
    () => {
      const root = copyHeadSnapshot("violation");
      const docPath = join(
        root,
        "docs/design/harness/L6-function-design/doctor-source-preflight-profile.md",
      );
      const text = readFileSync(docPath, "utf8");
      chmodSync(docPath, 0o666); // 複製は detached HEAD の読み取り専用属性を引き継ぐ
      writeFileSync(docPath, text.replace(/^issue:[^\r\n]*\r?\n/m, ""), "utf8");

      const { status, payload } = runDoctorCli(root, ID);

      expect(status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.messages.join("\n")).toContain("l6-completion");
    },
    600_000,
  );

  it("CANDIDATE-U-PREFLIGHT-006: an unknown profile is rejected before any check runs", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-preflight-typo-"));
    scratchRoots.push(root);
    const { status, payload } = runDoctorCli(root, "source-prefligh");

    expect(status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatch(/^doctor: invalid --profile "source-prefligh"/);
  }, 30_000);

  it("CANDIDATE-U-PREFLIGHT-007: the default profile resolves to source-full", () => {
    expect(resolveDoctorRunProfile({}).id).toBe("source-full");
  });

  it.skipIf(!gReg)(
    "CANDIDATE-U-PREFLIGHT-008: source-preflight stays out of the consumer-safe lists",
    () => {
      expect(consumerSafeDoctorRunProfiles().map((profile) => profile.id)).toEqual([
        "source-toolchain",
        "consumer-toolchain",
        "consumer-setup-smoke",
      ]);
      expect(doctorRunProfilesForAudience("consumer").map((profile) => profile.id)).not.toContain(
        ID,
      );
    },
  );

  it.skipIf(!gReg)(
    "CANDIDATE-U-PREFLIGHT-009: a competing doctor lock exits 2 before any check runs",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-preflight-lock-"));
      scratchRoots.push(root);
      const claims = join(root, ".ut-tdd", "state", "doctor-lock", "claims");
      mkdirSync(claims, { recursive: true });
      writeFileSync(
        join(claims, "fixture-lock.json"),
        `${JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString(), lock_id: "fixture-lock" })}\n`,
        "utf8",
      );

      const { status, payload } = runDoctorCli(root, ID);

      expect(status).toBe(2);
      expect(payload.ok).toBe(false);
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]).toContain("already running");
      expect(payload.messages[0]).toContain(`pid=${process.pid}`);
    },
    30_000,
  );

  it("CANDIDATE-U-PREFLIGHT-010: the small existing profiles keep their fixed outputIds", () => {
    for (const [id, expected] of Object.entries(SMALL_PROFILE_OUTPUT_IDS)) {
      const entry = (DOCTOR_RUN_PROFILES as Record<string, LooseProfile | undefined>)[id];
      expect([...(entry?.outputIds ?? ["<missing profile>"])], id).toEqual(expected);
    }
  });

  it.skipIf(!gReg)("CANDIDATE-U-PREFLIGHT-011: outputIds has no duplicate", () => {
    expect(new Set(outputIds).size).toBe(outputIds.length);
  });

  it.skipIf(!(gReg && noDuplicate))(
    "CANDIDATE-U-PREFLIGHT-012: outputIds follows the declared order",
    () => {
      expect(outputIds.filter((id) => PREFLIGHT_IDS.includes(id))).toEqual(
        PREFLIGHT_IDS.filter((id) => outputIds.includes(id)),
      );
    },
  );

  it.skipIf(!gRun)(
    "CANDIDATE-U-PREFLIGHT-013: an unmodified HEAD copy exits 0 with ok",
    () => {
      const root = copyHeadSnapshot("green");

      const { status, payload } = runDoctorCli(root, ID);

      expect(status).toBe(0);
      expect(payload.ok).toBe(true);
    },
    600_000,
  );

  it.skipIf(!(gReg && extraIds.length === 0))(
    "CANDIDATE-U-PREFLIGHT-014: every outputId is a FULL_DOCTOR_OUTPUT_IDS member",
    () => {
      for (const id of outputIds) expect(fullIds).toContain(id);
    },
  );
});
