import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRacePlanPreview,
  deriveRaceTitle,
  sanitizeRaceBranchSegment,
} from "../shared/multi-model-race-contracts";
import {
  handleManageMultiModelRace,
  loadRaceConfig,
  loadRacesLedger,
} from "../server/multi-model-race-handlers";

function makeTempPaseoHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-race-test-"));
  const repoDir = path.join(dir, "demo-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "projects", "projects.json"),
    JSON.stringify([
      {
        projectId: "prj_demo",
        rootPath: repoDir,
        kind: "git",
        displayName: "demo-repo",
        archivedAt: null,
      },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, "projects", "workspaces.json"),
    JSON.stringify([
      {
        workspaceId: "wks_existing",
        workspaceDirectory: repoDir,
      },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      daemon: {
        agentProfiles: [
          {
            id: "prof-flash",
            name: "Gemini 4 Hydrogen - High",
            provider: "antigravity",
            model: "gemini-4-hydrogen",
            thinkingOptionId: "high",
            modeId: "full-access",
          },
          {
            id: "prof-opus",
            name: "Opus 5.5",
            provider: "claude",
            model: "claude-opus-5-5",
            thinkingOptionId: "xhigh",
            modeId: "bypassPermissions",
          },
        ],
      },
    }),
  );
  return { dir, repoDir };
}

test("Multi-Model Race 1: pure branch slugging and dry-run plan preview handle git vs local", () => {
  assert.equal(sanitizeRaceBranchSegment("Refactor Parser!! / Fast"), "refactor-parser-fast");
  assert.equal(deriveRaceTitle("  First line prompt\nSecond line"), "First line prompt");

  const gitPlan = buildRacePlanPreview({
    raceId: "race-20261125-173000-a1b2c3",
    title: "Optimize parser",
    cwd: "/tmp/demo",
    isGit: true,
    requestedIsolation: "worktree",
    baseRef: "origin/main",
    branchPrefix: "race",
    contenders: [
      { profile: "Gemini 4 Hydrogen", provider: "antigravity", model: "gemini-4-hydrogen", thinking: "high", mode: "full-access" },
      { profile: "Opus 5.5", provider: "claude", model: "claude-opus-5-5", thinking: "xhigh", mode: "bypassPermissions" },
    ],
  });
  assert.equal(gitPlan.isolation, "worktree");
  assert.equal(gitPlan.isolationNote, null);
  assert.equal(gitPlan.contenders.length, 2);
  assert.match(gitPlan.contenders[0].branch ?? "", /^race\/optimize-parser-gemini-4-hydrogen-a1b2c3$/);
  assert.match(gitPlan.contenders[1].branch ?? "", /^race\/optimize-parser-opus-5\.5-a1b2c3$/);

  const nonGitPlan = buildRacePlanPreview({
    raceId: "race-20261125-173000-d4e5f6",
    title: "Audit docs",
    cwd: "/tmp/plain",
    isGit: false,
    requestedIsolation: "worktree",
    baseRef: null,
    branchPrefix: "race",
    contenders: [
      { profile: "Flash", provider: "antigravity", model: "gemini-4-hydrogen" },
      { profile: "Opus", provider: "claude", model: "claude-opus-5-5" },
    ],
  });
  assert.equal(nonGitPlan.isolation, "local");
  assert.ok(nonGitPlan.isolationNote?.includes("not a git repository"));
  assert.equal(nonGitPlan.contenders[0].branch, null);
});

test("Multi-Model Race 2: dry_run RPC validates contenders and returns planned branches without side effects", async () => {
  const { dir, repoDir } = makeTempPaseoHome();
  try {
    const res = await handleManageMultiModelRace(
      {
        action: "dry_run",
        cwd: repoDir,
        prompt: "Benchmark query engine",
        contenders: [
          { profile: "Gemini 4 Hydrogen - High", provider: "antigravity", model: "gemini-4-hydrogen", thinking: "high" },
          { profile: "Opus 5.5", provider: "claude", model: "claude-opus-5-5", thinking: "xhigh" },
        ],
      },
      {
        paseoHome: dir,
        inspectGit: (cwd) => ({
          cwd,
          isGit: true,
          repoRoot: repoDir,
          currentBranch: "main",
          defaultBaseRef: "origin/main",
        }),
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.profiles.length, 2);
    assert.equal(res.projects.length, 1);
    assert.equal(res.projects[0].id, "prj_demo");
    assert.equal(res.projects[0].isGit, true);
    assert.equal(res.preview?.isolation, "worktree");
    assert.equal(res.preview?.contenders.length, 2);
    assert.equal((await loadRacesLedger(dir)).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Multi-Model Race 3: launch creates isolated worktrees in parallel, isolates failures, enriches diffs, and archives losers", async () => {
  const { dir, repoDir } = makeTempPaseoHome();
  const createdWorkspaces: Array<Record<string, unknown>> = [];
  const sentPrompts: Array<{ wsId: string; prompt: string }> = [];
  const archivedWorkspaces: string[] = [];

  const fakePaseo = {
    workspaces: {
      create: async (opts: Record<string, unknown>) => {
        createdWorkspaces.push(opts);
        const idx = createdWorkspaces.length;
        const wsId = `wks_race_${idx}`;
        return {
          id: wsId,
          directory: path.join(dir, `wt-${idx}`),
          agents: {
            create: async (agentOpts: { config: { provider: string } }) => {
              if (agentOpts.config.provider.includes("fail-model")) {
                throw new Error("simulated provider quota exhausted");
              }
              return {
                id: `ag_race_${idx}`,
                send: async (text: string) => {
                  sentPrompts.push({ wsId, prompt: text });
                },
              };
            },
          },
        };
      },
      ref: (wsId: string) => ({
        archive: async () => {
          archivedWorkspaces.push(wsId);
          return { workspaceId: wsId, archivedAt: new Date().toISOString(), error: null };
        },
      }),
    },
  };

  try {
    const launched = await handleManageMultiModelRace(
      {
        action: "launch",
        cwd: repoDir,
        prompt: "Build parallel diff viewer",
        title: "Diff viewer",
        contenders: [
          { profile: "Gemini 4 Hydrogen", provider: "antigravity", model: "gemini-4-hydrogen", thinking: "high", mode: "full-access" },
          { profile: "Opus 5.5", provider: "claude", model: "claude-opus-5-5", thinking: "xhigh", mode: "bypassPermissions" },
          { profile: "Broken Model", provider: "codex", model: "fail-model" },
        ],
      },
      {
        paseoHome: dir,
        paseo: fakePaseo as never,
        inspectGit: (cwd) => ({
          cwd,
          isGit: true,
          repoRoot: repoDir,
          currentBranch: "main",
          defaultBaseRef: "origin/main",
        }),
        readDiffStats: (wt) => ({
          filesChanged: wt.endsWith("wt-1") ? 4 : 2,
          insertions: wt.endsWith("wt-1") ? 120 : 45,
          deletions: 10,
          aheadCommits: 1,
          dirty: true,
        }),
      },
    );

    assert.equal(launched.ok, true);
    assert.ok(launched.launchedRace);
    assert.equal(createdWorkspaces.length, 3);
    assert.equal(sentPrompts.length, 2);
    assert.equal(launched.launchedRace.contenders[0].status, "running");
    assert.equal(launched.launchedRace.contenders[1].status, "running");
    assert.equal(launched.launchedRace.contenders[2].status, "failed");
    assert.match(launched.launchedRace.contenders[2].error ?? "", /quota exhausted/);

    const raceId = launched.launchedRace.raceId;
    const winnerWs = launched.launchedRace.contenders[0].workspaceId!;
    const inspected = await handleManageMultiModelRace(
      { action: "inspect", raceId },
      {
        paseoHome: dir,
        inspectGit: (cwd) => ({ cwd, isGit: true, repoRoot: repoDir, currentBranch: "main", defaultBaseRef: "origin/main" }),
        readDiffStats: () => ({ filesChanged: 4, insertions: 120, deletions: 10, aheadCommits: 1, dirty: true }),
      },
    );
    assert.equal(inspected.races.length, 1);
    assert.equal(inspected.races[0].contenders[0].diffStats?.insertions, 120);

    const archived = await handleManageMultiModelRace(
      { action: "archive_losers", raceId, winnerWorkspaceId: winnerWs },
      {
        paseoHome: dir,
        paseo: fakePaseo as never,
        inspectGit: (cwd) => ({ cwd, isGit: true, repoRoot: repoDir, currentBranch: "main", defaultBaseRef: "origin/main" }),
      },
    );
    assert.equal(archived.ok, true);
    assert.equal(archived.archiveResult?.winnerWorkspaceId, winnerWs);
    assert.equal(archived.archiveResult?.keptCount, 1);
    assert.equal(archived.archiveResult?.archivedCount, 2);
    assert.ok(!archivedWorkspaces.includes(winnerWs));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Multi-Model Race 4: configure and reset persist SSOT defaults", async () => {
  const { dir } = makeTempPaseoHome();
  try {
    const tuned = await handleManageMultiModelRace(
      {
        action: "configure",
        config: {
          defaultIsolation: "local",
          defaultBranchPrefix: "Exp/Race",
          maxContenders: 4,
          showNewWorkspaceTrigger: false,
        },
      },
      { paseoHome: dir },
    );
    assert.equal(tuned.ok, true);
    assert.equal(tuned.config.defaultIsolation, "local");
    assert.equal(tuned.config.defaultBranchPrefix, "exp-race");
    assert.equal(tuned.config.maxContenders, 4);
    assert.equal(tuned.config.showNewWorkspaceTrigger, false);
    assert.equal((await loadRaceConfig(dir)).maxContenders, 4);

    const reset = await handleManageMultiModelRace({ action: "reset" }, { paseoHome: dir });
    assert.equal(reset.config.defaultIsolation, "worktree");
    assert.equal(reset.config.maxContenders, 6);
    assert.equal(reset.config.showNewWorkspaceTrigger, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
