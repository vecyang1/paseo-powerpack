/**
 * Sidebar child sessions: which sessions were started by another session, and where the left
 * sidebar should list them (T-055). Pure data, no DOM: the web module feeds it Paseo's live
 * session store, and `scripts/sidebar-child-sessions-plan.mts` feeds it `~/.paseo/agents/*.json`
 * so an agent can read the same answer without the app.
 *
 * Contract (native Paseo 0.15.3, see Meta harness
 * `vault/research/2026-11-10-sidebar-child-session-nesting-linkage.md`):
 * - The one parent signal is the label `paseo.parent-agent-id`, which the daemon writes for MCP
 *   `create_agent` and for `paseo run` inside an agent shell. The client store exposes it as
 *   `parentAgentId`. An empty value means detached (intake-routed, colleague): not a child.
 * - `paseo.parent-server-id`, when present, must name this server.
 * - The daemon clears the label when the parent is archived, so a child of an archived parent
 *   is listed at top level again. We also refuse to nest under an archived or unknown parent.
 * - Native `isWorkspaceRootAgent`: a child in its parent's workspace is a tab of that workspace,
 *   so it has no sidebar row of its own. A child in another workspace is that workspace's root.
 *
 * Two outputs, matching those two cases:
 * - `childWorkspaces`: a workspace whose every live root agent was started by agents of one
 *   other workspace. Its native sidebar row moves under the parent workspace row.
 * - `tabChildren`: child agents that live in their parent's workspace. They get a light row
 *   under the workspace row, because the sidebar does not show them at all today.
 */

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
/** Deeper chains still nest; the indent stops growing here so titles stay readable. */
export const MAX_NEST_DEPTH = 3;

export interface ChildSessionAgent {
  id: string;
  workspaceId: string | null;
  /** Store field; when absent the label is read instead. */
  parentAgentId?: string | null;
  labels?: Record<string, string | null | undefined> | null;
  archivedAt?: string | number | Date | null;
  title?: string | null;
  status?: string | null;
  /** `turn.phase === "open"` in the store. */
  running?: boolean;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | string | null;
  pendingPermissionCount?: number;
  createdAt?: string | number | Date | null;
  lastActivityAt?: string | number | Date | null;
  /** Provider harness slug (e.g. `claude`, `antigravity`, `codex`). */
  provider?: string | null;
  /** Active or configured model ID (e.g. `claude-opus-5-5`, `gemini-4-neon`). */
  model?: string | null;
}

export type ChildSessionSkipReason =
  | "not-a-subagent"
  | "parent-unknown"
  | "parent-archived"
  | "parent-server-differs"
  | "mixed-roots"
  | "parents-in-several-workspaces"
  | "cycle";

export interface TabChildRow {
  agentId: string;
  parentAgentId: string;
  workspaceId: string;
  /** 1 = direct child of a root agent of the workspace. */
  depth: number;
  title: string;
  state: "running" | "attention" | "idle";
  attentionReason?: "finished" | "error" | "permission" | null;
  lastActivityMs: number | null;
  provider?: string | null;
  model?: string | null;
  parentProvider?: string | null;
  parentModel?: string | null;
}

export interface ChildWorkspaceLink {
  workspaceId: string;
  parentWorkspaceId: string;
  /** Agents in the child workspace and the parent agent each one names. */
  links: Array<{ agentId: string; parentAgentId: string }>;
  /** Normalized metadata rows for moved workspace badges and diagnostics. */
  linkRows?: TabChildRow[];
}

export interface ChildSessionSkip {
  agentId: string;
  workspaceId: string | null;
  reason: ChildSessionSkipReason;
}

export interface ChildSessionPlan {
  childWorkspaces: Map<string, ChildWorkspaceLink>;
  tabChildren: Map<string, TabChildRow[]>;
  skipped: ChildSessionSkip[];
}

function toMs(value: ChildSessionAgent["createdAt"]): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sessions that may carry a parent label but are not sub-sessions (taxonomy D-033, Meta harness
 * `vault/research/2026-11-10-subagents-vs-colleague-peers-taxonomy.md`): intake-routed queue
 * tasks and colleague peers. Same rules as the lineage server's `isIntakeOrRoutedAgent` /
 * `isColleagueLabeledAgent`; one copy here so the sidebar and the lineage bar cannot disagree.
 */
export function nonSubagentRelation(
  agent: Pick<ChildSessionAgent, "labels" | "title">,
): "intake-routed" | "colleague" | "referenced" | null {
  const labels = agent.labels ?? {};
  const rel = clean(labels["relation-kind"]);
  if (rel === "intake-routed" || clean(agent.title).startsWith("Intake · ") || clean(labels.brief).startsWith("intake-")) {
    return "intake-routed";
  }
  if (rel === "colleague" || clean(labels["colleague-of"])) return "colleague";
  if (rel === "referenced") return "referenced";
  return null;
}

/** The parent this agent names, or "" when it names none (empty label = detached). */
export function readParentAgentId(agent: ChildSessionAgent): string {
  const fromStore = clean(agent.parentAgentId);
  if (fromStore) return fromStore;
  return clean(agent.labels?.[PARENT_AGENT_ID_LABEL]);
}

function agentState(agent: ChildSessionAgent): TabChildRow["state"] {
  if (agent.requiresAttention || (agent.pendingPermissionCount ?? 0) > 0) return "attention";
  if (agent.running || clean(agent.status).toLowerCase() === "running") return "running";
  return "idle";
}

function agentAttentionReason(
  agent: ChildSessionAgent,
): TabChildRow["attentionReason"] {
  if ((agent.pendingPermissionCount ?? 0) > 0) return "permission";
  const r = clean(agent.attentionReason).toLowerCase();
  if (r === "finished" || r === "error" || r === "permission") return r;
  return null;
}

function byCreated(a: ChildSessionAgent, b: ChildSessionAgent): number {
  return (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0) || a.id.localeCompare(b.id);
}

export function planChildSessions(
  agents: Iterable<ChildSessionAgent>,
  options: { serverId?: string | null; archivedWorkspaceIds?: Iterable<string> } = {},
): ChildSessionPlan {
  const archivedWs = new Set(options.archivedWorkspaceIds ?? []);
  const all = new Map<string, ChildSessionAgent>();
  const live = new Map<string, ChildSessionAgent>();
  for (const agent of agents) {
    if (!agent?.id) continue;
    all.set(agent.id, agent);
    if (agent.archivedAt) continue;
    if (agent.workspaceId && archivedWs.has(agent.workspaceId)) continue;
    live.set(agent.id, agent);
  }

  const skipped: ChildSessionSkip[] = [];
  const skip = (agent: ChildSessionAgent, reason: ChildSessionSkipReason) =>
    skipped.push({ agentId: agent.id, workspaceId: agent.workspaceId, reason });
  // agentId -> its live parent, only when the link is valid
  const parentOf = new Map<string, ChildSessionAgent>();
  for (const agent of live.values()) {
    const parentId = readParentAgentId(agent);
    if (!parentId || parentId === agent.id) continue;
    if (nonSubagentRelation(agent)) {
      skip(agent, "not-a-subagent");
      continue;
    }
    const parentServer = clean(agent.labels?.[PARENT_SERVER_ID_LABEL]);
    if (parentServer && options.serverId && parentServer !== options.serverId) {
      skip(agent, "parent-server-differs");
      continue;
    }
    const parent = live.get(parentId);
    if (!parent) {
      skip(agent, all.has(parentId) ? "parent-archived" : "parent-unknown");
      continue;
    }
    parentOf.set(agent.id, parent);
  }

  const tabChildren = new Map<string, TabChildRow[]>();
  const childWorkspaces = new Map<string, ChildWorkspaceLink>();

  // Tab children: parent in the same workspace. Depth follows the same-workspace chain.
  const sameWsKids = new Map<string, ChildSessionAgent[]>();
  for (const [childId, parent] of parentOf) {
    const child = live.get(childId)!;
    if (!child.workspaceId || child.workspaceId !== parent.workspaceId) continue;
    const list = sameWsKids.get(parent.id) ?? [];
    list.push(child);
    sameWsKids.set(parent.id, list);
  }
  const isSameWsChild = (agent: ChildSessionAgent) => {
    const parent = parentOf.get(agent.id);
    return Boolean(parent && parent.workspaceId === agent.workspaceId);
  };
  for (const root of [...live.values()].filter((a) => !isSameWsChild(a)).sort(byCreated)) {
    if (!root.workspaceId || !sameWsKids.has(root.id)) continue;
    const rows = tabChildren.get(root.workspaceId) ?? [];
    const seen = new Set<string>([root.id]);
    const walk = (parentId: string, depth: number) => {
      for (const kid of [...(sameWsKids.get(parentId) ?? [])].sort(byCreated)) {
        if (seen.has(kid.id)) {
          skip(kid, "cycle");
          continue;
        }
        seen.add(kid.id);
        const parentAgent = live.get(parentId);
        rows.push({
          agentId: kid.id,
          parentAgentId: parentId,
          workspaceId: root.workspaceId!,
          depth: Math.min(depth, MAX_NEST_DEPTH),
          title: clean(kid.title) || kid.id.slice(0, 8),
          state: agentState(kid),
          attentionReason: agentAttentionReason(kid),
          lastActivityMs: toMs(kid.lastActivityAt) ?? toMs(kid.createdAt),
          provider: clean(kid.provider) || null,
          model: clean(kid.model) || null,
          parentProvider: clean(parentAgent?.provider) || null,
          parentModel: clean(parentAgent?.model) || null,
        });
        walk(kid.id, depth + 1);
      }
    };
    walk(root.id, 1);
    tabChildren.set(root.workspaceId, rows);
  }

  // Child workspaces: every live root agent of the workspace names a parent in one other workspace.
  const rootsByWs = new Map<string, ChildSessionAgent[]>();
  for (const agent of live.values()) {
    if (!agent.workspaceId || isSameWsChild(agent)) continue;
    const list = rootsByWs.get(agent.workspaceId) ?? [];
    list.push(agent);
    rootsByWs.set(agent.workspaceId, list);
  }
  for (const [wsId, roots] of rootsByWs) {
    const linked = roots.filter((r) => parentOf.has(r.id));
    if (linked.length === 0) continue;
    if (linked.length !== roots.length) {
      for (const r of linked) skip(r, "mixed-roots");
      continue;
    }
    const parentWs = new Set(linked.map((r) => parentOf.get(r.id)!.workspaceId ?? ""));
    if (parentWs.size !== 1) {
      for (const r of linked) skip(r, "parents-in-several-workspaces");
      continue;
    }
    const [parentWorkspaceId] = [...parentWs];
    if (!parentWorkspaceId || parentWorkspaceId === wsId) continue;
    const ordered = linked.sort(byCreated);
    childWorkspaces.set(wsId, {
      workspaceId: wsId,
      parentWorkspaceId,
      links: ordered.map((r) => ({ agentId: r.id, parentAgentId: parentOf.get(r.id)!.id })),
      linkRows: ordered.map((r) => {
        const parentAgent = parentOf.get(r.id)!;
        return {
          agentId: r.id,
          parentAgentId: parentAgent.id,
          workspaceId: wsId,
          depth: 1,
          title: clean(r.title) || r.id.slice(0, 8),
          state: agentState(r),
          attentionReason: agentAttentionReason(r),
          lastActivityMs: toMs(r.lastActivityAt) ?? toMs(r.createdAt),
          provider: clean(r.provider) || null,
          model: clean(r.model) || null,
          parentProvider: clean(parentAgent.provider) || null,
          parentModel: clean(parentAgent.model) || null,
        };
      }),
    });
  }
  // A workspace chain that loops back on itself would hide rows forever; drop every member.
  const inLoop = [...childWorkspaces.keys()].filter((wsId) => {
    let cursor = childWorkspaces.get(wsId)?.parentWorkspaceId;
    for (let steps = 0; cursor && steps <= childWorkspaces.size; steps += 1) {
      if (cursor === wsId) return true;
      cursor = childWorkspaces.get(cursor)?.parentWorkspaceId;
    }
    return false;
  });
  for (const wsId of inLoop) {
    for (const l of childWorkspaces.get(wsId)!.links) {
      skipped.push({ agentId: l.agentId, workspaceId: wsId, reason: "cycle" });
    }
    childWorkspaces.delete(wsId);
  }

  return { childWorkspaces, tabChildren, skipped };
}

/** Nesting depth of a child workspace (1 = directly under a top-level row). */
export function childWorkspaceDepth(plan: ChildSessionPlan, workspaceId: string): number {
  let depth = 0;
  let cursor: string | undefined = workspaceId;
  const seen = new Set<string>();
  while (cursor && plan.childWorkspaces.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = plan.childWorkspaces.get(cursor)?.parentWorkspaceId;
  }
  return Math.min(depth, MAX_NEST_DEPTH);
}

/**
 * Display order for one sidebar list: each child workspace directly after its parent (and after
 * the parent's earlier children), everything else in native order. Keys not in `nativeOrder`
 * (parent not on screen in this list) stay where they are.
 */
export function orderSidebarRows(nativeOrder: string[], parentOfRow: (key: string) => string | null): string[] {
  const present = new Set(nativeOrder);
  const kids = new Map<string, string[]>();
  const nested = new Set<string>();
  for (const key of nativeOrder) {
    const parent = parentOfRow(key);
    if (!parent || parent === key || !present.has(parent)) continue;
    nested.add(key);
    const list = kids.get(parent) ?? [];
    list.push(key);
    kids.set(parent, list);
  }
  const out: string[] = [];
  const emitted = new Set<string>();
  const emit = (key: string) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(key);
    for (const kid of kids.get(key) ?? []) emit(kid);
  };
  for (const key of nativeOrder) if (!nested.has(key)) emit(key);
  // A nested key whose ancestor chain never reached a top-level row (a loop): keep it visible.
  for (const key of nativeOrder) emit(key);
  return out;
}
