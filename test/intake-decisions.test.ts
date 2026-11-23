import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { handleManageIntakeDecisions } from "../server/intake-decisions-handlers";
import { isIntakeDecisionsChord } from "../client/intake-decisions-web";

test("handleManageIntakeDecisions reads cached review_queue.json fast and shortens home paths", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-intake-test-"));
  const intakeHome = path.join(tmpHome, ".paseo", "vec-intake");
  fs.mkdirSync(intakeHome, { recursive: true });
  fs.writeFileSync(
    path.join(intakeHome, "config.json"),
    JSON.stringify({ max_decision_rounds: 6, max_concurrent: 3 }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(intakeHome, "review_queue.json"),
    JSON.stringify({
      generated_at: "2026-11-12T12:00:00.000Z",
      total_tasks: 12,
      actionable_blocked_count: 1,
      superseded_duplicate_count: 2,
      concerns_count: 1,
      counts_by_state: { done: 8, blocked: 1, concerns: 1 },
      buckets: {
        spend_or_purchase: [
          {
            task_id: "00000000-0000-0000-0000-00001f5a3bcb",
            short_id: "1f5a3bcb",
            state: "blocked",
            title: "Domain consolidation plan",
            priority: "Do Next",
            kind: "decision",
            profile: "Gemini 3.8 Flash (High)",
            agent_id: "659818cd-eb32-4ebb-808d-856a57ee8132",
            workspace_id: "wks_29eb75f2cd6489df",
            agent_live_status: "closed",
            resumable: true,
            decision_rounds: 0,
            finished_at: "2026-11-12T10:00:00.000Z",
            url: "https://notion.so/1f5a3bcb",
            report: path.join(intakeHome, "reports", "r1.report.md"),
            summary: "Prepared two domain routes",
            checkpoints: ["Pick domain"],
            options: [
              { index: 1, label: "Use subdomain apps.example.com", recommended: true },
              { index: 2, label: "Register new domain ($10.46/yr)", recommended: false },
            ],
            bucket: "spend_or_purchase",
          },
        ],
      },
    }),
    "utf-8",
  );

  let cliCalls = 0;
  const res = await handleManageIntakeDecisions(
    { action: "list" },
    {
      homeDir: tmpHome,
      intakeHome,
      exec: async () => {
        cliCalls += 1;
        return { stdout: "{}" };
      },
    },
  );

  assert.equal(cliCalls, 0, "cached queue with structured options should not spawn CLI");
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.equal(res.actionableBlockedCount, 1);
  assert.equal(res.doneCount, 8);
  assert.equal(res.maxDecisionRounds, 6);
  assert.equal(res.maxConcurrent, 3);
  assert.equal(res.externalScanEnabled, true);
  assert.ok(res.includeSources.includes("github comment intake"));
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]?.shortId, "1f5a3bcb");
  assert.equal(res.items[0]?.workspaceId, "wks_29eb75f2cd6489df");
  assert.equal(res.items[0]?.report, "~/.paseo/vec-intake/reports/r1.report.md");
  assert.equal(res.items[0]?.options.length, 2);
  assert.equal(res.items[0]?.options[0]?.recommended, true);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("handleManageIntakeDecisions preview_answer invokes dry-run CLI and maps preview", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-intake-prev-"));
  const intakeHome = path.join(tmpHome, ".paseo", "vec-intake");
  fs.mkdirSync(intakeHome, { recursive: true });
  fs.writeFileSync(
    path.join(intakeHome, "review_queue.json"),
    JSON.stringify({
      generated_at: "2026-11-12T12:00:00.000Z",
      total_tasks: 1,
      actionable_blocked_count: 0,
      superseded_duplicate_count: 0,
      concerns_count: 0,
      counts_by_state: {},
      buckets: {},
    }),
    "utf-8",
  );

  const recordedArgs: string[][] = [];
  const res = await handleManageIntakeDecisions(
    {
      action: "preview_answer",
      taskId: "1f5a3bcb",
      choice: 1,
      text: "Go ahead",
    },
    {
      homeDir: tmpHome,
      intakeHome,
      exec: async (args) => {
        recordedArgs.push(args);
        return {
          stdout: JSON.stringify({
            ok: true,
            dry_run: true,
            mode: "resume_existing_agent",
            task_id: "00000000-0000-0000-0000-00001f5a3bcb",
            short_id: "1f5a3bcb",
            title: "Domain plan",
            agent_id: "659818cd-eb32-4ebb-808d-856a57ee8132",
            agent_status: "closed",
            workspace_id: "wks_29eb75f2cd6489df",
            profile: "Gemini 3.8 Flash (High)",
            round: 1,
            max_decision_rounds: 8,
            decision_text: "Selected Option 1",
            next_report: path.join(intakeHome, "reports", "r2.report.md"),
          }),
        };
      },
    },
  );

  assert.equal(recordedArgs.length, 1);
  assert.deepEqual(recordedArgs[0], [
    "answer",
    "1f5a3bcb",
    "--json",
    "--dry-run",
    "--choice",
    "1",
    "--text",
    "Go ahead",
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.preview?.mode, "resume_existing_agent");
  assert.equal(res.preview?.nextReport, "~/.paseo/vec-intake/reports/r2.report.md");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("isIntakeDecisionsChord matches Ctrl+Cmd+D strictly without Shift or Option", () => {
  assert.equal(
    isIntakeDecisionsChord({ code: "KeyD", metaKey: true, ctrlKey: true, shiftKey: false, altKey: false }),
    true,
  );
  // Option+D belongs to Toggle Session Done; Cmd+D belongs to Dictation
  assert.equal(
    isIntakeDecisionsChord({ code: "KeyD", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }),
    false,
  );
  assert.equal(
    isIntakeDecisionsChord({ code: "KeyD", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }),
    false,
  );
});

test("handleManageIntakeDecisions scan_external invokes CLI with dry-run/sources and maps summary", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-intake-ext-"));
  const intakeHome = path.join(tmpHome, ".paseo", "vec-intake");
  fs.mkdirSync(intakeHome, { recursive: true });
  fs.writeFileSync(
    path.join(intakeHome, "state.json"),
    JSON.stringify({ external_scan: { last_run_at: "2026-11-22T15:00:00.000Z" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(intakeHome, "review_queue.json"),
    JSON.stringify({
      generated_at: "2026-11-22T15:00:00.000Z",
      total_tasks: 2,
      actionable_blocked_count: 0,
      superseded_duplicate_count: 0,
      concerns_count: 0,
      counts_by_state: { done: 2 },
      buckets: {},
    }),
    "utf-8",
  );

  const recorded: Array<{ args: string[]; timeoutMs?: number }> = [];
  const res = await handleManageIntakeDecisions(
    { action: "scan_external", dryRun: true, sources: "github", force: true },
    {
      homeDir: tmpHome,
      intakeHome,
      exec: async (args, opts) => {
        recorded.push({ args, timeoutMs: opts?.timeoutMs });
        return {
          stdout: JSON.stringify({
            at: "2026-11-22T16:00:00.000Z",
            dry_run: true,
            ran: ["github"],
            github: {
              notifications_fetched: 12,
              created: [{ target: "getpaseo/paseo#9395", subtype: "repro", title: "Repro #9395", url: "https://github.com/getpaseo/paseo/issues/9395" }],
              auto_resolved: [{ target: "getpaseo/paseo#9082" }],
              skipped: [{ target: "other#1" }],
            },
            email: null,
            errors: [],
          }),
        };
      },
    },
  );

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]?.args, ["scan-external", "--sources", "github", "--json", "--dry-run", "--force"]);
  assert.equal(recorded[0]?.timeoutMs, 45_000);
  assert.equal(res.ok, true);
  assert.equal(res.lastExternalScanAt, "2026-11-22T15:00:00.000Z");
  assert.equal(res.externalScan?.githubNotifications, 12);
  assert.equal(res.externalScan?.githubCreated, 1);
  assert.equal(res.externalScan?.githubAutoResolved, 1);
  assert.equal(res.externalScan?.items[0]?.target, "getpaseo/paseo#9395");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
