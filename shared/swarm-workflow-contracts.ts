import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SWARM_LIVE_CARD_KIND = "antigravity-swarm-card";
export const SWARM_LIVE_CARD_VERSION = 1;

export const SwarmMemberSummarySchema = z.object({
  name: z.string(),
  role: z.string(),
  conversationId: z.string(),
  model: z.string(),
  status: z.enum(["working", "waiting", "stopped", "killed"]),
  wakeMode: z.string(),
  lastReadSeq: z.number(),
  killed: z.boolean(),
  paseoAgentId: z.string().nullable(),
  paseoWorkspaceId: z.string().nullable(),
  activity: z.string().optional(),
});

export type SwarmMemberSummary = z.infer<typeof SwarmMemberSummarySchema>;

export const SwarmBoardMessageSchema = z.object({
  seq: z.number(),
  agent: z.string(),
  text: z.string(),
  time: z.string(),
  kind: z.string().optional(),
  channel: z.string().optional(),
});

export type SwarmBoardMessage = z.infer<typeof SwarmBoardMessageSchema>;

export const LocalSwarmSummarySchema = z.object({
  swarmId: z.string(),
  title: z.string(),
  appDataRoot: z.string(),
  appDataLabel: z.enum(["agy-cli", "antigravity-app", "other"]),
  memberCount: z.number(),
  activeCount: z.number(),
  waitingCount: z.number(),
  killedCount: z.number(),
  postCount: z.number(),
  hasOverview: z.boolean(),
  hasPlan: z.boolean(),
  updatedAtMs: z.number(),
  paseoAgentId: z.string().nullable(),
  paseoWorkspaceId: z.string().nullable(),
  paseoTitle: z.string().nullable(),
  members: z.array(SwarmMemberSummarySchema),
});

export type LocalSwarmSummary = z.infer<typeof LocalSwarmSummarySchema>;

export const WorkflowAgentEntrySchema = z.object({
  typeName: z.string(),
  role: z.string(),
  status: z.string(),
  childConversationId: z.string().nullable(),
  summary: z.string(),
  phaseName: z.string(),
  paseoAgentId: z.string().nullable(),
  paseoWorkspaceId: z.string().nullable(),
});

export type WorkflowAgentEntry = z.infer<typeof WorkflowAgentEntrySchema>;

export const WorkflowPhaseEntrySchema = z.object({
  name: z.string(),
  logs: z.array(z.string()),
  agents: z.array(WorkflowAgentEntrySchema),
});

export type WorkflowPhaseEntry = z.infer<typeof WorkflowPhaseEntrySchema>;

export const LocalWorkflowRunSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  stepIndex: z.number(),
  taskId: z.string().nullable(),
  description: z.string(),
  scriptPath: z.string().nullable(),
  logPath: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "unknown"]),
  phases: z.array(WorkflowPhaseEntrySchema),
  agents: z.array(WorkflowAgentEntrySchema),
  output: z.string(),
  logLineCount: z.number(),
  updatedAtMs: z.number(),
  appDataLabel: z.enum(["agy-cli", "antigravity-app", "other"]),
  paseoAgentId: z.string().nullable(),
  paseoWorkspaceId: z.string().nullable(),
  paseoTitle: z.string().nullable(),
});

export type LocalWorkflowRun = z.infer<typeof LocalWorkflowRunSchema>;

export const SwarmBoardBridgeStatusSchema = z.object({
  running: z.boolean(),
  proxyUrl: z.string().nullable(),
  upstreamPort: z.number().nullable(),
  upstreamDir: z.string().nullable(),
  upstreamChecksum: z.string().nullable(),
  sidecarSdkMode: z.enum(["official", "fallback-shim", "unavailable"]),
  nativeSwarmSkillPath: z.string().nullable(),
  runWorkflowSkillPath: z.string().nullable(),
  agyVersion: z.string().nullable(),
  features: z.object({
    overview: z.boolean(),
    graph: z.boolean(),
    raw: z.boolean(),
    hive: z.boolean(),
    gifExport: z.boolean(),
  }),
  restarts: z.number(),
  lastError: z.string().nullable(),
});

export type SwarmBoardBridgeStatus = z.infer<typeof SwarmBoardBridgeStatusSchema>;

export const inspectSwarmWorkflowRpc = defineRpc({
  name: "finder.inspect_swarm_workflow",
  input: z.object({
    action: z
      .enum([
        "status",
        "ensure_board_server",
        "list_swarms",
        "list_workflows",
        "inspect_swarm_snapshot",
        "probe",
        "restart_board",
      ])
      .default("status"),
    workspaceId: z.string().optional(),
    agentId: z.string().optional(),
    conversationId: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.string(),
    resolvedConversationId: z.string().nullable(),
    bridge: SwarmBoardBridgeStatusSchema,
    swarms: z.array(LocalSwarmSummarySchema),
    workflows: z.array(LocalWorkflowRunSchema),
    activeSwarmSnapshot: z
      .object({
        swarmId: z.string(),
        title: z.string(),
        memberCount: z.number(),
        activeCount: z.number().optional(),
        waitingCount: z.number().optional(),
        killedCount: z.number().optional(),
        postCount: z.number(),
        updatedAtMs: z.number().optional(),
        paseoAgentId: z.string().nullable().optional(),
        paseoWorkspaceId: z.string().nullable().optional(),
        members: z.array(SwarmMemberSummarySchema),
        messages: z.array(SwarmBoardMessageSchema),
      })
      .nullable(),
    probe: z
      .object({
        ok: z.boolean(),
        httpStatus: z.number().nullable(),
        preloadOk: z.boolean(),
        apiSwarmOk: z.boolean(),
        nativeSlashPassthroughOk: z.boolean(),
        checks: z.array(
          z.object({
            name: z.string(),
            ok: z.boolean(),
            detail: z.string(),
          }),
        ),
      })
      .nullable(),
    message: z.string(),
    durationMs: z.number(),
  }),
});

export type InspectSwarmWorkflowInput = z.infer<typeof inspectSwarmWorkflowRpc.input>;
export type InspectSwarmWorkflowOutput = z.infer<typeof inspectSwarmWorkflowRpc.output>;

export function isSwarmSidecarUrl(rawUrl: string | null | undefined): boolean {
  const s = String(rawUrl ?? "").trim();
  return /^sidecar:\/\/swarm(?:\/swarm_board)?(?:[/?#]|$)/i.test(s);
}

export function extractSwarmSidecarQuery(rawUrl: string | null | undefined): {
  tab?: string;
  conversationId?: string;
} {
  const s = String(rawUrl ?? "").trim();
  if (!isSwarmSidecarUrl(s)) return {};
  const qIdx = s.indexOf("?");
  if (qIdx < 0) return {};
  const params = new URLSearchParams(s.slice(qIdx + 1).split("#")[0] ?? "");
  const tab = params.get("tab")?.trim() || undefined;
  const conversationId = params.get("conversationId")?.trim() || undefined;
  return { tab, conversationId };
}

export function isBareSwarmBoardCommand(rawText: string | null | undefined): boolean {
  const s = String(rawText ?? "").trim();
  return /^\/swarm[ \t]+board(?:[ \t]+--channel[ \t]+[A-Za-z0-9_.-]+)?[ \t]*$/i.test(s);
}

export const SwarmLiveCardDataSchema = z.object({
  callId: z.string(),
  action: z.string(),
  memberName: z.string().nullable(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  briefPreview: z.string().nullable(),
  toolStatus: z.string().nullable(),
  isLiveStreaming: z.boolean(),
});

export type SwarmLiveCardData = z.infer<typeof SwarmLiveCardDataSchema>;

const ANTIGRAVITY_CONV_ID_RE = /^[0-9a-f-]{8,}$/i;

function readNonEmptyStr(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed ? trimmed : null;
}

function asObjRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function parsePluginSessionHandleConversationId(sessionId: unknown): string | null {
  const raw = readNonEmptyStr(sessionId);
  if (!raw) return null;
  if (raw.startsWith("plugin:")) {
    try {
      const parsed = JSON.parse(raw.slice("plugin:".length)) as {
        data?: { conversationId?: unknown };
      };
      const cid = readNonEmptyStr(parsed?.data?.conversationId);
      if (cid && ANTIGRAVITY_CONV_ID_RE.test(cid)) return cid;
    } catch {
      return null;
    }
    return null;
  }
  return ANTIGRAVITY_CONV_ID_RE.test(raw) ? raw : null;
}

/**
 * Extracts the Antigravity conversation UUID from any Paseo agent JSON shape:
 *   1. `persistence.metadata.pluginProviderPersistence.data.conversationId` (Paseo 0.16+)
 *   2. `persistence.data.conversationId` (legacy / test fixtures)
 *   3. `persistence.sessionId` / `runtimeInfo.sessionId` (`plugin:{"version":1,"data":{"conversationId":"..."}}`)
 */
export function extractAntigravityConversationIdFromAgentDoc(doc: unknown): string | null {
  const rec = asObjRecord(doc);
  if (!rec) return null;
  const persistence = asObjRecord(rec.persistence);
  const meta = asObjRecord(persistence?.metadata);
  const pluginPersist = asObjRecord(meta?.pluginProviderPersistence);
  const pluginData = asObjRecord(pluginPersist?.data);
  const directPersistData = asObjRecord(persistence?.data);
  const runtimeInfo = asObjRecord(rec.runtimeInfo);

  const candidates = [
    readNonEmptyStr(pluginData?.conversationId),
    readNonEmptyStr(directPersistData?.conversationId),
    parsePluginSessionHandleConversationId(persistence?.sessionId),
    parsePluginSessionHandleConversationId(runtimeInfo?.sessionId),
  ];
  for (const cand of candidates) {
    if (cand && ANTIGRAVITY_CONV_ID_RE.test(cand)) return cand;
  }
  return null;
}

/**
 * Builds timeline card data for an Antigravity native `swarm` tool call
 * (both live streaming `detail.type === "unknown"` and replayed `detail.type === "plain_text"`),
 * or returns `null` for non-swarm tool calls.
 */
export function buildSwarmLiveCardData(
  item: unknown,
  phase?: "streaming" | "complete",
): SwarmLiveCardData | null {
  const rec = asObjRecord(item);
  if (!rec || rec.type !== "tool_call") return null;
  const name = readNonEmptyStr(rec.name);
  if (name !== "swarm") return null;
  const callId = readNonEmptyStr(rec.callId) ?? readNonEmptyStr(rec.id);
  if (!callId) return null;

  const detail = asObjRecord(rec.detail);
  const detailType = readNonEmptyStr(detail?.type);
  const input = asObjRecord(detail?.input);

  let action = readNonEmptyStr(input?.action) ?? "";
  let memberName = readNonEmptyStr(input?.name);
  let title = readNonEmptyStr(input?.title);
  let model = readNonEmptyStr(input?.model);
  let briefPreview = readNonEmptyStr(input?.brief)?.slice(0, 160) ?? null;

  if (detailType === "plain_text") {
    const label = readNonEmptyStr(detail?.label) ?? "";
    const text = readNonEmptyStr(detail?.text) ?? "";
    // Format from session.ts: `Swarm (<act>) · @<name> · <model>` or `Swarm (<act>) · <title>`
    const actMatch = /^Swarm\s*\(([^)]+)\)(.*)$/i.exec(label);
    if (actMatch) {
      action = action || (actMatch[1]?.trim().toLowerCase() ?? "status");
      const tail = (actMatch[2] ?? "").trim();
      const parts = tail
        .split("·")
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        if (part.startsWith("@") && !memberName) {
          memberName = part.slice(1).trim() || null;
        } else if (action === "title" && !title) {
          title = part;
        } else if (!model && /^[a-z0-9._-]+$/i.test(part)) {
          model = part;
        }
      }
    }
    if (action === "title" && !title && text && text !== "title") {
      title = text.slice(0, 120);
    } else if (!briefPreview && text && text !== action && text !== memberName) {
      briefPreview = text.slice(0, 160);
    }
  }

  return {
    callId,
    action: (action || "status").toLowerCase(),
    memberName,
    title,
    model,
    briefPreview,
    toolStatus: readNonEmptyStr(rec.status),
    isLiveStreaming: phase === "streaming" || readNonEmptyStr(rec.status) === "running",
  };
}

export interface ParsedWorkflowTaskLog {
  phases: Array<{
    name: string;
    logs: string[];
    agents: Array<{
      typeName: string;
      role: string;
      status: string;
      childConversationId: string | null;
      summary: string;
      phaseName: string;
    }>;
  }>;
  agents: Array<{
    typeName: string;
    role: string;
    status: string;
    childConversationId: string | null;
    summary: string;
    phaseName: string;
  }>;
  output: string;
  logLineCount: number;
  inferredStatus: "running" | "completed" | "failed" | "unknown";
}

const WF_PHASE_RE = /^-\s+\[phase\]\s+(.+)$/i;
const WF_AGENT_RE =
  /^-\s+\[agent:([^\]]+)\]\s+(.+?):\s+(done|running|active|failed|error|canceled|cancelled|completed)\s*(?:\(([0-9a-f-]{8,})\))?(?::\s*(.*))?$/i;

/**
 * Parses Antigravity's structured `run_workflow` task log (`.system_generated/tasks/task-<step>.log`).
 */
export function parseWorkflowTaskLog(rawLog: string): ParsedWorkflowTaskLog {
  const text = String(rawLog ?? "");
  if (!text.trim()) {
    return {
      phases: [],
      agents: [],
      output: "",
      logLineCount: 0,
      inferredStatus: "unknown",
    };
  }
  const lines = text.split(/\r?\n/);
  const phases: ParsedWorkflowTaskLog["phases"] = [];
  const agents: ParsedWorkflowTaskLog["agents"] = [];
  let currentPhase: ParsedWorkflowTaskLog["phases"][number] | null = null;
  const ensurePhase = (name: string) => {
    const existing = phases.find((p) => p.name === name);
    if (existing) {
      currentPhase = existing;
      return existing;
    }
    const created = { name, logs: [], agents: [] };
    phases.push(created);
    currentPhase = created;
    return created;
  };

  let inOutput = false;
  const outputLines: string[] = [];
  let logLineCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!inOutput && /^Output:\s*$/.test(line)) {
      inOutput = true;
      continue;
    }
    if (inOutput) {
      outputLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    logLineCount += 1;
    const phaseMatch = WF_PHASE_RE.exec(trimmed);
    if (phaseMatch?.[1]) {
      ensurePhase(phaseMatch[1].trim());
      continue;
    }
    const agentMatch = WF_AGENT_RE.exec(trimmed);
    if (agentMatch) {
      const targetPhase = currentPhase ?? ensurePhase("Workflow");
      const entry = {
        typeName: (agentMatch[1] ?? "self").trim(),
        role: (agentMatch[2] ?? "Agent").trim(),
        status: (agentMatch[3] ?? "done").trim().toLowerCase(),
        childConversationId: agentMatch[4] ? agentMatch[4].trim() : null,
        summary: (agentMatch[5] ?? "").trim().slice(0, 400),
        phaseName: targetPhase.name,
      };
      targetPhase.agents.push(entry);
      agents.push(entry);
      continue;
    }
    const targetPhase = currentPhase ?? ensurePhase("Setup");
    targetPhase.logs.push(trimmed.replace(/^-\s+/, "").slice(0, 500));
  }

  const output = outputLines.join("\n").trim();
  const hasFailedAgent = agents.some((a) => a.status === "failed" || a.status === "error");
  const hasRunningAgent = agents.some((a) => a.status === "running" || a.status === "active");
  let inferredStatus: ParsedWorkflowTaskLog["inferredStatus"] = "unknown";
  if (hasFailedAgent || /\b(?:Traceback|Exception|Workflow failed|Error:)\b/i.test(output)) {
    inferredStatus = "failed";
  } else if (output.length > 0 || (agents.length > 0 && !hasRunningAgent)) {
    inferredStatus = "completed";
  } else if (logLineCount > 0) {
    inferredStatus = "running";
  }

  return {
    phases,
    agents,
    output: output.slice(0, 4000),
    logLineCount,
    inferredStatus,
  };
}
