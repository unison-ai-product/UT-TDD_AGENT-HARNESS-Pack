// PLAN-L6-83 §5 U-EXISSUE oracle — Forward外遷移Issue・駆動モデル選択契約の Red 固定。
// 実装 slice は PLAN-L7-436 系列 (本 oracle は契約の可換不変条件のみを固定する)。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  checkDriveModelAlignment,
  classifyForwardBoundary,
  type ForwardEscapeCustodyPort,
  type ForwardEscapeIssuePort,
  type ForwardEscapeProjectionJournal,
  OFF_FORWARD_DRIVE_MODELS,
  projectForwardEscapeIssue,
  type RequestForwardEscape,
  reconcileIssueProjection,
  renderForwardEscapeIssueBody,
  validateForwardEscape,
} from "../src/execution/forward-escape.ts";
import { SqliteForwardEscapeJournal } from "../src/execution/sqlite-forward-escape-journal.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function validCommand(overrides: Partial<RequestForwardEscape> = {}): RequestForwardEscape {
  return {
    command_id: "cmd-0001",
    origin_asset_id: "PLAN-L7-260-sensitive-scan-boundary",
    origin_revision_id: "rev-12",
    origin_layer: "L7",
    origin_state: "implement",
    escape_reason: "pre-push hook 対象見直しの実観測 drift",
    drive_model: "recovery",
    reentry_target_asset_id: "PLAN-L7-260-sensitive-scan-boundary",
    reentry_target_revision_id: "rev-12",
    reentry_target_layer: "L7",
    reentry_target_state: "trace-freeze",
    issue_projection: {
      owner: "unison-ai-product",
      repository: "UT-TDD_AGENT-HARNESS",
      title: "Recovery: sensitive-scan boundary drift",
      labels: ["ut-tdd", "drive:recovery"],
    },
    plan_id: "PLAN-L7-260-sensitive-scan-boundary",
    ...overrides,
  };
}

const emptyLedger = {
  currentRevisionOf: () => "rev-12",
  lookupRevision: (assetId: string, revisionId: string) =>
    assetId === "PLAN-L7-260-sensitive-scan-boundary" && revisionId === "rev-12"
      ? { layer: "L7", states: ["implement", "trace-freeze"] }
      : undefined,
  priorCommand: () => undefined,
};

type JournalEvent = Parameters<ForwardEscapeProjectionJournal["append"]>[0];

function memoryJournal(events: JournalEvent[] = []): ForwardEscapeProjectionJournal {
  return {
    append: (event) => {
      events.push(event);
      return {
        durable: true,
        event_digest: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
      };
    },
    eventsFor: (commandId) => events.filter((event) => event.command_id === commandId),
  };
}

function memoryCustody(): ForwardEscapeCustodyPort {
  const certificates = new Map<string, { payload: string; id: string; digest: string }>();
  return {
    issue: ({ command_id, payload_digest }) => {
      const prior = certificates.get(command_id);
      if (prior && prior.payload !== payload_digest) throw new Error("e2-command-payload-mismatch");
      const value = prior ?? {
        payload: payload_digest,
        id: `certificate:${command_id}`,
        digest: createHash("sha256").update(`${command_id}:${payload_digest}`).digest("hex"),
      };
      certificates.set(command_id, value);
      return { certificate_id: value.id, event_digest: value.digest };
    },
    verify: (event) => {
      const value = certificates.get(event.command.command_id);
      return Boolean(
        value &&
          value.payload === event.payload_digest &&
          value.id === event.certificate.certificate_id &&
          value.digest === event.certificate.event_digest,
      );
    },
  };
}

function validated(
  command: RequestForwardEscape = validCommand(),
  custody: ForwardEscapeCustodyPort = memoryCustody(),
) {
  const result = validateForwardEscape(command, emptyLedger, custody);
  expect(result.violations).toHaveLength(0);
  if (!result.validated) throw new Error("test fixture did not validate");
  return result.validated;
}

function openForwardEscapeDb(path: string, repoRoot: string) {
  const db = openHarnessDb(path, { repoRoot });
  migrate(db);
  return db;
}

describe("PLAN-L6-83 forward escape issue contract (U-EXISSUE)", () => {
  it("U-EXISSUE-001: 通常Forward辺はIssueなしで通り、off-Forward辺だけがIssueを要求する", () => {
    expect(classifyForwardBoundary({ signal: "descend" })).toBe("inside_forward");
    expect(classifyForwardBoundary({ signal: "freeze" })).toBe("inside_forward");
    for (const signal of ["blocked", "rejected", "reopened", "superseded", "preemptive", "defer"]) {
      expect(classifyForwardBoundary({ signal }), signal).toBe("forward_escape");
    }
    expect(classifyForwardBoundary({ signal: "yolo" })).toBe("invalid");
    expect(classifyForwardBoundary({ signal: "" })).toBe("invalid");
  });

  it("U-EXISSUE-002: drive_model 空・未知・技術drive混入・三面不一致は全て fail-close する", () => {
    expect(OFF_FORWARD_DRIVE_MODELS).toHaveLength(11);
    const empty = validateForwardEscape(validCommand({ drive_model: "" }), emptyLedger);
    expect(empty.violations.map((v) => v.code)).toContain("missing-drive-model");
    const unknown = validateForwardEscape(validCommand({ drive_model: "warp" }), emptyLedger);
    expect(unknown.violations.map((v) => v.code)).toContain("unknown-drive-model");
    for (const tech of ["be", "fe", "fullstack", "db", "agent", "normal"]) {
      const mixed = validateForwardEscape(validCommand({ drive_model: tech }), emptyLedger);
      expect(
        mixed.violations.map((v) => v.code),
        tech,
      ).toContain("tech-drive-confusion");
    }
    const aligned = checkDriveModelAlignment({
      command_drive_model: "recovery",
      issue_body_drive_model: "recovery",
      plan_route_mode: "recovery",
    });
    expect(aligned).toHaveLength(0);
    const misaligned = checkDriveModelAlignment({
      command_drive_model: "recovery",
      issue_body_drive_model: "reverse",
      plan_route_mode: "recovery",
    });
    expect(misaligned.map((v) => v.code)).toContain("drive-model-misalignment");
  });

  it("U-EXISSUE-003: stale origin_revision_id と不正な layer/state 組合せを拒否する", () => {
    const staleLedger = { ...emptyLedger, currentRevisionOf: () => "rev-13" };
    const stale = validateForwardEscape(validCommand(), staleLedger);
    expect(stale.violations.map((v) => v.code)).toContain("stale-origin-revision");
    const badLayer = validateForwardEscape(validCommand({ origin_layer: "L99" }), emptyLedger);
    expect(badLayer.violations.map((v) => v.code)).toContain("invalid-origin-layer");
    const emptyLayer = validateForwardEscape(validCommand({ origin_layer: "" }), emptyLedger);
    expect(emptyLayer.violations.map((v) => v.code)).toContain("invalid-origin-layer");
    const badState = validateForwardEscape(validCommand({ origin_state: "" }), emptyLedger);
    expect(badState.violations.map((v) => v.code)).toContain("missing-origin-state");
    const badReentry = validateForwardEscape(
      validCommand({ reentry_target_layer: "Lx" }),
      emptyLedger,
    );
    expect(badReentry.violations.map((v) => v.code)).toContain("invalid-reentry-target");
    const good = validateForwardEscape(validCommand(), emptyLedger, memoryCustody());
    expect(good.violations).toHaveLength(0);
    expect(good.validated?.type).toBe("ForwardEscapeValidated");

    const absentOrigin = validateForwardEscape(
      validCommand({ origin_asset_id: "PLAN-MISSING" }),
      emptyLedger,
    );
    expect(absentOrigin.violations.map((v) => v.code)).toContain("origin-revision-not-found");
    const absentReentry = validateForwardEscape(
      validCommand({ reentry_target_state: "accept" }),
      emptyLedger,
    );
    expect(absentReentry.violations.map((v) => v.code)).toContain("reentry-target-not-found");
    const absentReentryRevision = validateForwardEscape(
      validCommand({ reentry_target_revision_id: "rev-404" }),
      emptyLedger,
    );
    expect(absentReentryRevision.violations.map((v) => v.code)).toContain(
      "reentry-target-not-found",
    );
  });

  it("U-EXISSUE-004: command 再送は重複作成せず、payload 差分のある同一IDを拒否する", () => {
    const command = validCommand();
    const custody = memoryCustody();
    const replayLedger = {
      ...emptyLedger,
      currentRevisionOf: () => "rev-12",
      priorCommand: (id: string) =>
        id === command.command_id
          ? { payload_digest: validateForwardEscape(command, emptyLedger, custody).payload_digest }
          : undefined,
    };
    const replay = validateForwardEscape(command, replayLedger, custody);
    expect(replay.violations).toHaveLength(0);
    expect(replay.replay).toBe(true);
    const mutated = validateForwardEscape(
      validCommand({ escape_reason: "different payload" }),
      replayLedger,
      custody,
    );
    expect(mutated.violations.map((v) => v.code)).toContain("command-id-payload-mismatch");
  });

  it("U-EXISSUE-005: GitHub 障害時は Deferred を返して event を失わず、再開が同一 projection に冪等収束する", () => {
    const command = validCommand();
    const created: Array<{ idempotency_key: string; title: string }> = [];
    let failures = 1;
    const flakyPort: ForwardEscapeIssuePort = {
      createOrGetIssue: (request) => {
        if (failures > 0) {
          failures -= 1;
          return { ok: false, reason: "timeout" };
        }
        const existing = created.find((c) => c.idempotency_key === request.idempotency_key);
        if (!existing)
          created.push({ idempotency_key: request.idempotency_key, title: request.title });
        return {
          ok: true,
          binding: {
            repository: `${request.owner}/${request.repository}`,
            issue_number: 85,
            node_id: "I_node",
            url: "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/85",
            body_digest: request.body_digest,
            observed_revision: "etag-1",
          },
        };
      },
    };
    const custody = memoryCustody();
    const validatedEvent = validated(command, custody);
    const persisted: JournalEvent[] = [];
    const journal = memoryJournal(persisted);
    const first = projectForwardEscapeIssue({
      validated: validatedEvent,
      port: flakyPort,
      journal,
      custody,
    });
    expect(first.type).toBe("IssueProjectionDeferred");
    expect(journal.eventsFor(command.command_id).map((event) => event.type)).toEqual([
      "IssueProjectionQueued",
      "IssueProjectionDeferred",
    ]);
    // process restart: the durable journal is reused by a new projector invocation.
    const restartedJournal = memoryJournal(persisted);
    const second = projectForwardEscapeIssue({
      validated: validatedEvent,
      port: flakyPort,
      journal: restartedJournal,
      custody,
    });
    expect(second.type).toBe("IssueProjected");
    const third = projectForwardEscapeIssue({
      validated: validatedEvent,
      port: flakyPort,
      journal: restartedJournal,
      custody,
    });
    expect(third.type).toBe("IssueProjected");
    expect(created).toHaveLength(1);
    expect(restartedJournal.eventsFor(command.command_id).at(-1)?.type).toBe("IssueProjected");
  });

  it("U-EXISSUE-007: E2 validated event を持たない生 command は projection 入口を通れない", () => {
    const port: ForwardEscapeIssuePort = {
      createOrGetIssue: () => {
        throw new Error("must not call");
      },
    };
    expect(() =>
      projectForwardEscapeIssue({
        validated: validCommand() as never,
        port,
        journal: memoryJournal(),
        custody: memoryCustody(),
      }),
    ).toThrow("forward-escape-e2-required");
  });

  it("U-EXISSUE-008: GitHub success binding の全拘束を検証し malicious receipt をE4にしない", () => {
    const command = validCommand();
    const custody = memoryCustody();
    const validatedEvent = validated(command, custody);
    const bodyDigest = createHash("sha256")
      .update(renderForwardEscapeIssueBody(command))
      .digest("hex");
    const validBinding = {
      repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
      issue_number: 85,
      node_id: "I_node",
      url: "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/85",
      body_digest: bodyDigest,
      observed_revision: "etag-1",
    };
    for (const binding of [
      { ...validBinding, repository: "other/repo" },
      { ...validBinding, issue_number: 0 },
      { ...validBinding, node_id: "" },
      { ...validBinding, url: "https://github.com/other/repo/issues/85" },
      { ...validBinding, body_digest: "0".repeat(64) },
      { ...validBinding, observed_revision: "" },
    ]) {
      const journal = memoryJournal();
      const event = projectForwardEscapeIssue({
        validated: validatedEvent,
        port: { createOrGetIssue: () => ({ ok: true, binding }) },
        journal,
        custody,
      });
      expect(event.type).toBe("IssueProjectionDeferred");
      expect(journal.eventsFor(command.command_id).at(-1)?.type).toBe("IssueProjectionDeferred");
    }
  });

  it("U-EXISSUE-009: 三面が同じ未知 drive でも fail-close する", () => {
    expect(
      checkDriveModelAlignment({
        command_drive_model: "warp",
        issue_body_drive_model: "warp",
        plan_route_mode: "warp",
      }).map((finding) => finding.code),
    ).toContain("unknown-drive-model");
  });

  it("U-EXISSUE-010: SQLite close/reopen後もE2 custodyとoutbox chainを復元する", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-forward-escape-"));
    const dbPath = join(repo, ".ut-tdd", "harness.db");
    let db = openForwardEscapeDb(dbPath, repo);
    try {
      let journal = new SqliteForwardEscapeJournal(db);
      const event = validated(validCommand(), journal);
      let calls = 0;
      const port: ForwardEscapeIssuePort = {
        createOrGetIssue: (request) => {
          calls += 1;
          return {
            ok: true,
            binding: {
              repository: `${request.owner}/${request.repository}`,
              issue_number: 85,
              node_id: "I_node",
              url: "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/85",
              body_digest: request.body_digest,
              observed_revision: "etag-1",
            },
          };
        },
      };
      db.close();
      db = openForwardEscapeDb(dbPath, repo);
      journal = new SqliteForwardEscapeJournal(db);
      expect(journal.verify(event)).toBe(true);
      const first = projectForwardEscapeIssue({
        validated: event,
        port,
        journal,
        custody: journal,
      });
      expect(first.type).toBe("IssueProjected");
      db.close();
      db = openForwardEscapeDb(dbPath, repo);
      journal = new SqliteForwardEscapeJournal(db);
      const replay = projectForwardEscapeIssue({
        validated: event,
        port,
        journal,
        custody: journal,
      });
      expect(replay).toEqual(first);
      expect(calls).toBe(1);
    } finally {
      db.close();
      removeTestTree(repo);
    }
  });

  it("U-EXISSUE-011: forged E2、stale journal、remote-success append failureをfail-closeする", () => {
    const command = validCommand();
    const custody = memoryCustody();
    const event = validated(command, custody);
    const port: ForwardEscapeIssuePort = {
      createOrGetIssue: (request) => ({
        ok: true,
        binding: {
          repository: `${request.owner}/${request.repository}`,
          issue_number: 85,
          node_id: "I_node",
          url: "https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/85",
          body_digest: request.body_digest,
          observed_revision: "etag-1",
        },
      }),
    };
    expect(() =>
      projectForwardEscapeIssue({
        validated: { ...event, certificate: { ...event.certificate, certificate_id: "forged" } },
        port,
        journal: memoryJournal(),
        custody,
      }),
    ).toThrow("forward-escape-e2-required");
    const stale = memoryJournal([
      {
        type: "IssueProjectionQueued",
        command_id: command.command_id,
        payload_digest: "0".repeat(64),
        repository: "other/repo",
        body_digest: "0".repeat(64),
      },
    ]);
    expect(() =>
      projectForwardEscapeIssue({ validated: event, port, journal: stale, custody }),
    ).toThrow("projection-journal-payload-mismatch");
    let appends = 0;
    const failingJournal: ForwardEscapeProjectionJournal = {
      eventsFor: () => [],
      append: () => {
        appends += 1;
        if (appends === 2) throw new Error("disk-full-after-remote-success");
        return { durable: true, event_digest: "queued" };
      },
    };
    expect(() =>
      projectForwardEscapeIssue({ validated: event, port, journal: failingJournal, custody }),
    ).toThrow("disk-full-after-remote-success");
    expect(appends).toBe(2); // false Deferred appendを試みない
  });

  it.each([
    [
      "event digest",
      "UPDATE forward_escape_projection_events SET event_digest = ? WHERE command_id = ? AND sequence = 1",
      "f".repeat(64),
      "projection-journal-digest-invalid",
    ],
    [
      "malformed event",
      "UPDATE forward_escape_projection_events SET event_json = ? WHERE command_id = ? AND sequence = 1",
      '{"type":"IssueProjectionQueued"}',
      "projection-journal-digest-invalid",
    ],
  ])("U-EXISSUE-013: SQLite %s 改変をclose/reopen後のchain検査で拒否する", (_label, sql, mutation, expected) => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-forward-escape-tamper-"));
    const dbPath = join(repo, ".ut-tdd", "harness.db");
    let db = openForwardEscapeDb(dbPath, repo);
    try {
      const journal = new SqliteForwardEscapeJournal(db);
      const event = validated(validCommand(), journal);
      journal.append({
        type: "IssueProjectionQueued",
        command_id: event.command.command_id,
        payload_digest: event.payload_digest,
        repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
        body_digest: createHash("sha256")
          .update(renderForwardEscapeIssueBody(event.command))
          .digest("hex"),
      });
      db.prepare(sql).run(mutation, event.command.command_id);
      db.close();
      db = openForwardEscapeDb(dbPath, repo);
      expect(() => new SqliteForwardEscapeJournal(db).eventsFor(event.command.command_id)).toThrow(
        expected,
      );
    } finally {
      db.close();
      removeTestTree(repo);
    }
  });

  it("U-EXISSUE-014: SQLite E2 certificate改変をclose/reopen後のcustody照合で拒否する", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-forward-escape-cert-tamper-"));
    const dbPath = join(repo, ".ut-tdd", "harness.db");
    let db = openForwardEscapeDb(dbPath, repo);
    try {
      const event = validated(validCommand(), new SqliteForwardEscapeJournal(db));
      db.prepare(
        "UPDATE forward_escape_validation_certificates SET event_digest = ? WHERE command_id = ?",
      ).run("f".repeat(64), event.command.command_id);
      db.close();
      db = openForwardEscapeDb(dbPath, repo);
      expect(new SqliteForwardEscapeJournal(db).verify(event)).toBe(false);
    } finally {
      db.close();
      removeTestTree(repo);
    }
  });

  it("U-EXISSUE-012: 空のIssue projectionはE2 custody発行前に拒否する", () => {
    for (const issue_projection of [
      { owner: "", repository: "repo", title: "title", labels: ["x"] },
      { owner: "owner", repository: "", title: "title", labels: ["x"] },
      { owner: "owner", repository: "repo", title: "", labels: ["x"] },
      { owner: "owner", repository: "repo", title: "title", labels: [] },
    ]) {
      const result = validateForwardEscape(
        validCommand({ issue_projection }),
        emptyLedger,
        memoryCustody(),
      );
      expect(result.violations.map((finding) => finding.code)).toContain(
        "invalid-issue-projection",
      );
      expect(result.validated).toBeUndefined();
    }
  });

  it("U-EXISSUE-015: custody storage障害と異payload replayをsecret-safe structured violationへ変換する", () => {
    const unavailable = validateForwardEscape(validCommand(), emptyLedger, {
      issue: () => {
        throw new Error("SQLITE_IOERR path=C:/secret token=github_pat_secret");
      },
      verify: () => false,
    });
    expect(unavailable.violations.map((finding) => finding.code)).toContain(
      "e2-custody-unavailable",
    );
    expect(JSON.stringify(unavailable)).not.toContain("github_pat_secret");
    expect(unavailable.validated).toBeUndefined();

    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-forward-escape-replay-"));
    const dbPath = join(repo, ".ut-tdd", "harness.db");
    const firstDb = openForwardEscapeDb(dbPath, repo);
    const secondDb = openForwardEscapeDb(dbPath, repo);
    try {
      const first = validateForwardEscape(
        validCommand(),
        emptyLedger,
        new SqliteForwardEscapeJournal(firstDb),
      );
      expect(first.violations).toHaveLength(0);
      const conflict = validateForwardEscape(
        validCommand({ escape_reason: "different-payload" }),
        emptyLedger,
        new SqliteForwardEscapeJournal(secondDb),
      );
      expect(conflict.violations.map((finding) => finding.code)).toContain(
        "e2-command-payload-mismatch",
      );
      expect(conflict.validated).toBeUndefined();
      firstDb
        .prepare(
          "UPDATE forward_escape_validation_certificates SET event_digest = ? WHERE command_id = ?",
        )
        .run("f".repeat(64), validCommand().command_id);
      const corruptedReplay = validateForwardEscape(
        validCommand(),
        emptyLedger,
        new SqliteForwardEscapeJournal(secondDb),
      );
      expect(corruptedReplay.violations.map((finding) => finding.code)).toContain(
        "e2-custody-unavailable",
      );
      expect(corruptedReplay.validated).toBeUndefined();
    } finally {
      firstDb.close();
      secondDb.close();
      removeTestTree(repo);
    }
  });

  it("U-EXISSUE-016: two SQLite workers converge concurrent certificate and queue append to one receipt", async () => {
    const concurrentRepo = mkdtempSync(join(tmpdir(), "ut-tdd-forward-escape-concurrent-"));
    const dbPath = join(concurrentRepo, ".ut-tdd", "harness.db");
    const setup = openForwardEscapeDb(dbPath, concurrentRepo);
    setup.close();
    const gate = join(concurrentRepo, "gate");
    const ready = join(concurrentRepo, "ready");
    mkdirSync(ready);
    writeFileSync(gate, "wait", "utf8");
    const worker = join(concurrentRepo, "worker.mjs");
    try {
      buildSync({
        stdin: {
          contents: `import { existsSync, writeFileSync } from "node:fs";\nimport { SqliteForwardEscapeJournal } from "./src/execution/sqlite-forward-escape-journal.ts";\nimport { openHarnessDb } from "./src/state-db/index.ts";\nimport { migrate } from "./src/state-db/migration.ts";\nconst db = openHarnessDb(${JSON.stringify(dbPath)}, { repoRoot: ${JSON.stringify(concurrentRepo)} });\ntry { migrate(db); const journal = new SqliteForwardEscapeJournal(db); writeFileSync(${JSON.stringify(ready)} + "/" + process.pid, "ready"); while (existsSync(${JSON.stringify(gate)})) await new Promise((resolve) => setTimeout(resolve, 2)); const certificate = journal.issue({ command_id: "cmd-concurrent", payload_digest: "${"a".repeat(64)}" }); const receipt = journal.append({ type: "IssueProjectionQueued", command_id: "cmd-concurrent", payload_digest: "${"a".repeat(64)}", repository: "owner/repo", body_digest: "${"b".repeat(64)}" }); console.log("UT_TDD_WORKER_RESULT=" + JSON.stringify({ certificate, receipt })); } finally { db.close(); }\n`,
          resolveDir: process.cwd(),
          sourcefile: "forward-escape-sqlite-worker.ts",
        },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        outfile: worker,
      });
    } catch (error) {
      removeTestTree(concurrentRepo);
      throw error;
    }
    const nodeBinary = process.env.UT_TDD_NODE_BIN?.trim() || "node";
    const children = Array.from({ length: 2 }, () => {
      // workerはNode binaryを明示し、親test runtimeがBunでもBunを再起動しない。
      const child = spawn(nodeBinary, [worker], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          UT_TDD_FORWARD_ESCAPE_DB: dbPath,
          UT_TDD_FORWARD_ESCAPE_REPO: concurrentRepo,
          UT_TDD_FORWARD_ESCAPE_GATE: gate,
          UT_TDD_FORWARD_ESCAPE_READY: ready,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let launchError = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.on("error", (error) => {
            launchError = String(error);
            resolveExit({ code: null, signal: null });
          });
          child.on("exit", (code, signal) => resolveExit({ code, signal }));
        },
      );
      return {
        child,
        exit,
        output: () => ({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          launchError,
        }),
      };
    });
    const waitForExit = async (
      observed: (typeof children)[number],
      timeoutMs: number,
    ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          observed.exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`worker exit timeout after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    let primaryFailure: unknown;
    let cleanupFailure: AggregateError | undefined;
    try {
      const deadline = Date.now() + 30_000;
      while (readdirSync(ready).length < children.length && Date.now() < deadline) {
        for (const observed of children) {
          const output = observed.output();
          if (
            output.launchError ||
            observed.child.exitCode !== null ||
            observed.child.signalCode !== null
          ) {
            throw new Error(
              `worker exited before ready: code=${observed.child.exitCode} signal=${observed.child.signalCode} launchError=${output.launchError} stdout=${output.stdout} stderr=${output.stderr}`,
            );
          }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      const readyWorkers = readdirSync(ready);
      if (readyWorkers.length !== children.length) {
        throw new Error(
          `workers not ready: expected=${children.length} actual=${readyWorkers.length} diagnostics=${JSON.stringify(children.map((observed) => ({ exitCode: observed.child.exitCode, signalCode: observed.child.signalCode, ...observed.output() })))}`,
        );
      }
      rmSync(gate);
      const outputs = await Promise.all(
        children.map(async (observed) => {
          const result = await waitForExit(observed, 30_000);
          const output = observed.output();
          if (result.code !== 0 || output.launchError) {
            throw new Error(
              `worker exit ${result.code} signal=${result.signal} launchError=${output.launchError}: stdout=${output.stdout} stderr=${output.stderr}`,
            );
          }
          return output.stdout;
        }),
      );
      expect(outputs).toHaveLength(2);
      const workerResults = outputs.map(
        (output) => output.match(/UT_TDD_WORKER_RESULT=(\{.*\})/)?.[1],
      );
      expect(workerResults.every((result) => result !== undefined)).toBe(true);
      expect(new Set(workerResults).size).toBe(1);
      const verifyDb = openForwardEscapeDb(dbPath, concurrentRepo);
      try {
        expect(new SqliteForwardEscapeJournal(verifyDb).eventsFor("cmd-concurrent")).toHaveLength(
          1,
        );
      } finally {
        verifyDb.close();
      }
    } catch (error) {
      primaryFailure = error;
    } finally {
      for (const observed of children) {
        if (observed.child.exitCode === null && observed.child.signalCode === null) {
          observed.child.kill();
        }
      }
      const cleanup = await Promise.allSettled(
        children.map((observed) => waitForExit(observed, 5_000)),
      );
      const cleanupFailures = cleanup.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (existsSync(gate)) rmSync(gate);
      if (cleanupFailures.length > 0) {
        cleanupFailure = new AggregateError(
          cleanupFailures.map(({ reason }) => reason),
          "forward escape workers did not terminate",
        );
      }
      removeTestTree(concurrentRepo);
    }
    if (primaryFailure !== undefined && cleanupFailure) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "forward escape assertion and worker cleanup both failed",
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure) throw cleanupFailure;
  });

  it("U-EXISSUE-006: Issue 本文から origin/reentry/drive のいずれかを除く mutation を検出する", () => {
    // 値をすべて相異にし、行除去 mutation が toContain / digest の両方で必ず検出されるようにする
    // (値重複による退化 oracle の防止)。
    const command = validCommand({
      origin_asset_id: "PLAN-L6-64-cli-shell-completion",
      origin_layer: "L6",
      origin_state: "pair-freeze",
      reentry_target_layer: "L7",
      reentry_target_state: "implement",
      drive_model: "reverse",
      plan_id: "PLAN-REVERSE-395-shell-completion-backfill",
    });
    const body = renderForwardEscapeIssueBody(command);
    for (const required of [
      command.origin_asset_id,
      command.origin_revision_id,
      command.origin_layer,
      command.origin_state,
      command.escape_reason,
      command.drive_model,
      command.reentry_target_layer,
      command.reentry_target_asset_id,
      command.reentry_target_revision_id,
      command.reentry_target_state,
      command.plan_id,
    ]) {
      expect(body).toContain(required);
    }
    // 行単位の除去 mutation: どの必須行を落としても本文が変わり、digest 照合 (reconcile) が
    // issue-body-tampered として検出する (render→digest→検出の連結を実行する)。
    const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
    const lines = body.split("\n");
    for (const marker of [
      "Origin asset:",
      "Origin revision:",
      "Drive model:",
      "Reentry target:",
      "PLAN:",
    ]) {
      const mutated = lines.filter((line) => !line.includes(marker)).join("\n");
      expect(mutated, marker).not.toBe(body);
      const mutationFindings = reconcileIssueProjection(
        [
          {
            command_id: command.command_id,
            repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
            issue_number: 85,
            body_digest: digestOf(body),
          },
        ],
        [
          {
            repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
            issue_number: 85,
            state: "open",
            body_digest: digestOf(mutated),
          },
        ],
      );
      expect(
        mutationFindings.map((f) => f.code),
        marker,
      ).toContain("issue-body-tampered");
    }
    const binding = {
      command_id: command.command_id,
      repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
      issue_number: 85,
      body_digest: "digest-original",
    };
    const okSnapshot = [
      {
        repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
        issue_number: 85,
        state: "open",
        body_digest: "digest-original",
      },
    ];
    expect(reconcileIssueProjection([binding], okSnapshot)).toHaveLength(0);
    const tampered = reconcileIssueProjection(
      [binding],
      [{ ...okSnapshot[0], body_digest: "digest-tampered" }],
    );
    expect(tampered.map((f) => f.code)).toContain("issue-body-tampered");
    const deleted = reconcileIssueProjection([binding], []);
    expect(deleted.map((f) => f.code)).toContain("issue-missing");
    const wrongRepo = reconcileIssueProjection(
      [binding],
      [{ ...okSnapshot[0], repository: "other/repo" }],
    );
    expect(wrongRepo.map((f) => f.code)).toContain("issue-missing");
    const duplicated = reconcileIssueProjection(
      [binding],
      [...okSnapshot, { ...okSnapshot[0], issue_number: 86 }],
    );
    expect(duplicated.map((f) => f.code)).toContain("issue-duplicated");
  });
});
