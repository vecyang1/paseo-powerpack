import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildSwarmLiveCardData,
  extractAntigravityConversationIdFromAgentDoc,
  extractSwarmSidecarQuery,
  isBareSwarmBoardCommand,
  isSwarmSidecarUrl,
  parseWorkflowTaskLog,
} from "../shared/swarm-workflow-contracts";
import {
  disposeSwarmBoardBridge,
  handleInspectSwarmWorkflow,
  listLocalSwarms,
  listLocalWorkflows,
  locateOfficialSwarmBoard,
  readSwarmSnapshotDirect,
} from "../server/swarm-workflow-handlers";

after(async () => {
  await disposeSwarmBoardBridge();
});

test("sidecar://swarm URL and bare /swarm board classifiers distinguish UI actions from real swarm tasks", () => {
  assert.equal(isSwarmSidecarUrl("sidecar://swarm/swarm_board/?auto_open=false"), true);
  assert.equal(isSwarmSidecarUrl("sidecar://swarm/swarm_board/?tab=graph&conversationId=583b3339-28ec-463c-8171-cbe4eb2f0316"), true);
  assert.equal(isSwarmSidecarUrl("sidecar://dashboard"), false);
  assert.equal(isSwarmSidecarUrl("conversation://583b3339-28ec-463c-8171-cbe4eb2f0316"), false);

  const q = extractSwarmSidecarQuery(
    "sidecar://swarm/swarm_board/?tab=graph&conversationId=583b3339-28ec-463c-8171-cbe4eb2f0316",
  );
  assert.equal(q.tab, "graph");
  assert.equal(q.conversationId, "583b3339-28ec-463c-8171-cbe4eb2f0316");

  // Bare /swarm board is intercepted as local UI command; real /swarm tasks must NEVER be intercepted.
  assert.equal(isBareSwarmBoardCommand("/swarm board"), true);
  assert.equal(isBareSwarmBoardCommand("  /swarm board --channel ui  "), true);
  assert.equal(isBareSwarmBoardCommand("/swarm build a 3d mini golf game"), false);
  assert.equal(isBareSwarmBoardCommand("/swarm board game generator"), false);
  assert.equal(isBareSwarmBoardCommand("/swarm"), false);
});

test("parseWorkflowTaskLog extracts phases, workflow child agents with conversation IDs, logs, and output", () => {
  const sampleLog = [
    "- Starting Rollout Workflow",
    "- [phase] Stage 1: Parallel Build",
    "- Stage 1 log line",
    '- [agent:self] Backend Author: done (7435cd0a-6c2a-456e-9ea9-aad69efd3657): {"files": 13}',
    '- [agent:self] Frontend Author: done (6bd78952-2d93-428c-bdae-9d6876a66840): {"files": 4}',
    "- [phase] Stage 2: Security Review",
    '- [agent:research] Security Reviewer: done (8e05581d-0b6c-41ad-a383-387ce64f5ac8): OK',
    "Output:",
    "WORKFLOW_DONE",
  ].join("\n");

  const parsed = parseWorkflowTaskLog(sampleLog);
  assert.equal(parsed.inferredStatus, "completed");
  assert.equal(parsed.output, "WORKFLOW_DONE");
  assert.equal(parsed.agents.length, 3);
  assert.equal(parsed.agents[0]?.role, "Backend Author");
  assert.equal(parsed.agents[0]?.childConversationId, "7435cd0a-6c2a-456e-9ea9-aad69efd3657");
  assert.equal(parsed.agents[2]?.typeName, "research");
  assert.ok(parsed.phases.some((p) => p.name === "Stage 1: Parallel Build" && p.agents.length === 2));
  assert.ok(parsed.phases.some((p) => p.name === "Stage 2: Security Review" && p.agents.length === 1));
});

test("listLocalSwarms, readSwarmSnapshotDirect, and listLocalWorkflows parse synthetic brain artifacts accurately", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-swarm-wf-test-"));
  try {
    const swarmCid = "11111111-2222-3333-4444-555555555555";
    const workerCid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const swarmDir = path.join(tmpHome, ".gemini", "antigravity-cli", "brain", swarmCid, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.writeFileSync(
      path.join(swarmDir, "members.json"),
      JSON.stringify({
        title: "NEONPUTT 84 Mini Golf",
        members: {
          coordinator: {
            conversation_id: swarmCid,
            role: "coordinator",
            model: "gemini-4-neon-xhigh",
            wake_mode: "mentions",
            last_read_seq: 2,
            killed: false,
          },
          engine: {
            conversation_id: workerCid,
            role: "worker",
            model: "gemini-4-neon-xhigh",
            wake_mode: "working",
            last_read_seq: 2,
            killed: false,
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(swarmDir, "board.jsonl"),
      [
        JSON.stringify({ seq: 1, agent: "coordinator", text: "@engine build physics", time: "2026-11-20 00:10:00", kind: "brief" }),
        JSON.stringify({ seq: 2, agent: "engine", text: "@coordinator [done] physics ready", time: "2026-11-20 00:12:00" }),
      ].join("\n") + "\n",
    );

    const swarms = listLocalSwarms(tmpHome, 10);
    assert.equal(swarms.length, 1);
    assert.equal(swarms[0]?.title, "NEONPUTT 84 Mini Golf");
    assert.equal(swarms[0]?.memberCount, 2);
    assert.equal(swarms[0]?.activeCount, 1);
    assert.equal(swarms[0]?.postCount, 2);

    const snap = readSwarmSnapshotDirect(workerCid, tmpHome);
    assert.ok(snap, "resolving by worker conversationId finds parent swarm");
    assert.equal(snap.swarmId, swarmCid);
    assert.equal(snap.messages.length, 2);

    // Verify Paseo 0.16+ persistence.metadata.pluginProviderPersistence + sessionId mapping resolution
    const agentsBucket = path.join(tmpHome, ".paseo", "agents", "test-ws");
    fs.mkdirSync(agentsBucket, { recursive: true });
    fs.writeFileSync(
      path.join(agentsBucket, "agent-swarm-016.json"),
      JSON.stringify({
        id: "agent-swarm-016",
        workspaceId: "wks_swarm_016",
        title: "Mini Golf Session",
        updatedAt: "2026-11-20T12:00:00.000Z",
        runtimeInfo: {
          provider: "antigravity",
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: swarmCid } })}`,
        },
        persistence: {
          provider: "antigravity",
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: swarmCid } })}`,
          metadata: {
            pluginProviderPersistence: {
              version: 1,
              data: { conversationId: swarmCid },
            },
          },
        },
      }),
    );

    const mappedSwarms = listLocalSwarms(tmpHome, 10);
    assert.equal(mappedSwarms[0]?.paseoAgentId, "agent-swarm-016");
    assert.equal(mappedSwarms[0]?.paseoWorkspaceId, "wks_swarm_016");

    const wfCid = "99999999-8888-7777-6666-555555555555";
    const wfLogsDir = path.join(tmpHome, ".gemini", "antigravity-cli", "brain", wfCid, ".system_generated", "logs");
    const wfTasksDir = path.join(tmpHome, ".gemini", "antigravity-cli", "brain", wfCid, ".system_generated", "tasks");
    fs.mkdirSync(wfLogsDir, { recursive: true });
    fs.mkdirSync(wfTasksDir, { recursive: true });
    const logPath = path.join(wfTasksDir, "task-5.log");
    fs.writeFileSync(
      logPath,
      [
        "- [phase] Audit Phase",
        "- [agent:self] Auditor: done (12121212-3434-5656-7878-909090909090): 0 bugs",
        "Output:",
        "AUDIT_CLEAN",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(wfLogsDir, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 4,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [{ name: "run_workflow", args: { Description: '"Security Audit Pipeline"', ScriptPath: '"/tmp/audit.py"' } }],
        }),
        JSON.stringify({
          step_index: 5,
          type: "GENERIC",
          status: "RUNNING",
          content: `Tool is running as a background task with task id: ${wfCid}/task-5\nTask logs are available at: file://${logPath}`,
        }),
        JSON.stringify({
          step_index: 6,
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          content: `Task id "${wfCid}/task-5" finished with result:\nWorkflow completed.`,
        }),
      ].join("\n") + "\n",
    );

    const workflows = listLocalWorkflows(tmpHome, null, 10);
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]?.description, "Security Audit Pipeline");
    assert.equal(workflows[0]?.status, "completed");
    assert.equal(workflows[0]?.phases.length, 1);
    assert.equal(workflows[0]?.agents[0]?.childConversationId, "12121212-3434-5656-7878-909090909090");
    assert.equal(workflows[0]?.output, "AUDIT_CLEAN");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live official swarm_board bridge starts cleanly, serves Paseo preload.js and real /api/swarm", async () => {
  const located = locateOfficialSwarmBoard();
  if (!located) {
    // Skip only on machines without Antigravity installed
    return;
  }
  const res = await handleInspectSwarmWorkflow({ action: "probe", limit: 10 });
  assert.equal(res.bridge.running, true, `bridge should be running: ${res.bridge.lastError}`);
  assert.ok(res.bridge.proxyUrl, "proxyUrl should be populated");
  assert.ok(res.probe, "probe payload should be present");
  assert.equal(res.probe.preloadOk, true);
  assert.equal(res.probe.apiSwarmOk, true);
  assert.equal(res.bridge.features.graph, true);
  assert.equal(res.bridge.features.hive, true);

  // Verify live HTTP response of /preload.js contains Paseo postMessage bridge and theme-change handler
  const preloadBody = await new Promise<string>((resolve, reject) => {
    http
      .get(`${res.bridge.proxyUrl}/preload.js`, (resp) => {
        let data = "";
        resp.setEncoding("utf8");
        resp.on("data", (c) => (data += c));
        resp.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
  assert.ok(preloadBody.includes("paseo-swarm-open-conversation"));
  assert.ok(preloadBody.includes("theme-change"));
  assert.ok(preloadBody.includes('button.o2-progh[data-o2="doneOpen"]'));
  assert.ok(preloadBody.includes("maybeAutoExpandDoneTasks"));
});

test("extractAntigravityConversationIdFromAgentDoc and buildSwarmLiveCardData handle live & replayed formats", () => {
  const cid = "15b1b546-5f5e-4e78-9249-7f1e18e65515";
  assert.equal(
    extractAntigravityConversationIdFromAgentDoc({
      persistence: {
        metadata: { pluginProviderPersistence: { version: 1, data: { conversationId: cid } } },
      },
    }),
    cid,
  );
  assert.equal(
    extractAntigravityConversationIdFromAgentDoc({
      runtimeInfo: {
        sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: cid } })}`,
      },
    }),
    cid,
  );
  assert.equal(
    extractAntigravityConversationIdFromAgentDoc({
      persistence: { data: { conversationId: cid } },
    }),
    cid,
  );

  const liveAdd = buildSwarmLiveCardData(
    {
      type: "tool_call",
      callId: "call_1",
      name: "swarm",
      status: "running",
      detail: {
        type: "unknown",
        input: { action: "add", name: "core-cache", brief: "Own tikhub_cache.py" },
        output: null,
      },
    },
    "streaming",
  );
  assert.ok(liveAdd);
  assert.equal(liveAdd.action, "add");
  assert.equal(liveAdd.memberName, "core-cache");
  assert.equal(liveAdd.isLiveStreaming, true);

  const replayTitle = buildSwarmLiveCardData(
    {
      type: "tool_call",
      callId: "call_2",
      name: "swarm",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "Swarm (title) · TikHub Quota Observability",
        text: "TikHub Quota Observability",
      },
    },
    "complete",
  );
  assert.ok(replayTitle);
  assert.equal(replayTitle.action, "title");
  assert.equal(replayTitle.title, "TikHub Quota Observability");
  assert.equal(replayTitle.isLiveStreaming, false);

  assert.equal(
    buildSwarmLiveCardData({
      type: "tool_call",
      callId: "call_3",
      name: "run_command",
      status: "completed",
      detail: { type: "shell", command: "ls" },
    }),
    null,
  );
});

test("inspect_swarm_snapshot isolates workspace scope and skips heavy workflow scanning", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-swarm-scope-"));
  try {
    const swarmCid = "22222222-3333-4444-5555-666666666666";
    const swarmDir = path.join(tmpHome, ".gemini", "antigravity-cli", "brain", swarmCid, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.writeFileSync(
      path.join(swarmDir, "members.json"),
      JSON.stringify({
        title: "Scoped Swarm",
        members: {
          coordinator: { conversation_id: swarmCid, role: "coordinator", killed: false, wake_mode: "mentions" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(swarmDir, "board.jsonl"),
      JSON.stringify({ seq: 1, agent: "coordinator", text: "init", time: "2026-11-20 10:00:00" }) + "\n",
    );
    const bucket = path.join(tmpHome, ".paseo", "agents", "ws1");
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(
      path.join(bucket, "ag-1.json"),
      JSON.stringify({
        id: "ag-1",
        workspaceId: "wks_owned",
        persistence: {
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: swarmCid } })}`,
        },
      }),
    );

    const owned = await handleInspectSwarmWorkflow(
      { action: "inspect_swarm_snapshot", workspaceId: "wks_owned", limit: 10 },
      undefined,
      { homeDir: tmpHome },
    );
    assert.equal(owned.ok, true);
    assert.equal(owned.resolvedConversationId, swarmCid);
    assert.equal(owned.activeSwarmSnapshot?.swarmId, swarmCid);
    assert.equal(owned.workflows.length, 0);

    const unrelated = await handleInspectSwarmWorkflow(
      { action: "inspect_swarm_snapshot", workspaceId: "wks_unrelated", limit: 10 },
      undefined,
      { homeDir: tmpHome },
    );
    assert.equal(unrelated.ok, true);
    assert.equal(unrelated.resolvedConversationId, null);
    assert.equal(unrelated.activeSwarmSnapshot, null);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
