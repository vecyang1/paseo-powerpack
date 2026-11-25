/// <reference lib="dom" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type SessionLineageNode,
  manageSessionLineageRpc,
  openFileTargetRpc,
  inspectSystemPromptRpc,
} from "../shared/contracts";
import { isChineseLocale } from "./i18n";
import { compareSessionBrands } from "../shared/model-brand-icons";
import {
  SIDEBAR_CHILD_SESSIONS_EVENT_NAME,
  createModelBrandIconElement,
  readSubsessionModelIconMode,
} from "./model-brand-icon-web";
import { syncPaseoThemeCssVariables, resolveActivePaseoTheme } from "./theme-web";
import { focusWorkspaceInApp, readQuickJumpPreferences } from "./web";
import {
  dropAgentRowsCoveredByWorkspaceRows,
  getCommandCenterDedupeStatus,
  recordAgentPassReceipt,
  recordShownWorkspaceRows,
  shownWorkspaceKeysForQuery,
} from "./command-center-dedupe";

export interface SessionLineageWebClient {
  call<
    TDef extends
      | typeof manageSessionLineageRpc
      | typeof openFileTargetRpc
      | typeof inspectSystemPromptRpc,
  >(
    def: TDef,
    input: RpcInput<TDef>,
  ): Promise<RpcOutput<TDef>>;
  getLocale?: () => string | undefined;
}

export interface ActiveWorkspaceAndAgent {
  workspaceId: string | null;
  agentId: string | null;
  activeSubagentId?: string | null;
}

export function normalizeWorkspaceIdKey(id?: string | null): string {
  return (id ?? "").replace(/^[^:]+:/, "").trim();
}

export interface ParsedProviderSubagentTabTestId {
  parentAgentId: string;
  subagentId: string;
}

export function parseProviderSubagentTabTestId(
  rawTestId?: string | null,
): ParsedProviderSubagentTabTestId | null {
  const prefix = "workspace-tab-provider_subagent_";
  const tid = (rawTestId ?? "").trim();
  if (!tid.startsWith(prefix)) return null;
  const rest = tid.slice(prefix.length);
  const firstUnderscore = rest.indexOf("_");
  if (firstUnderscore <= 0) return null;
  const parentLen = Number.parseInt(rest.slice(0, firstUnderscore), 10);
  if (!Number.isFinite(parentLen) || parentLen <= 0) return null;
  const parentStart = firstUnderscore + 1;
  const parentEnd = parentStart + parentLen;
  if (rest.length <= parentEnd || rest[parentEnd] !== "_") return null;
  const parentAgentId = rest.slice(parentStart, parentEnd).trim();
  const subRest = rest.slice(parentEnd + 1);
  const secondUnderscore = subRest.indexOf("_");
  if (secondUnderscore <= 0) return null;
  const subLen = Number.parseInt(subRest.slice(0, secondUnderscore), 10);
  if (!Number.isFinite(subLen) || subLen <= 0) return null;
  const subStart = secondUnderscore + 1;
  const subEnd = subStart + subLen;
  if (subRest.length < subEnd) return null;
  const subagentId = subRest.slice(subStart, subEnd).trim();
  if (!parentAgentId || !subagentId) return null;
  return { parentAgentId, subagentId };
}

export function buildProviderSubagentTabTestId(
  parentAgentId: string,
  subagentId: string,
): string {
  const p = parentAgentId.trim();
  const s = subagentId.trim();
  return `workspace-tab-provider_subagent_${p.length}_${p}_${s.length}_${s}`;
}

export function isElementInVisibleBranch(
  el: Element | null | undefined,
  win?: Window | null,
): boolean {
  if (!el) return false;
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const ownerBody = el.ownerDocument?.body as HTMLElement | null | undefined;
  const bodyRects =
    ownerBody && typeof ownerBody.getClientRects === "function"
      ? ownerBody.getClientRects()
      : null;
  if (
    bodyRects &&
    bodyRects.length > 0 &&
    typeof (el as HTMLElement).getClientRects === "function"
  ) {
    if ((el as HTMLElement).getClientRects().length === 0) {
      return false;
    }
  }
  let cur: Element | null = el;
  while (cur && (cur.nodeType === 1 || cur.nodeType === undefined)) {
    const htmlEl = cur as HTMLElement;
    if (
      htmlEl.hidden ||
      htmlEl.getAttribute?.("aria-hidden") === "true" ||
      htmlEl.getAttribute?.("data-state") === "inactive" ||
      htmlEl.style?.display === "none" ||
      htmlEl.style?.visibility === "hidden" ||
      htmlEl.classList?.contains?.("hidden")
    ) {
      return false;
    }
    if (typeof w?.getComputedStyle === "function") {
      try {
        const cs = w.getComputedStyle(htmlEl);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
          return false;
        }
      } catch {
        // Ignore in synthetic test DOMs
      }
    }
    cur = cur.parentElement;
  }
  return true;
}

export function queryFirstVisible<T extends HTMLElement = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
  win?: Window | null,
): T | null {
  if (!root || typeof root.querySelectorAll !== "function") {
    return (root as Document | null)?.querySelector?.<T>(selector) ?? null;
  }
  const all = Array.from(root.querySelectorAll<T>(selector));
  if (all.length === 0) return null;
  return all.find((el) => isElementInVisibleBranch(el, win)) ?? null;
}

export function extractCurrentWorkspaceAndAgent(
  doc?: Document | null,
  win?: Window | null,
): ActiveWorkspaceAndAgent {
  const pathname = (win?.location?.pathname ?? "").trim();
  let workspaceId: string | null = null;
  let agentId: string | null = null;
  let activeSubagentId: string | null = null;

  const wsMatch = pathname.match(/\/workspace\/([^/?#]+)/);
  if (wsMatch?.[1]) {
    try {
      workspaceId = decodeURIComponent(wsMatch[1]).trim() || null;
    } catch {
      workspaceId = wsMatch[1].trim() || null;
    }
  }

  const agMatch = pathname.match(/\/ag\/([A-Za-z0-9-]{8,})/);
  if (agMatch?.[1]) {
    agentId = agMatch[1].trim();
  }

  if (doc) {
    if (!workspaceId) {
      const selectedRow = doc.querySelector<HTMLElement>(
        '[data-testid^="sidebar-workspace-row-"][aria-selected="true"]',
      );
      const rawTestId = selectedRow?.getAttribute("data-testid") ?? "";
      const stripped = rawTestId.replace(/^sidebar-workspace-row-(?:[^:]+:)?/, "").trim();
      if (stripped.startsWith("wks_")) {
        workspaceId = stripped;
      }
    }

    const allSubagentTabs = Array.from(
      doc.querySelectorAll<HTMLElement>('[data-testid^="workspace-tab-provider_subagent_"]'),
    ).filter((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      return parseProviderSubagentTabTestId(tid) !== null;
    });
    const visibleSubagentTabs = allSubagentTabs.filter((el) =>
      isElementInVisibleBranch(el, win),
    );
    // Never fall back to hidden `allSubagentTabs` from background navigation screens
    // when the active workspace has 0 visible subagent tabs; otherwise clicking away from a
    // workspace with subagents leaks the previous workspace's `parentAgentId` into the new scope.
    const subagentTabs = visibleSubagentTabs;
    const hasVisibleSubPanel = Array.from(
      doc.querySelectorAll<HTMLElement>('[data-testid="provider-subagent-panel"]'),
    ).some((el) => isElementInVisibleBranch(el, win));
    const selectedSubagentTab =
      subagentTabs.find(
        (el) =>
          el.getAttribute("aria-selected") === "true" ||
          el.getAttribute("data-state") === "active",
      ) ??
      (subagentTabs.length === 1 && hasVisibleSubPanel
        ? subagentTabs[0]
        : null);
    if (selectedSubagentTab) {
      const parsedSubTab = parseProviderSubagentTabTestId(
        selectedSubagentTab.getAttribute("data-testid"),
      );
      if (parsedSubTab) {
        const cleanCurrentWs = normalizeWorkspaceIdKey(workspaceId);
        const knownParent = globalSessionDirectoryByAgentId.get(parsedSubTab.parentAgentId);
        const knownParentWs = normalizeWorkspaceIdKey(knownParent?.workspaceId);
        const wsCompatible =
          !cleanCurrentWs || !knownParentWs || cleanCurrentWs === knownParentWs;
        if (wsCompatible) {
          if (!agentId) {
            agentId = parsedSubTab.parentAgentId;
          }
          activeSubagentId = parsedSubTab.subagentId;
        }
      }
    }

    if (!agentId) {
      const cleanWs = (workspaceId ?? "").replace(/^[^:]+:/, "").trim();
      const allTabs = Array.from(
        doc.querySelectorAll<HTMLElement>('[data-testid^="workspace-tab-agent_"]'),
      ).filter((el) => {
        const tid = el.getAttribute("data-testid") ?? "";
        return (
          !tid.startsWith("workspace-tab-context-") &&
          !tid.startsWith("workspace-tab-menu-") &&
          !tid.startsWith("workspace-tab-tooltip-") &&
          !tid.startsWith("workspace-tab-modified-") &&
          !tid.startsWith("workspace-tab-close-")
        );
      });
      const visibleTabs = allTabs.filter((el) => isElementInVisibleBranch(el, win));
      const candidateTabs = visibleTabs.length > 0 ? visibleTabs : allTabs;
      const wsMatchedTabs = cleanWs
        ? candidateTabs.filter((el) => {
            const tid = el.getAttribute("data-testid") ?? "";
            const aid = tid.slice("workspace-tab-agent_".length).trim();
            const known = aid ? globalSessionDirectoryByAgentId.get(aid) : null;
            return !known?.workspaceId || known.workspaceId === cleanWs;
          })
        : candidateTabs;
      const tabs = wsMatchedTabs.length > 0 ? wsMatchedTabs : cleanWs ? [] : candidateTabs;
      const selectedTab =
        tabs.find(
          (el) =>
            el.getAttribute("aria-selected") === "true" ||
            el.getAttribute("data-state") === "active",
        ) ??
        (tabs.length === 1 ? tabs[0] : null);
      if (selectedTab) {
        const tid = selectedTab.getAttribute("data-testid") ?? "";
        const extracted = tid.slice("workspace-tab-agent_".length).trim();
        if (extracted) {
          agentId = extracted;
        }
      }
      if (!agentId && cleanWs) {
        const focusedTarget = extractFocusedWorkspaceTabTarget(cleanWs, win);
        if (focusedTarget?.agentId) {
          const known = globalSessionDirectoryByAgentId.get(focusedTarget.agentId);
          if (!known?.workspaceId || known.workspaceId === cleanWs) {
            agentId = focusedTarget.agentId;
          }
        }
      }
    }

    if ((!agentId || !activeSubagentId) && hasVisibleSubPanel) {
      const focusedTarget = extractFocusedWorkspaceTabTarget(workspaceId, win);
      if (focusedTarget) {
        if (!agentId && focusedTarget.agentId) {
          agentId = focusedTarget.agentId;
        }
        if (!activeSubagentId && focusedTarget.subagentId) {
          activeSubagentId = focusedTarget.subagentId;
        }
      }
    }
  }

  return { workspaceId, agentId, activeSubagentId };
}

function findReactFiber(el: Element | null): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  return key ? ((el as unknown as Record<string, any>)[key] ?? null) : null;
}

type LineageRpcResponse = RpcOutput<typeof manageSessionLineageRpc>;

export interface SessionJumpBreadcrumb {
  from: SessionLineageNode;
  toAgentId: string;
  toWorkspaceId: string;
  atMs: number;
}

const LEGACY_BREADCRUMB_STORAGE_KEY = "paseo_finder_session_jump_breadcrumb_v1";
const BREADCRUMB_STORAGE_KEY = "paseo_finder_session_jump_breadcrumb_v2";
const globalSessionDirectoryByAgentId = new Map<string, SessionLineageNode>();
const globalSessionDirectoryByWorkspaceId = new Map<string, SessionLineageNode[]>();
let jumpBreadcrumbStack: SessionJumpBreadcrumb[] = [];
let metroNavigateToAgentFn:
  | ((opts: { serverId: string; agentId: string; workspaceId?: string }) => unknown)
  | null = null;

export function clearSessionDirectoryForTests(): void {
  globalSessionDirectoryByAgentId.clear();
  globalSessionDirectoryByWorkspaceId.clear();
  jumpBreadcrumbStack = [];
  metroNavigateToAgentFn = null;
}

function upsertDirectoryNode(node: SessionLineageNode | null | undefined): void {
  if (!node || !node.agentId) return;
  const existing = globalSessionDirectoryByAgentId.get(node.agentId);
  const merged: SessionLineageNode = existing
    ? {
        ...existing,
        ...node,
        providerSessionId: node.providerSessionId ?? existing.providerSessionId ?? null,
        relationKind: node.relationKind ?? existing.relationKind,
        routedByAgentId: node.routedByAgentId ?? existing.routedByAgentId ?? null,
        briefPath: node.briefPath ?? existing.briefPath ?? null,
        reportPath: node.reportPath ?? existing.reportPath ?? null,
        reportExists: node.reportExists || existing.reportExists,
        notionUrl: node.notionUrl ?? existing.notionUrl ?? null,
        notionTaskId:
          (existing.notionTaskId?.length ?? 0) > (node.notionTaskId?.length ?? 0)
            ? existing.notionTaskId
            : (node.notionTaskId ?? existing.notionTaskId ?? null),
      }
    : {
        ...node,
        shortId: node.shortId || node.agentId.slice(0, 8),
      };
  globalSessionDirectoryByAgentId.set(merged.agentId, merged);

  if (merged.workspaceId) {
    const wsList = globalSessionDirectoryByWorkspaceId.get(merged.workspaceId) ?? [];
    const idx = wsList.findIndex((item) => item.agentId === merged.agentId);
    if (idx >= 0) {
      wsList[idx] = merged;
    } else {
      wsList.push(merged);
    }
    globalSessionDirectoryByWorkspaceId.set(merged.workspaceId, wsList);
  }
}

export function ingestSessionLineageResponse(data: LineageRpcResponse | null | undefined): void {
  if (!data) return;
  upsertDirectoryNode(data.current);
  upsertDirectoryNode(data.parent);
  upsertDirectoryNode(data.routedOrigin);
  for (const ch of data.children ?? []) upsertDirectoryNode(ch);
  for (const col of data.colleagues ?? []) upsertDirectoryNode(col);
  for (const sb of data.siblings ?? []) upsertDirectoryNode(sb);
  for (const pp of data.projectPeers ?? []) upsertDirectoryNode(pp);
  for (const dn of data.directory ?? []) upsertDirectoryNode(dn);
}

let cachedLiveMetroMap: Map<
  number,
  { isInitialized?: boolean; publicModule?: { exports?: Record<string, any> } }
> | null = null;

export function getMetroModuleList(
  win?: Window | null,
): Array<{ isInitialized?: boolean; publicModule?: { exports?: Record<string, any> } }> {
  const w = (win ?? (typeof window !== "undefined" ? window : null)) as
    | (Window & {
        __c?: unknown;
        __r?: unknown;
      })
    | null;
  if (!w) return [];

  const registry = w.__c;
  if (registry && typeof registry === "object") {
    return registry instanceof Map
      ? Array.from(registry.values())
      : Object.values(registry as Record<string, any>);
  }

  if (!cachedLiveMetroMap && typeof w.__r === "function") {
    const origMapGet = Map.prototype.get;
    try {
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (key === 0 && !cachedLiveMetroMap && this instanceof Map && this.size > 50) {
          cachedLiveMetroMap = this as unknown as Map<
            number,
            { isInitialized?: boolean; publicModule?: { exports?: Record<string, any> } }
          >;
        }
        return origMapGet.call(this, key);
      };
      try {
        (w.__r as (id: number) => unknown)(0);
      } catch {
        // ignore
      }
    } finally {
      Map.prototype.get = origMapGet;
    }
  }

  if (cachedLiveMetroMap) {
    return Array.from(cachedLiveMetroMap.values());
  }
  return [];
}

export interface ActiveTabTargetSnapshot {
  workspaceKey: string | null;
  kind: "agent" | "provider_subagent" | string | null;
  agentId: string | null;
  parentAgentId: string | null;
  subagentId: string | null;
}

function extractFocusedTargetFromLayoutEntry(
  layoutEntry: Record<string, any> | null | undefined,
  sheetEntry?: Record<string, any> | null | undefined,
): {
  kind: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  subagentId: string | null;
} | null {
  const inspectContainer = (container: Record<string, any> | null | undefined) => {
    if (!container) return null;
    const focusedPaneId = container.focusedPaneId;
    const panes = Array.isArray(container.panes) ? container.panes : [];
    const pane =
      (focusedPaneId ? panes.find((p: any) => p?.id === focusedPaneId) : null) ?? panes[0];
    if (!pane) return null;
    const tabs = Array.isArray(pane.tabs) ? pane.tabs : [];
    const activeTabId = pane.activeTabId;
    const tab = (activeTabId ? tabs.find((t: any) => t?.id === activeTabId) : null) ?? tabs[0];
    const target = tab?.target;
    if (!target || typeof target !== "object") return null;
    if (target.kind === "provider_subagent") {
      return {
        kind: "provider_subagent",
        agentId: String(target.parentAgentId ?? "").trim() || null,
        parentAgentId: String(target.parentAgentId ?? "").trim() || null,
        subagentId: String(target.subagentId ?? "").trim() || null,
      };
    }
    if (target.kind === "agent") {
      return {
        kind: "agent",
        agentId: String(target.agentId ?? "").trim() || null,
        parentAgentId: String(target.agentId ?? "").trim() || null,
        subagentId: null,
      };
    }
    return {
      kind: String(target.kind ?? "") || null,
      agentId: null,
      parentAgentId: null,
      subagentId: null,
    };
  };

  if (sheetEntry?.open) {
    const fromSheet = inspectContainer(sheetEntry);
    if (fromSheet) return fromSheet;
  }
  return inspectContainer(layoutEntry);
}

export function extractFocusedWorkspaceTabTarget(
  workspaceId?: string | null,
  win?: Window | null,
): ActiveTabTargetSnapshot | null {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const rawWs = (workspaceId ?? "").trim();
  const cleanWs = rawWs.replace(/^local:/, "").trim();
  const candidateKeys = cleanWs ? [`local:${cleanWs}`, cleanWs] : [];

  const modules = getMetroModuleList(w);
  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (typeof exp?.useWorkspaceLayoutStore?.getState === "function") {
      try {
        const st = exp.useWorkspaceLayoutStore.getState();
        const layoutByWs: Record<string, any> = st?.layoutByWorkspace ?? {};
        const sheetsByWs: Record<string, any> = st?.sheetsByWorkspace ?? {};
        const keysToTry =
          candidateKeys.length > 0 ? candidateKeys : Object.keys(layoutByWs);
        for (const k of keysToTry) {
          const hit = extractFocusedTargetFromLayoutEntry(layoutByWs[k], sheetsByWs[k]);
          if (hit) {
            return { workspaceKey: k, ...hit };
          }
        }
      } catch {
        // ignore
      }
    }
  }

  try {
    const rawJson = w?.localStorage?.getItem("workspace-layout-state");
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      const st = parsed?.state ?? parsed;
      const layoutByWs: Record<string, any> = st?.layoutByWorkspace ?? {};
      const sheetsByWs: Record<string, any> = st?.sheetsByWorkspace ?? {};
      const keysToTry =
        candidateKeys.length > 0 ? candidateKeys : Object.keys(layoutByWs);
      for (const k of keysToTry) {
        const hit = extractFocusedTargetFromLayoutEntry(layoutByWs[k], sheetsByWs[k]);
        if (hit) {
          return { workspaceKey: k, ...hit };
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function resolveActiveServerId(
  win?: Window | null,
  hint?: { workspaceId?: string | null; agentId?: string | null },
): string {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const cleanWs = (hint?.workspaceId ?? "").replace(/^[^:]+:/, "").trim();
  const cleanAg = (hint?.agentId ?? "").trim();
  const modules = getMetroModuleList(w);
  let firstServerId = "";
  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (typeof exp?.useSessionStore?.getState === "function") {
      try {
        const sessions: Record<string, any> = exp.useSessionStore.getState()?.sessions ?? {};
        for (const [srvId, sess] of Object.entries(sessions)) {
          if (!srvId) continue;
          if (!firstServerId) firstServerId = srvId;
          if (cleanAg && sess?.agents?.has?.(cleanAg)) return srvId;
          if (cleanWs && sess?.workspaces?.has?.(cleanWs)) return srvId;
        }
      } catch {
        // ignore
      }
    }
  }
  if (firstServerId) return firstServerId;
  const pathMatch = (w?.location?.pathname ?? "").match(/^\/h\/([^/]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  return "local";
}

export function openWorkspaceTargetTabViaStore(
  opts: {
    workspaceId?: string | null;
    parentAgentId: string;
    subagentId?: string | null;
  },
  win?: Window | null,
): boolean {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const parentAgentId = opts.parentAgentId.trim();
  if (!parentAgentId) return false;
  const subagentId = (opts.subagentId ?? "").trim() || null;
  const rawWs = (opts.workspaceId ?? "").trim();
  const cleanWs = rawWs.replace(/^[^:]+:/, "").trim();
  const serverId = resolveActiveServerId(w, { workspaceId: cleanWs, agentId: parentAgentId });

  const modules = getMetroModuleList(w);
  let resolvedStoreSubagentId: string | null = subagentId;
  if (subagentId) {
    const cleanSubId = subagentId.replace(/^vec-subagent:/i, "").trim();
    let hasSubagentStoreDescriptors = false;
    let matchedDescriptorId: string | null = null;
    for (const mod of modules) {
      if (!mod || mod.isInitialized !== true) continue;
      const exp = mod.publicModule?.exports;
      if (typeof exp?.useProviderSubagentStore?.getState === "function") {
        try {
          const subStore = exp.useProviderSubagentStore.getState();
          const descriptors: Map<string, any> | undefined = subStore?.descriptors;
          if (descriptors instanceof Map) {
            hasSubagentStoreDescriptors = true;
            for (const key of descriptors.keys()) {
              const parts = String(key).split("\0");
              const keyParent = parts[1] ?? "";
              const keySub = parts[2] ?? "";
              const normKeySub = keySub.replace(/^vec-subagent:/i, "").trim();
              if (
                keyParent === parentAgentId &&
                (normKeySub === cleanSubId || keySub === subagentId)
              ) {
                matchedDescriptorId = keySub;
                break;
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
    if (hasSubagentStoreDescriptors) {
      if (!matchedDescriptorId) {
        return false;
      }
      resolvedStoreSubagentId = matchedDescriptorId;
    }
  }

  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (typeof exp?.useWorkspaceLayoutStore?.getState === "function") {
      try {
        const st = exp.useWorkspaceLayoutStore.getState();
        if (typeof st?.openTab === "function") {
          const layoutByWs: Record<string, any> = st?.layoutByWorkspace ?? {};
          const suffixMatchKey = cleanWs
            ? Object.keys(layoutByWs).find((k) => k === `${serverId}:${cleanWs}` || k.endsWith(`:${cleanWs}`))
            : undefined;
          const existingKey =
            suffixMatchKey ??
            (cleanWs && layoutByWs[`${serverId}:${cleanWs}`] ? `${serverId}:${cleanWs}` : null) ??
            (cleanWs && layoutByWs[`local:${cleanWs}`] ? `local:${cleanWs}` : null) ??
            (cleanWs && layoutByWs[cleanWs] ? cleanWs : null) ??
            (cleanWs ? `${serverId}:${cleanWs}` : null) ??
            Object.keys(layoutByWs)[0] ??
            null;
          if (existingKey) {
            const target = resolvedStoreSubagentId
              ? {
                  kind: "provider_subagent",
                  parentAgentId,
                  subagentId: resolvedStoreSubagentId,
                }
              : {
                  kind: "agent",
                  agentId: parentAgentId,
                };
            st.openTab({
              workspaceKey: existingKey,
              target,
            });
            return true;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (!subagentId && metroNavigateToAgentFn) {
    try {
      metroNavigateToAgentFn({
        serverId,
        agentId: parentAgentId,
        workspaceId: cleanWs || undefined,
      });
      return true;
    } catch {
      // ignore
    }
  }

  return false;
}

export function syncSessionDirectoryFromMetro(win?: Window | null): number {
  const modules = getMetroModuleList(win);
  if (modules.length === 0) return 0;

  let syncedCount = 0;
  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;

    if (typeof exp.navigateToAgent === "function") {
      metroNavigateToAgentFn = exp.navigateToAgent;
    }

    if (typeof exp.useSessionStore?.getState === "function") {
      try {
        const state = exp.useSessionStore.getState();
        const sessions = state?.sessions ?? {};
        for (const session of Object.values(sessions) as Array<Record<string, any>>) {
          if (!session) continue;
          const workspacesMap: Map<string, any> | undefined = session.workspaces;
          const projectsMap: Map<string, any> | undefined = session.projects;
          const agentsMap: Map<string, any> | undefined = session.agents;
          if (!agentsMap || typeof agentsMap.values !== "function") continue;

          for (const ag of agentsMap.values()) {
            if (!ag?.id) continue;
            const aid = String(ag.id).trim();
            const wsId = String(ag.workspaceId ?? "").trim();
            const ws = wsId && workspacesMap?.get ? workspacesMap.get(wsId) : null;
            const projId = String(ws?.projectId ?? ag.projectPlacement?.projectId ?? "").trim() || null;
            const proj = projId && projectsMap?.get ? projectsMap.get(projId) : null;
            const projectName =
              String(
                proj?.projectCustomName ??
                  proj?.projectDisplayName ??
                  ws?.projectCustomName ??
                  ws?.projectDisplayName ??
                  "",
              ).trim() || null;
            const agentTitle = String(ag.title ?? "").trim() || aid.slice(0, 8);
            const workspaceTitle =
              String(ws?.title ?? "").trim() ||
              (ws?.name && ws.name !== "main" ? String(ws.name) : agentTitle);
            const isArchived = Boolean(ag.archivedAt || (ws?.archivedAt && !ws?.pinnedAt));
            const rawStatus = String(ag.status ?? "idle").trim().toLowerCase();
            const status = isArchived
              ? "archived"
              : ag.turn?.phase === "open" || rawStatus === "running"
                ? "running"
                : rawStatus === "failed" || rawStatus === "error"
                  ? "failed"
                  : "done";

            const rawBrief = String(ag.labels?.brief ?? "").trim();
            const briefMatch = rawBrief.match(/^intake-\d+-\d+-([0-9a-f]{8})-/i);
            const extractedNotionTaskId = briefMatch?.[1] ? briefMatch[1].toLowerCase() : null;

            upsertDirectoryNode({
              agentId: aid,
              shortId: aid.slice(0, 8),
              agentTitle,
              workspaceId: wsId,
              workspaceTitle,
              projectId: projId,
              projectName,
              status,
              provider: String(ag.provider ?? "antigravity"),
              model: "default",
              providerSessionId: null,
              createdAt:
                ag.createdAt instanceof Date
                  ? ag.createdAt.toISOString()
                  : typeof ag.createdAt === "string"
                    ? ag.createdAt
                    : null,
              updatedAt:
                ag.lastActivityAt instanceof Date
                  ? ag.lastActivityAt.toISOString()
                  : typeof ag.lastActivityAt === "string"
                    ? ag.lastActivityAt
                    : null,
              briefPath: null,
              reportPath: null,
              reportExists: false,
              notionUrl: null,
              notionTaskId: extractedNotionTaskId,
            });
            syncedCount += 1;
          }
        }
      } catch {
        // Ignore store inspection errors
      }
    }
  }
  return syncedCount;
}

export function resolveSessionReference(
  rawToken: string | null | undefined,
  excludeAgentId?: string | null,
): SessionLineageNode | null {
  if (!rawToken) return null;
  let cleaned = rawToken
    .trim()
    .replace(/^[`"'(<\[]+|[`"')>\],.;:!?]+$/g, "")
    .trim();
  if (!cleaned) return null;

  cleaned = cleaned
    .replace(/^conversation:\/\//i, "")
    .replace(/^paseo:\/\/(?:agent|workspace)\//i, "")
    .replace(/^(?:agent|workspace):[^:]+:/i, "")
    .replace(/^local:/i, "")
    .replace(/^#/, "")
    .trim();

  if (!cleaned || cleaned.length < 6) return null;
  const lower = cleaned.toLowerCase();

  // 1. Workspace ID lookup (e.g. wks_76550e777429eb04)
  if (lower.startsWith("wks_")) {
    for (const [wsId, list] of globalSessionDirectoryByWorkspaceId.entries()) {
      if (wsId.toLowerCase() === lower || wsId.toLowerCase().startsWith(lower)) {
        const candidate = list.find((n) => n.agentId !== excludeAgentId) ?? list[0] ?? null;
        if (candidate && candidate.agentId !== excludeAgentId) return candidate;
      }
    }
    return null;
  }

  // 2. Must look like a UUID or 7..16 char hex prefix (e.g. fa22464, fa224642, or full UUID)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lower);
  const isHexPrefix = /^[0-9a-f]{7,16}$/i.test(lower);
  if (!isUuid && !isHexPrefix) return null;

  const exact = globalSessionDirectoryByAgentId.get(lower);
  if (exact && exact.agentId !== excludeAgentId) return exact;

  for (const node of globalSessionDirectoryByAgentId.values()) {
    if (node.agentId === excludeAgentId) continue;
    const aidLower = node.agentId.toLowerCase();
    if (aidLower === lower || aidLower.startsWith(lower)) {
      return node;
    }
    const pSidLower = (node.providerSessionId ?? "").toLowerCase();
    if (pSidLower && (pSidLower === lower || pSidLower.startsWith(lower))) {
      return node;
    }
  }

  // 3. Check if UUID or hex prefix/suffix matches a Notion Task ID (e.g. 413e1b43-2393-815a-ae85-f013049cb5fb or 96e2e779)
  const lowerPlain = lower.replace(/-/g, "");
  const notionCandidates: SessionLineageNode[] = [];
  for (const node of globalSessionDirectoryByAgentId.values()) {
    if (node.agentId === excludeAgentId) continue;
    const rawNotion = (node.notionTaskId ?? "").trim().toLowerCase();
    if (!rawNotion) continue;
    const notionPlain = rawNotion.replace(/-/g, "");
    if (
      rawNotion === lower ||
      notionPlain === lowerPlain ||
      (lowerPlain.length >= 7 &&
        (notionPlain.startsWith(lowerPlain) || notionPlain.endsWith(lowerPlain))) ||
      (notionPlain.length >= 7 && lowerPlain.endsWith(notionPlain))
    ) {
      notionCandidates.push(node);
    }
  }
  if (notionCandidates.length > 0) {
    notionCandidates.sort((a, b) => {
      const aHasBrief = a.briefPath ? 0 : 1;
      const bHasBrief = b.briefPath ? 0 : 1;
      if (aHasBrief !== bHasBrief) return aHasBrief - bHasBrief;
      const aFullUuid = (a.notionTaskId?.length ?? 0) >= 32 ? 0 : 1;
      const bFullUuid = (b.notionTaskId?.length ?? 0) >= 32 ? 0 : 1;
      if (aFullUuid !== bFullUuid) return aFullUuid - bFullUuid;
      const aArch = a.status === "archived" ? 1 : 0;
      const bArch = b.status === "archived" ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      return String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
        String(a.updatedAt ?? a.createdAt ?? ""),
      );
    });
    return notionCandidates[0];
  }

  // 4. Also check if hex prefix matches a workspaceId suffix (wks_<hex>)
  for (const [wsId, list] of globalSessionDirectoryByWorkspaceId.entries()) {
    const strippedWs = wsId.toLowerCase().replace(/^wks_/, "");
    if (strippedWs.length >= 7 && (strippedWs === lower || strippedWs.startsWith(lower))) {
      const candidate = list.find((n) => n.agentId !== excludeAgentId) ?? list[0] ?? null;
      if (candidate && candidate.agentId !== excludeAgentId) return candidate;
    }
  }

  return null;
}

function loadJumpBreadcrumbs(win?: Window | null): SessionJumpBreadcrumb[] {
  try {
    win?.sessionStorage?.removeItem?.(LEGACY_BREADCRUMB_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  if (jumpBreadcrumbStack.length > 0) return jumpBreadcrumbStack;
  try {
    const raw = win?.sessionStorage?.getItem(BREADCRUMB_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        jumpBreadcrumbStack = parsed.slice(-16);
      }
    }
  } catch {
    // Ignore storage errors
  }
  return jumpBreadcrumbStack;
}

function saveJumpBreadcrumbs(win?: Window | null): void {
  try {
    win?.sessionStorage?.setItem(
      BREADCRUMB_STORAGE_KEY,
      JSON.stringify(jumpBreadcrumbStack.slice(-16)),
    );
  } catch {
    // Ignore storage errors
  }
}

export function recordSessionJump(
  from: SessionLineageNode | null | undefined,
  to: Pick<SessionLineageNode, "agentId" | "workspaceId">,
  win?: Window | null,
): void {
  if (!from || !from.agentId) return;
  if (from.agentId === to.agentId && from.workspaceId === to.workspaceId) return;
  const stack = loadJumpBreadcrumbs(win);
  const filtered = stack.filter(
    (entry) =>
      !(entry.toAgentId === to.agentId && entry.from.agentId === from.agentId),
  );
  filtered.push({
    from,
    toAgentId: to.agentId,
    toWorkspaceId: to.workspaceId,
    atMs: Date.now(),
  });
  jumpBreadcrumbStack = filtered.slice(-16);
  saveJumpBreadcrumbs(win);
}

export function getReturnBreadcrumbForSession(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
  win?: Window | null,
): SessionLineageNode | null {
  const cleanWsId = (workspaceId ?? "").replace(/^[^:]+:/, "").trim();
  const stack = loadJumpBreadcrumbs(win);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (!entry) continue;
    const entryToWs = (entry.toWorkspaceId ?? "").replace(/^[^:]+:/, "").trim();
    const entryFromWs = (entry.from.workspaceId ?? "").replace(/^[^:]+:/, "").trim();
    if (
      (agentId && entry.toAgentId === agentId) ||
      (cleanWsId && entryToWs === cleanWsId && entryFromWs !== cleanWsId)
    ) {
      if (entry.from.agentId !== agentId) {
        return globalSessionDirectoryByAgentId.get(entry.from.agentId) ?? entry.from;
      }
    }
  }
  return null;
}

export function clearReturnBreadcrumbForSession(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined,
  win?: Window | null,
): void {
  const cleanWsId = (workspaceId ?? "").replace(/^[^:]+:/, "").trim();
  const stack = loadJumpBreadcrumbs(win);
  jumpBreadcrumbStack = stack.filter((entry) => {
    const entryToWs = (entry.toWorkspaceId ?? "").replace(/^[^:]+:/, "").trim();
    return !(
      (agentId && entry.toAgentId === agentId) ||
      (cleanWsId && entryToWs === cleanWsId)
    );
  });
  saveJumpBreadcrumbs(win);
}

/**
 * New on every evaluation of this module. The search hooks are stamped with it, so a reloaded
 * copy of the plugin replaces the hooks an earlier copy installed instead of leaving the old
 * behaviour in place until the app restarts.
 */
const COMMAND_CENTER_PATCH_INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function isCommandCenterAgentDedupeEnabled(win?: Window | null): boolean {
  try {
    return readQuickJumpPreferences(win?.localStorage ?? null).dedupeCommandCenterAgentRows;
  } catch {
    return true;
  }
}

export function patchCommandCenterSearch(win?: Window | null): boolean {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const modules = getMetroModuleList(w);
  if (modules.length === 0) return false;

  if (w && (w as any).__paseoFinderCommandCenterDedupe?.instance !== COMMAND_CENTER_PATCH_INSTANCE) {
    (w as any).__paseoFinderCommandCenterDedupe = {
      instance: COMMAND_CENTER_PATCH_INSTANCE,
      status: () => getCommandCenterDedupeStatus(isCommandCenterAgentDedupeEnabled(w)),
    };
  }

  syncSessionDirectoryFromMetro(w);
  let patchedAny = false;

  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (!exp || typeof exp !== "object") continue;

    // 1. Patch CommandCenter built-in agent search (filterAndRankBuiltInResults)
    if (
      typeof exp.filterAndRankBuiltInResults === "function" &&
      exp.__paseoSessionIdSearchPatched !== COMMAND_CENTER_PATCH_INSTANCE
    ) {
      // Wrap Paseo's own function, kept from the first patch. A hook left by a copy that did not
      // keep it (flag `true`) is wrapped as it is; it only repeats the id enrichment.
      const origFilterBuiltIn =
        exp.__paseoSessionIdSearchOriginal ?? exp.filterAndRankBuiltInResults;
      exp.__paseoSessionIdSearchOriginal = origFilterBuiltIn;
      exp.filterAndRankBuiltInResults = function patchedFilterAndRankBuiltInResults(
        items: any[],
        query: string,
        getFields: (row: any) => { visible: string[]; hidden: string[] },
      ) {
        if (!Array.isArray(items)) {
          return origFilterBuiltIn.call(this, items, query, getFields);
        }
        syncSessionDirectoryFromMetro(w);
        const qTrim = (query ?? "").trim();
        const qTokens = qTrim
          .toLowerCase()
          .split(/\s+/)
          .map((t) => t.replace(/^#/, ""))
          .filter(Boolean);

        const matchesAgentIdTokens = (aid: string, wsId: string, provId: string): boolean => {
          const aidLower = aid.toLowerCase();
          const wsLower = wsId.toLowerCase();
          const provLower = provId.toLowerCase();
          return qTokens.some(
            (tok) =>
              tok.length >= 4 &&
              (aidLower.startsWith(tok) ||
                wsLower.includes(tok) ||
                (provLower && provLower.startsWith(tok))),
          );
        };

        // One session, one row: see command-center-dedupe.ts for the rule.
        let searchableItems = items;
        if (items.some((row) => row?.kind === "agent")) {
          const rawQuery = String(query ?? "");
          const shownWorkspaceKeys = isCommandCenterAgentDedupeEnabled(w)
            ? shownWorkspaceKeysForQuery(rawQuery)
            : null;
          const deduped = dropAgentRowsCoveredByWorkspaceRows(items, shownWorkspaceKeys);
          searchableItems = deduped.kept;
          recordAgentPassReceipt(rawQuery, deduped.kept.length, deduped.hidden);
        }

        const enrichedItems = searchableItems.map((row) => {
          if (row?.kind !== "agent" || !row.agent?.id) return row;
          const aid = String(row.agent.id).trim();
          const wsId = String(row.agent.workspaceId ?? "").trim();
          const dirNode = globalSessionDirectoryByAgentId.get(aid);
          const provId = String(dirNode?.providerSessionId ?? "").trim();
          const idHit = matchesAgentIdTokens(aid, wsId, provId);

          const short7 = aid.slice(0, 7);
          const subtitle = String(row.subtitle ?? "").trim();
          const badge = `#${short7}`;
          const nextSubtitle = !idHit
            ? subtitle
            : subtitle.includes(short7)
              ? subtitle
              : subtitle
                ? `${subtitle} \u00b7 ${badge}`
                : badge;
          const origRun = row.run;
          return {
            ...row,
            subtitle: nextSubtitle,
            run:
              typeof origRun === "function" && idHit
                ? () => {
                    const cur = extractCurrentWorkspaceAndAgent(w?.document, w);
                    const fromNode =
                      (cur.agentId ? globalSessionDirectoryByAgentId.get(cur.agentId) : null) ??
                      (cur.workspaceId
                        ? globalSessionDirectoryByWorkspaceId.get(cur.workspaceId)?.[0]
                        : null);
                    recordSessionJump(
                      fromNode,
                      {
                        agentId: aid,
                        workspaceId: wsId,
                      },
                      w,
                    );
                    return origRun();
                  }
                : origRun,
          };
        });

        const wrappedGetFields = (row: any) => {
          const base =
            typeof getFields === "function"
              ? getFields(row)
              : { visible: [row?.title ?? "", row?.subtitle ?? ""], hidden: [] };
          if (row?.kind !== "agent" || !row.agent?.id) return base;
          const aid = String(row.agent.id).trim();
          const short7 = aid.slice(0, 7);
          const short8 = aid.slice(0, 8);
          const wsId = String(row.agent.workspaceId ?? "").trim();
          const dirNode = globalSessionDirectoryByAgentId.get(aid);
          const provId = String(dirNode?.providerSessionId ?? "").trim();
          const idHit = matchesAgentIdTokens(aid, wsId, provId);
          const extraHidden = [
            ...(idHit
              ? [aid, short7, short8, `#${short7}`, `#${short8}`, wsId, wsId.replace(/^wks_/, ""), provId]
              : []),
            dirNode?.projectName ?? "",
            dirNode?.workspaceTitle ?? "",
          ].filter(Boolean);
          return {
            visible: [row.title ?? "", row.subtitle ?? ""],
            hidden: [...(base.hidden ?? []), ...extraHidden],
          };
        };

        return origFilterBuiltIn.call(this, enrichedItems, query, wrappedGetFields);
      };
      exp.__paseoSessionIdSearchPatched = COMMAND_CENTER_PATCH_INSTANCE;
      patchedAny = true;
    }

    // 2. Patch CommandCenter workspace search (filterAndRankWorkspaces)
    if (
      typeof exp.filterAndRankWorkspaces === "function" &&
      exp.__paseoWorkspaceIdSearchPatched !== COMMAND_CENTER_PATCH_INSTANCE
    ) {
      const origFilterWorkspaces =
        exp.__paseoWorkspaceIdSearchOriginal ?? exp.filterAndRankWorkspaces;
      exp.__paseoWorkspaceIdSearchOriginal = origFilterWorkspaces;
      exp.filterAndRankWorkspaces = function patchedFilterAndRankWorkspaces(
        workspaces: any[],
        query: string,
      ) {
        if (!Array.isArray(workspaces)) {
          return origFilterWorkspaces.call(this, workspaces, query);
        }
        const rawQuery = String(query ?? "");
        const recordShown = <T,>(shown: T): T => {
          recordShownWorkspaceRows(rawQuery, Array.isArray(shown) ? shown : []);
          return shown;
        };
        syncSessionDirectoryFromMetro(w);
        const qTrim = (query ?? "").trim();
        if (!qTrim) {
          return recordShown(origFilterWorkspaces.call(this, workspaces, query));
        }
        const qTokens = qTrim
          .toLowerCase()
          .split(/\s+/)
          .map((t) => t.replace(/^#/, ""))
          .filter(Boolean);

        const enrichedWorkspaces = workspaces.map((ws) => {
          const wsId = String(ws?.workspaceId ?? "").trim();
          if (!wsId) return ws;
          const wsAgents = globalSessionDirectoryByWorkspaceId.get(wsId) ?? [];
          let matchedBadge: string | null = null;
          let matchedAgentNode: SessionLineageNode | null = null;

          for (const tok of qTokens) {
            if (tok.length < 4) continue;
            if (
              wsId.toLowerCase() === tok ||
              wsId.toLowerCase().replace(/^wks_/, "").startsWith(tok)
            ) {
              matchedBadge = wsId;
              break;
            }
            const agHit = wsAgents.find(
              (a) =>
                a.agentId.toLowerCase().startsWith(tok) ||
                (a.providerSessionId && a.providerSessionId.toLowerCase().startsWith(tok)),
            );
            if (agHit) {
              matchedAgentNode = agHit;
              matchedBadge = `#${agHit.agentId.slice(0, 7)}`;
              break;
            }
          }

          if (!matchedBadge) return ws;
          const subtitle = String(ws.subtitle ?? "").trim();
          const nextSubtitle = subtitle.includes(matchedBadge)
            ? subtitle
            : subtitle
              ? `${subtitle} \u00b7 ${matchedBadge}`
              : matchedBadge;
          const origRun = ws.run;
          return {
            ...ws,
            subtitle: nextSubtitle,
            run:
              typeof origRun === "function"
                ? () => {
                    const cur = extractCurrentWorkspaceAndAgent(w?.document, w);
                    const fromNode =
                      (cur.agentId ? globalSessionDirectoryByAgentId.get(cur.agentId) : null) ??
                      (cur.workspaceId
                        ? globalSessionDirectoryByWorkspaceId.get(cur.workspaceId)?.[0]
                        : null);
                    recordSessionJump(
                      fromNode,
                      {
                        agentId: matchedAgentNode?.agentId ?? "",
                        workspaceId: wsId,
                      },
                      w,
                    );
                    if (matchedAgentNode && metroNavigateToAgentFn) {
                      return metroNavigateToAgentFn({
                        serverId: String(ws.serverId ?? "local"),
                        agentId: matchedAgentNode.agentId,
                        workspaceId: wsId,
                      });
                    }
                    return origRun();
                  }
                : origRun,
          };
        });

        return recordShown(origFilterWorkspaces.call(this, enrichedWorkspaces, query));
      };
      exp.__paseoWorkspaceIdSearchPatched = COMMAND_CENTER_PATCH_INSTANCE;
      patchedAny = true;
    }
  }

  return patchedAny;
}

export function navigateToLineageNode(
  node: Pick<
    SessionLineageNode,
    "workspaceId" | "agentId" | "projectId" | "projectName"
  >,
  doc?: Document | null,
  win?: Window | null,
  fromOrigin?: SessionLineageNode | { recordBreadcrumb?: boolean } | null,
): boolean {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!d || !w) return false;

  syncSessionDirectoryFromMetro(w);
  const currentActive = extractCurrentWorkspaceAndAgent(d, w);
  const isOptionsObj =
    fromOrigin !== null &&
    typeof fromOrigin === "object" &&
    !("agentId" in fromOrigin);
  const shouldRecordBreadcrumb = isOptionsObj
    ? fromOrigin.recordBreadcrumb !== false
    : true;
  const explicitOriginNode =
    fromOrigin && "agentId" in fromOrigin ? fromOrigin : null;

  const cleanCurrentWs = (currentActive.workspaceId ?? "").replace(/^[^:]+:/, "").trim();
  const resolvedOrigin =
    explicitOriginNode ??
    (currentActive.agentId ? globalSessionDirectoryByAgentId.get(currentActive.agentId) : null) ??
    (cleanCurrentWs
      ? globalSessionDirectoryByWorkspaceId.get(cleanCurrentWs)?.[0]
      : null) ??
    null;

  if (shouldRecordBreadcrumb && resolvedOrigin && (node.agentId || node.workspaceId)) {
    recordSessionJump(
      resolvedOrigin,
      {
        agentId: node.agentId,
        workspaceId: node.workspaceId,
      },
      w,
    );
  }

  const scheduleLineageResync = () => {
    for (const delay of [50, 160, 380]) {
      setTimeout(() => {
        externalSyncLineageFn?.(true);
      }, delay);
    }
  };

  // Fast path 0: Use Paseo's native Metro navigateToAgent when navigating to a known agentId
  if (node.agentId && metroNavigateToAgentFn) {
    try {
      const serverId = resolveActiveServerId(w, {
        workspaceId: node.workspaceId,
        agentId: node.agentId,
      });
      metroNavigateToAgentFn({
        serverId,
        agentId: node.agentId,
        workspaceId: node.workspaceId || undefined,
      });
    } catch {
      // Fall through to DOM navigation
    }
  }

  // Fast path 0B: Also open/focus the agent tab in useWorkspaceLayoutStore so multi-agent workspaces immediately switch tabs
  if (node.agentId) {
    openWorkspaceTargetTabViaStore(
      {
        workspaceId: node.workspaceId,
        parentAgentId: node.agentId,
        subagentId: null,
      },
      w,
    );
  }

  // Fast path 1: If Paseo's native subagent track pill is mounted for this agentId, click it
  if (node.agentId) {
    const trackBtn = d.querySelector<HTMLElement>(
      `[data-testid="subagent-track-${node.agentId}"]`,
    );
    if (trackBtn) {
      trackBtn.click();
      scheduleLineageResync();
      return true;
    }
  }

  const focused = focusWorkspaceInApp(
    node.workspaceId,
    node.projectId,
    d as never,
    w as never,
    { projectName: node.projectName },
  );

  const trySelectAgentTab = () => {
    if (!node.agentId) return;
    const tab = d.querySelector<HTMLElement>(
      `[data-testid="workspace-tab-agent_${node.agentId}"]`,
    );
    if (tab) {
      if (tab.getAttribute("aria-selected") !== "true") {
        tab.click();
      }
      return;
    }
    const nativeTrack = d.querySelector<HTMLElement>(
      `[data-testid="subagent-track-${node.agentId}"]`,
    );
    if (nativeTrack) {
      nativeTrack.click();
    }
  };

  trySelectAgentTab();
  for (const delay of [90, 220, 460]) {
    setTimeout(trySelectAgentTab, delay);
  }
  scheduleLineageResync();
  return focused;
}

export function cleanSessionDisplayTitle(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^(?:d\s+|done:\s*)/i, "").trim() || trimmed;
}

export function enhanceTimelineAgentMentions(
  data: RpcOutput<typeof manageSessionLineageRpc> | null,
  doc?: Document | null,
  win?: Window | null,
): SessionLineageNode[] {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!d || !w) return [];

  ingestSessionLineageResponse(data);
  syncSessionDirectoryFromMetro(w);

  const currentActive = extractCurrentWorkspaceAndAgent(d, w);
  const currentId = data?.current?.agentId ?? currentActive.agentId ?? null;
  const currentNode =
    data?.current ??
    (currentId ? globalSessionDirectoryByAgentId.get(currentId) ?? null : null);
  const tokens = syncPaseoThemeCssVariables(d as never, w as never);
  const zh = isChineseLocale(w.navigator?.language);

  const referencedById = new Map<string, SessionLineageNode>();

  const statusColorFor = (status: string): string => {
    if (status === "running") return tokens.statusWarning;
    if (status === "failed" || status === "error") return tokens.destructive;
    return tokens.statusSuccess;
  };

  const statusWordFor = (status: string): string => {
    if (status === "running") return zh ? "运行中" : "Running";
    if (status === "archived") return zh ? "已归档" : "Archived";
    if (status === "failed" || status === "error") return zh ? "失败" : "Failed";
    return zh ? "已完成" : "Done";
  };

  // 0. Wrap bare plain-text session IDs inside timeline message bubbles (e.g. "Paseo agent af81b8f0") into <code> so they become interactive pills
  const timelineRoot = queryFirstVisible<HTMLElement>(d, '[data-testid="agent-timeline"]', w);
  if (timelineRoot && typeof d.createTreeWalker === "function") {
    const walker = d.createTreeWalker(timelineRoot, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodesToProcess: Text[] = [];
    let curText = walker.nextNode();
    while (curText) {
      const parentEl = curText.parentElement;
      if (
        parentEl &&
        !parentEl.closest(
          'code, pre, a, button, [role="button"], [data-testid="paseo-finder-session-lineage-bar"], [data-testid="agent-composer"], [data-testid="message-input-root"]',
        )
      ) {
        const val = curText.nodeValue ?? "";
        if (
          val.length >= 7 &&
          (/(?:^|[\s(,#])[0-9a-f]{7,8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?=$|[\s),.:;!?])/i.test(
            val,
          ) ||
            /\bwks_[0-9a-zA-Z_-]{4,}\b/.test(val))
        ) {
          textNodesToProcess.push(curText as Text);
        }
      }
      curText = walker.nextNode();
    }

    const tokenRe =
      /\b(wks_[0-9a-zA-Z_-]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,8})\b/gi;
    for (const tNode of textNodesToProcess) {
      const text = tNode.nodeValue ?? "";
      tokenRe.lastIndex = 0;
      let match: RegExpExecArray | null = null;
      let hasKnownHit = false;
      while ((match = tokenRe.exec(text)) !== null) {
        if (resolveSessionReference(match[1], currentId)) {
          hasKnownHit = true;
          break;
        }
      }
      if (!hasKnownHit || !tNode.parentNode) continue;

      tokenRe.lastIndex = 0;
      const frag = d.createDocumentFragment();
      let lastIdx = 0;
      while ((match = tokenRe.exec(text)) !== null) {
        const tok = match[1];
        const hit = resolveSessionReference(tok, currentId);
        if (!hit) continue;
        if (match.index > lastIdx) {
          frag.appendChild(d.createTextNode(text.slice(lastIdx, match.index)));
        }
        const codeWrapper = d.createElement("code");
        codeWrapper.setAttribute("data-vec-raw-token", tok);
        codeWrapper.textContent = tok;
        frag.appendChild(codeWrapper);
        lastIdx = match.index + tok.length;
      }
      if (lastIdx > 0) {
        if (lastIdx < text.length) {
          frag.appendChild(d.createTextNode(text.slice(lastIdx)));
        }
        tNode.parentNode.replaceChild(frag, tNode);
      }
    }
  }

  // 1. Upgrade inline <code> elements that reference a known Paseo agent ID / shortId / workspace ID
  // Strict visibility & message container scoping: never fall back to hidden/inactive screen elements when visibleCodeEls is empty.
  const MESSAGE_CONTAINER_SELECTOR =
    '[data-testid="assistant-message"], [data-testid^="assistant-message-"], [data-testid="user-message"], [data-testid^="user-message-"], [data-testid="agent-timeline"]';
  const hasMessageContainers = Boolean(d.querySelector(MESSAGE_CONTAINER_SELECTOR));
  const allCodeEls = Array.from(d.querySelectorAll<HTMLElement>("code"));
  const codeEls = allCodeEls.filter(
    (el) =>
      isElementInVisibleBranch(el, w) &&
      (!hasMessageContainers || Boolean(el.closest(MESSAGE_CONTAINER_SELECTOR))),
  );
  for (const codeEl of codeEls) {
    if (codeEl.closest("pre")) continue;
    if (
      codeEl.closest(
        '[data-testid="agent-composer"], [data-testid="message-input-root"], [data-testid="paseo-finder-session-lineage-bar"], [data-testid="command-center-panel"]',
      )
    ) {
      continue;
    }

    const rawToken =
      codeEl.getAttribute("data-vec-raw-token") ?? (codeEl.textContent ?? "").trim();
    if (!rawToken || rawToken.length < 6 || rawToken.length > 64) continue;

    const matched = resolveSessionReference(rawToken, currentId);
    if (!matched) continue;

    referencedById.set(matched.agentId, matched);

    const short7 = matched.agentId.slice(0, 7);
    const rawDisplayTitle = matched.agentTitle || matched.workspaceTitle || short7;
    const displayTitle = cleanSessionDisplayTitle(rawDisplayTitle) || short7;
    const shortPreview =
      displayTitle.length > 22 ? `${displayTitle.slice(0, 22)}\u2026` : displayTitle;
    const codeModelIconsMode = readSubsessionModelIconMode(w);
    const codeBrandCmp = compareSessionBrands(
      { provider: matched.provider, model: matched.model },
      currentNode ? { provider: currentNode.provider, model: currentNode.model } : null,
    );
    const pillSig = `${matched.agentId}:${matched.status}:${matched.provider}:${matched.model}:${codeModelIconsMode}:${shortPreview}:${tokens.name}`;

    if (codeEl.getAttribute("data-vec-pill-sig") !== pillSig) {
      codeEl.setAttribute("data-vec-raw-token", rawToken);
      codeEl.setAttribute("data-vec-session-pill", matched.agentId);
      codeEl.setAttribute("data-vec-pill-sig", pillSig);
      codeEl.setAttribute("data-testid", `paseo-finder-inline-session-pill-${short7}`);
      if (codeBrandCmp.child.brand !== "unknown") {
        codeEl.setAttribute("data-brand", codeBrandCmp.child.brand);
      }
      codeEl.setAttribute("role", "button");
      codeEl.tabIndex = 0;
      const projPart = matched.projectName ? ` \u00b7 ${matched.projectName}` : "";
      const modelPart =
        codeBrandCmp.child.brand !== "unknown" ? ` \u00b7 ${codeBrandCmp.child.summary}` : "";
      const statusLabel = statusWordFor(matched.status);
      codeEl.title = zh
        ? `\u70b9\u51fb\u8df3\u8f6c\u81f3\u4f1a\u8bdd: ${displayTitle} (#${short7})${modelPart}${projPart} \u00b7 \u72b6\u6001: ${statusLabel}`
        : `Click to jump to session: ${displayTitle} (#${short7})${modelPart}${projPart} \u00b7 Status: ${statusLabel}`;

      Object.assign(codeEl.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "1px 7px",
        margin: "0 2px",
        borderRadius: "5px",
        border: `1px solid ${tokens.border}`,
        backgroundColor: tokens.surface1,
        color: tokens.foreground,
        cursor: "pointer",
        verticalAlign: "baseline",
        textDecoration: "none",
        lineHeight: "1.4",
      });

      codeEl.innerHTML = "";
      const normCodeStatus = (matched.status ?? "").toLowerCase();
      const brandEl = createModelBrandIconElement({
        doc: d,
        comparison: codeBrandCmp,
        mode: codeModelIconsMode,
        theme: tokens,
        sizePx: 12,
        statusPip:
          normCodeStatus === "running"
            ? "running"
            : normCodeStatus === "error" || normCodeStatus === "failed"
              ? "error"
              : normCodeStatus === "attention" || normCodeStatus === "waiting_permission"
                ? "attention"
                : "none",
        pipCutoutBg: tokens.surface1,
      });

      const dot = d.createElement("span");
      dot.setAttribute("data-vec-session-pill-dot", "1");
      Object.assign(dot.style, {
        width: "5px",
        height: "5px",
        borderRadius: "999px",
        backgroundColor: statusColorFor(matched.status),
        flexShrink: "0",
      });

      const idSpan = d.createElement("span");
      idSpan.textContent = rawToken;
      Object.assign(idSpan.style, {
        fontWeight: "600",
        color: tokens.foreground,
      });

      const titleSpan = d.createElement("span");
      titleSpan.setAttribute("data-vec-session-pill-meta", "1");
      titleSpan.textContent = `\u00b7 ${shortPreview} \u2197`;
      Object.assign(titleSpan.style, {
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: "0.88em",
        fontWeight: "400",
        color: tokens.foregroundMuted,
      });

      if (brandEl) {
        brandEl.setAttribute("data-vec-session-pill-brand", "1");
        dot.style.display = "none";
        codeEl.appendChild(dot);
        codeEl.appendChild(brandEl);
      } else {
        codeEl.appendChild(dot);
      }
      codeEl.appendChild(idSpan);
      codeEl.appendChild(titleSpan);
    }

    if (codeEl.getAttribute("data-vec-pill-bound") !== matched.agentId) {
      codeEl.setAttribute("data-vec-pill-bound", matched.agentId);
      const targetNode = matched;
      const triggerJump = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(targetNode, d, w, currentNode);
      };
      codeEl.addEventListener("click", triggerJump);
      codeEl.addEventListener("keydown", (ke: KeyboardEvent) => {
        if (ke.key === "Enter" || ke.key === " ") {
          triggerJump(ke);
        }
      });
    }
  }

  // 2. Upgrade <a href="conversation://..."> or <a href="paseo://..."> links in chat messages
  const allAnchorEls = Array.from(d.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const anchorEls = allAnchorEls.filter(
    (el) =>
      isElementInVisibleBranch(el, w) &&
      (!hasMessageContainers || Boolean(el.closest(MESSAGE_CONTAINER_SELECTOR))),
  );
  for (const anchor of anchorEls) {
    const href = (anchor.getAttribute("href") ?? "").trim();
    if (
      !href.startsWith("conversation://") &&
      !href.startsWith("paseo://agent/") &&
      !href.startsWith("paseo://workspace/")
    ) {
      continue;
    }
    const matched = resolveSessionReference(href, currentId);
    if (!matched) continue;
    referencedById.set(matched.agentId, matched);

    const short7 = matched.agentId.slice(0, 7);
    anchor.setAttribute("data-testid", `paseo-finder-inline-session-link-${short7}`);
    anchor.title = zh
      ? `\u70b9\u51fb\u8df3\u8f6c\u81f3\u4f1a\u8bdd: ${matched.agentTitle} (#${short7})`
      : `Click to jump to session: ${matched.agentTitle} (#${short7})`;
    if (anchor.getAttribute("data-vec-link-bound") !== matched.agentId) {
      anchor.setAttribute("data-vec-link-bound", matched.agentId);
      const targetNode = matched;
      anchor.addEventListener(
        "click",
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          navigateToLineageNode(targetNode, d, w, currentNode);
        },
        true,
      );
    }
  }

  return Array.from(referencedById.values());
}

export function enhanceTimelineSentByButtons(
  data: RpcOutput<typeof manageSessionLineageRpc> | null,
  doc?: Document | null,
  win?: Window | null,
): number {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!d || !w || !data?.current) return 0;

  const currentId = data.current.agentId;
  const peerCandidates: SessionLineageNode[] = [
    ...(data.children ?? []),
    ...(data.parent ? [data.parent] : []),
    ...(data.routedOrigin ? [data.routedOrigin] : []),
    ...(data.colleagues ?? []),
    ...(data.siblings ?? []),
  ].filter((n) => n.agentId && n.agentId !== currentId);

  let healedCount = 0;
  if (peerCandidates.length > 0) {
    const allButtons = Array.from(d.querySelectorAll<HTMLButtonElement>("button"));
    const buttons = allButtons.filter((el) => isElementInVisibleBranch(el, w));
    for (const btn of buttons) {
      const rawText = (btn.textContent ?? "").trim();
      if (!rawText.startsWith("Sent by ") && !rawText.startsWith("发送自 ")) {
        continue;
      }

      let cur = findReactFiber(btn);
      let senderFiber: Record<string, any> | null = null;
      for (let depth = 0; depth < 12 && cur; depth++, cur = cur.return) {
        const p = cur.memoizedProps ?? cur.pendingProps;
        if (p && typeof p === "object" && p.sender && typeof p.sender.id === "string") {
          senderFiber = cur;
          break;
        }
      }

      const senderObj =
        (senderFiber?.memoizedProps?.sender ?? senderFiber?.pendingProps?.sender) as
          | { id?: string; title?: string }
          | undefined;
      const isSelfSender =
        (senderObj?.id && senderObj.id === currentId) ||
        rawText === `Sent by ${data.current.agentTitle}` ||
        rawText === `发送自 ${data.current.agentTitle}`;

      if (!isSelfSender) continue;

      const msgContainer =
        btn.closest('[data-testid^="user-message-"]') ??
        btn.parentElement?.parentElement ??
        btn.parentElement;
      const msgText = (msgContainer?.textContent ?? "").toLowerCase();

      const matchedPeer =
        peerCandidates.find((cand) => {
          const stem = cand.briefPath
            ? cand.briefPath.split("/").pop()?.replace(/\.md$/i, "").toLowerCase()
            : "";
          if (stem && msgText.includes(stem)) return true;
          const titleTail = cand.agentTitle.split(":").pop()?.trim().toLowerCase() ?? "";
          if (titleTail.length >= 6 && msgText.includes(titleTail)) return true;
          return false;
        }) ??
        (peerCandidates.length === 1 ? peerCandidates[0] : null);

      if (!matchedPeer) continue;

      if (senderFiber) {
        for (const f of [senderFiber, senderFiber.alternate]) {
          if (!f) continue;
          for (const propBag of [f.memoizedProps, f.pendingProps]) {
            if (propBag?.sender && typeof propBag.sender === "object") {
              propBag.sender.id = matchedPeer.agentId;
              propBag.sender.title = matchedPeer.agentTitle;
            }
          }
        }
      }

      const prefix = rawText.startsWith("发送自 ") ? "发送自 " : "Sent by ";
      for (const childNode of Array.from(btn.childNodes)) {
        if (childNode.nodeType === 3 && (childNode.textContent ?? "").includes(prefix.trim())) {
          childNode.textContent = `${prefix}${matchedPeer.agentTitle}`;
        }
      }
      if ((btn.textContent ?? "").trim() === rawText) {
        const spans = Array.from(btn.querySelectorAll("span"));
        const targetSpan = spans[spans.length - 1];
        if (targetSpan) {
          targetSpan.textContent = `${prefix}${matchedPeer.agentTitle}`;
        }
      }

      if (btn.getAttribute("data-vec-healed-sender") !== matchedPeer.agentId) {
        btn.setAttribute("data-vec-healed-sender", matchedPeer.agentId);
        const peerTarget = matchedPeer;
        btn.addEventListener("click", () => {
          setTimeout(() => {
            navigateToLineageNode(peerTarget, d, w);
          }, 30);
        });
      }
      healedCount += 1;
    }
  }

  // Step 2: For spawned sessions whose first user message says "From a session outside Paseo, via antigravity-ops peers spawn"
  // (or "From agent <id>, via antigravity-ops peers spawn") without a native "Sent by" button, inject a clickable jump pill
  // both inline on "a session outside Paseo" and in `[data-testid="user-message-trailing-row"]`.
  const originTarget =
    data.parent ??
    data.routedOrigin ??
    getReturnBreadcrumbForSession(data.current.workspaceId, data.current.agentId, w);
  if (originTarget && originTarget.agentId && originTarget.agentId !== currentId) {
    const tokens = syncPaseoThemeCssVariables(d as never, w as never);
    const zh = isChineseLocale(w.navigator?.language);
    const originIsUrl = /^https?:\/\//i.test((originTarget.agentTitle ?? "").trim());
    const rawOriginTitle =
      originIsUrl &&
      originTarget.workspaceTitle &&
      !/^https?:\/\//i.test(originTarget.workspaceTitle.trim())
        ? originTarget.workspaceTitle
        : originTarget.workspaceTitle || originTarget.agentTitle || originTarget.shortId;
    const cleanOriginTitle = cleanSessionDisplayTitle(rawOriginTitle) || originTarget.shortId;
    const shortOriginTitle =
      cleanOriginTitle.length > 28 ? `${cleanOriginTitle.slice(0, 28)}\u2026` : cleanOriginTitle;
    const isIntake = data.current.relationKind === "intake-routed" || !data.parent;

    const allUserMessages = Array.from(
      d.querySelectorAll<HTMLElement>('[data-testid="user-message"], [data-testid^="user-message-"]'),
    ).filter((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      return tid !== "user-message-trailing-row" && tid !== "user-message-timestamp";
    });
    const userMessages = allUserMessages.filter((el) => isElementInVisibleBranch(el, w));

    for (const msgEl of userMessages) {
      const msgText = msgEl.textContent ?? "";
      if (
        !msgText.includes("peers spawn") &&
        !msgText.includes("From a session outside Paseo") &&
        !msgText.startsWith("From agent ")
      ) {
        continue;
      }

      // 2A. Upgrade literal "a session outside Paseo" text inside the bubble into an inline clickable session pill
      if (
        msgText.includes("a session outside Paseo") &&
        !msgEl.querySelector('[data-testid="paseo-finder-inline-outside-origin-pill"]') &&
        typeof d.createTreeWalker === "function"
      ) {
        const walker = d.createTreeWalker(msgEl, 4 /* NodeFilter.SHOW_TEXT */);
        let curT = walker.nextNode();
        while (curT) {
          const val = curT.nodeValue ?? "";
          const idx = val.indexOf("a session outside Paseo");
          if (idx >= 0 && curT.parentNode) {
            const frag = d.createDocumentFragment();
            if (idx > 0) {
              frag.appendChild(d.createTextNode(val.slice(0, idx)));
            }
            const pill = d.createElement("code");
            pill.setAttribute("data-testid", "paseo-finder-inline-outside-origin-pill");
            pill.setAttribute("role", "button");
            pill.tabIndex = 0;
            pill.title = zh
              ? `点击返回来源会话: ${cleanOriginTitle} (#${originTarget.shortId})`
              : `Click to jump back to origin session: ${cleanOriginTitle} (#${originTarget.shortId})`;
            Object.assign(pill.style, {
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "1px 7px",
              margin: "0 2px",
              borderRadius: "5px",
              border: `1px solid ${tokens.border}`,
              backgroundColor: tokens.surface1,
              color: tokens.foreground,
              cursor: "pointer",
              verticalAlign: "baseline",
              fontFamily:
                'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              fontSize: "0.9em",
              fontWeight: "500",
            });
            const dot = d.createElement("span");
            Object.assign(dot.style, {
              width: "5px",
              height: "5px",
              borderRadius: "999px",
              backgroundColor:
                originTarget.status === "running" ? tokens.statusWarning : tokens.statusSuccess,
              flexShrink: "0",
            });
            const labelSpan = d.createElement("span");
            labelSpan.textContent = `${shortOriginTitle} ↗`;
            pill.appendChild(dot);
            pill.appendChild(labelSpan);
            const onJump = (ev: Event) => {
              ev.preventDefault();
              ev.stopPropagation();
              navigateToLineageNode(originTarget, d, w, data.current);
            };
            pill.addEventListener("click", onJump);
            pill.addEventListener("keydown", (ke: KeyboardEvent) => {
              if (ke.key === "Enter" || ke.key === " ") onJump(ke);
            });
            frag.appendChild(pill);
            const afterIdx = idx + "a session outside Paseo".length;
            if (afterIdx < val.length) {
              frag.appendChild(d.createTextNode(val.slice(afterIdx)));
            }
            curT.parentNode.replaceChild(frag, curT);
            healedCount += 1;
            break;
          }
          curT = walker.nextNode();
        }
      }

      // 2B. Ensure `[data-testid="user-message-trailing-row"]` has a clickable "Routed from / Sent by" jump button
      const trailingRow =
        msgEl.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]') ??
        msgEl.parentElement?.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]');
      if (trailingRow) {
        const hasExistingBtn = Array.from(trailingRow.querySelectorAll("button")).some((b) => {
          const t = (b.textContent ?? "").trim();
          return (
            b.getAttribute("data-testid") === "paseo-finder-spawn-origin-btn" ||
            t.startsWith("Sent by ") ||
            t.startsWith("发送自 ") ||
            t.startsWith("Routed from ") ||
            t.startsWith("派发自 ")
          );
        });
        if (!hasExistingBtn) {
          const originBtn = d.createElement("button");
          originBtn.type = "button";
          originBtn.setAttribute("data-testid", "paseo-finder-spawn-origin-btn");
          originBtn.title = zh
            ? `点击返回来源会话: ${cleanOriginTitle} (#${originTarget.shortId})`
            : `Click to jump back to origin session: ${cleanOriginTitle} (#${originTarget.shortId})`;
          originBtn.textContent = isIntake
            ? zh
              ? `派发自 ${shortOriginTitle} ↗`
              : `Routed from ${shortOriginTitle} ↗`
            : zh
              ? `发送自 ${shortOriginTitle} ↗`
              : `Sent by ${shortOriginTitle} ↗`;
          Object.assign(originBtn.style, {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "1px 6px",
            marginRight: "6px",
            borderRadius: "999px",
            border: `1px solid ${tokens.border}`,
            backgroundColor: tokens.surface1,
            color: tokens.foregroundMuted,
            fontSize: "11px",
            fontWeight: "500",
            cursor: "pointer",
            lineHeight: "1.3",
          });
          originBtn.addEventListener("pointerenter", () => {
            originBtn.style.backgroundColor = tokens.surface2;
            originBtn.style.color = tokens.foreground;
          });
          originBtn.addEventListener("pointerleave", () => {
            originBtn.style.backgroundColor = tokens.surface1;
            originBtn.style.color = tokens.foregroundMuted;
          });
          originBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            navigateToLineageNode(originTarget, d, w, data.current);
          });
          trailingRow.insertBefore(originBtn, trailingRow.firstChild);
          healedCount += 1;
        }
      }
    }
  }

  // Step 3: For peer messages delivered via `antigravity-ops peers send` (`From the ... session (Paseo agent <id>)`
  // or `Reply route: antigravity-ops peers send <id>`) that lack a native `Sent by` button in `[data-testid="user-message-trailing-row"]`,
  // inject a clickable `[Sent by <Colleague> ↗]` button so the recipient can jump directly to the sender from the message footer.
  {
    const tokens = syncPaseoThemeCssVariables(d as never, w as never);
    const zh = isChineseLocale(w.navigator?.language);
    const allUserMessages = Array.from(
      d.querySelectorAll<HTMLElement>('[data-testid="user-message"], [data-testid^="user-message-"]'),
    ).filter((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      return tid !== "user-message-trailing-row" && tid !== "user-message-timestamp";
    });
    const visibleUserMessages = allUserMessages.filter((el) => isElementInVisibleBranch(el, w));

    for (const msgEl of visibleUserMessages) {
      const msgText = msgEl.textContent ?? "";
      const peerSendMatch =
        msgText.match(/peers\s+send\s+([0-9a-f]{7,36})/i) ??
        msgText.match(/Paseo\s+agent\s+([0-9a-f]{7,36})/i) ??
        msgText.match(/^From\s+agent\s+([0-9a-f]{7,36})\b/i);
      const senderTok = peerSendMatch?.[1]?.trim();
      if (!senderTok) continue;

      const senderNode =
        resolveSessionReference(senderTok, currentId) ??
        peerCandidates.find(
          (c) =>
            c.agentId.toLowerCase().startsWith(senderTok.toLowerCase()) ||
            c.shortId.toLowerCase().startsWith(senderTok.toLowerCase()),
        ) ??
        null;
      if (!senderNode || senderNode.agentId === currentId) continue;

      const trailingRow =
        msgEl.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]') ??
        msgEl.parentElement?.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]');
      if (!trailingRow) continue;

      const hasExistingBtn = Array.from(trailingRow.querySelectorAll("button")).some((b) => {
        const t = (b.textContent ?? "").trim();
        return (
          b.getAttribute("data-testid") === "paseo-finder-spawn-origin-btn" ||
          b.getAttribute("data-testid") === `paseo-finder-peer-sender-btn-${senderNode.shortId}` ||
          t.startsWith("Sent by ") ||
          t.startsWith("发送自 ") ||
          t.startsWith("Routed from ") ||
          t.startsWith("派发自 ")
        );
      });
      if (hasExistingBtn) continue;

      const rawSenderTitle =
        senderNode.workspaceTitle && !/^https?:\/\//i.test(senderNode.workspaceTitle.trim())
          ? senderNode.workspaceTitle
          : senderNode.agentTitle || senderNode.shortId;
      const cleanSenderTitle = cleanSessionDisplayTitle(rawSenderTitle) || senderNode.shortId;
      const shortSenderTitle =
        cleanSenderTitle.length > 28 ? `${cleanSenderTitle.slice(0, 28)}\u2026` : cleanSenderTitle;

      const peerBtn = d.createElement("button");
      peerBtn.type = "button";
      peerBtn.setAttribute("data-testid", `paseo-finder-peer-sender-btn-${senderNode.shortId}`);
      peerBtn.title = zh
        ? `点击跳转至发送方协作会话: ${cleanSenderTitle} (#${senderNode.shortId})`
        : `Click to jump to sender session: ${cleanSenderTitle} (#${senderNode.shortId})`;
      peerBtn.textContent = zh
        ? `发送自 ${shortSenderTitle} ↗`
        : `Sent by ${shortSenderTitle} ↗`;
      Object.assign(peerBtn.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "1px 6px",
        marginRight: "6px",
        borderRadius: "999px",
        border: `1px solid ${tokens.border}`,
        backgroundColor: tokens.surface1,
        color: tokens.foregroundMuted,
        fontSize: "11px",
        fontWeight: "500",
        cursor: "pointer",
        lineHeight: "1.3",
      });
      peerBtn.addEventListener("pointerenter", () => {
        peerBtn.style.backgroundColor = tokens.surface2;
        peerBtn.style.color = tokens.foreground;
      });
      peerBtn.addEventListener("pointerleave", () => {
        peerBtn.style.backgroundColor = tokens.surface1;
        peerBtn.style.color = tokens.foregroundMuted;
      });
      peerBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(senderNode, d, w, data.current);
      });
      trailingRow.insertBefore(peerBtn, trailingRow.firstChild);
      healedCount += 1;
    }
  }

  return healedCount;
}

let externalJumpToParentFn: (() => Promise<boolean>) | null = null;
let externalReconcileTitlesFn: (() => Promise<LineageRpcResponse | null>) | null = null;
let externalSyncLineageFn: ((force?: boolean) => void) | null = null;

export async function triggerJumpToParentSession(): Promise<boolean> {
  if (!externalJumpToParentFn) return false;
  return externalJumpToParentFn();
}

export async function triggerReconcileSidebarWorkspaceTitles(): Promise<LineageRpcResponse | null> {
  if (!externalReconcileTitlesFn) return null;
  return externalReconcileTitlesFn();
}

export function openSystemPromptViewer(
  client: SessionLineageWebClient,
  doc: Document,
  win: Window,
  zh: boolean,
) {
  const existingModal = doc.getElementById("paseo-finder-system-prompt-modal-root");
  if (existingModal) {
    existingModal.remove();
    return;
  }

  const theme = resolveActivePaseoTheme(doc, win);

  const root = doc.createElement("div");
  root.id = "paseo-finder-system-prompt-modal-root";
  root.setAttribute("data-testid", "paseo-finder-system-prompt-modal-root");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "99999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor:
      theme.colorScheme === "dark" ? "rgba(0, 0, 0, 0.72)" : "rgba(0, 0, 0, 0.45)",
    backdropFilter: "blur(2px)",
    padding: "20px",
  });

  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-testid", "paseo-finder-system-prompt-modal");
  Object.assign(dialog.style, {
    backgroundColor: theme.surface0,
    color: theme.foreground,
    border: `1px solid ${theme.border}`,
    borderRadius: "10px",
    boxShadow: theme.shadowLg || "0 12px 32px rgba(0, 0, 0, 0.25)",
    width: "100%",
    maxWidth: "760px",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  });

  const header = doc.createElement("div");
  Object.assign(header.style, {
    padding: "14px 18px",
    borderBottom: `1px solid ${theme.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  });

  const titleBox = doc.createElement("div");
  const title = doc.createElement("div");
  title.style.fontWeight = "600";
  title.style.fontSize = "15px";
  title.textContent = zh
    ? "系统起始提示词与全局环境指令"
    : "Active System Starter Prompt & Instructions";

  const subtitle = doc.createElement("div");
  subtitle.style.fontSize = "12px";
  subtitle.style.color = theme.foregroundMuted;
  subtitle.style.marginTop = "2px";
  subtitle.textContent = zh ? "加载中..." : "Loading configuration...";

  titleBox.appendChild(title);
  titleBox.appendChild(subtitle);
  header.appendChild(titleBox);

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("data-testid", "paseo-finder-system-prompt-close");
  Object.assign(closeBtn.style, {
    border: "none",
    background: "transparent",
    fontSize: "20px",
    cursor: "pointer",
    padding: "0 6px",
    color: theme.foregroundMuted,
    lineHeight: "1",
  });
  closeBtn.addEventListener("click", () => root.remove());
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const body = doc.createElement("div");
  Object.assign(body.style, {
    padding: "16px 18px",
    overflowY: "auto",
    flex: "1",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  });

  const loading = doc.createElement("div");
  loading.textContent = zh
    ? "正在从 ~/.paseo/config.json 读取配置..."
    : "Reading from ~/.paseo/config.json...";
  loading.style.fontSize = "13px";
  loading.style.color = theme.foregroundMuted;
  body.appendChild(loading);
  dialog.appendChild(body);

  const footer = doc.createElement("div");
  Object.assign(footer.style, {
    padding: "12px 18px",
    borderTop: `1px solid ${theme.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.surface1,
  });

  const footerLeft = doc.createElement("div");
  footerLeft.style.fontSize = "12px";
  footerLeft.style.color = theme.foregroundMuted;

  const footerRight = doc.createElement("div");
  footerRight.style.display = "flex";
  footerRight.style.gap = "8px";

  footer.appendChild(footerLeft);
  footer.appendChild(footerRight);
  dialog.appendChild(footer);

  root.appendChild(dialog);
  root.addEventListener("click", (e) => {
    if (e.target === root) root.remove();
  });
  doc.body.appendChild(root);

  void client
    .call(inspectSystemPromptRpc, { action: "inspect" })
    .then((res) => {
      loading.remove();
      subtitle.textContent = `${res.configPath} · ${res.charCount} chars · ~${res.estimatedTokens} tokens · ${res.sections.length} sections`;
      footerLeft.textContent = res.mtime
        ? `${zh ? "修改时间" : "Updated"}: ${new Date(res.mtime).toLocaleString()}`
        : "";

      const pre = doc.createElement("pre");
      Object.assign(pre.style, {
        margin: "0",
        padding: "12px",
        borderRadius: "6px",
        backgroundColor: theme.surface1,
        color: theme.foreground,
        fontSize: "12px",
        lineHeight: "1.5",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        border: `1px solid ${theme.border}`,
        maxHeight: "45vh",
        overflowY: "auto",
        userSelect: "text",
      });
      pre.textContent =
        res.appendSystemPrompt ||
        res.systemPrompt ||
        (zh ? "(空提示词)" : "(Empty prompt)");
      body.appendChild(pre);

      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = zh ? "复制内容" : "Copy Content";
      Object.assign(copyBtn.style, {
        padding: "6px 12px",
        borderRadius: "6px",
        border: `1px solid ${theme.border}`,
        backgroundColor: theme.surface0,
        color: theme.foreground,
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "500",
      });
      copyBtn.addEventListener("click", () => {
        void win.navigator.clipboard
          .writeText(res.appendSystemPrompt || res.systemPrompt)
          .then(() => {
            copyBtn.textContent = zh ? "已复制!" : "Copied!";
            setTimeout(() => {
              copyBtn.textContent = zh ? "复制内容" : "Copy Content";
            }, 1500);
          });
      });
      footerRight.appendChild(copyBtn);

      const openBtn = doc.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = zh ? "在编辑器打开" : "Open in Editor";
      Object.assign(openBtn.style, {
        padding: "6px 12px",
        borderRadius: "6px",
        border: `1px solid ${theme.border}`,
        backgroundColor: theme.surface0,
        color: theme.foreground,
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "500",
      });
      openBtn.addEventListener("click", () => {
        void client.call(openFileTargetRpc, {
          path: res.configPath,
          target: "system-default",
        });
      });
      footerRight.appendChild(openBtn);
    })
    .catch((err) => {
      loading.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    });
}

export function installDesktopSessionLineageEnhancer(
  client: SessionLineageWebClient,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  patchCommandCenterSearch(window);

  const cacheByKey = new Map<
    string,
    {
      data: LineageRpcResponse;
      fetchedAtMs: number;
      inFlight?: Promise<LineageRpcResponse | null>;
    }
  >();

  let lastRouteKey = "";
  let lastActiveSessionNode: SessionLineageNode | null = null;
  let activePopoverSection: "children" | "colleagues" | "refs" | null = null;
  let rafId: number | null = null;
  let pollId: ReturnType<typeof setInterval> | null = null;
  let initialReconcileDone = false;

  const isZh = (): boolean =>
    isChineseLocale(client.getLocale?.() ?? window.navigator?.language);

  const fetchLineage = async (
    workspaceId: string | null,
    agentId: string | null,
    force = false,
    action: "inspect" | "reconcile" = "inspect",
  ): Promise<LineageRpcResponse | null> => {
    const key = `${workspaceId ?? ""}:${agentId ?? ""}`;
    if (!workspaceId && !agentId && action !== "reconcile") return null;

    const cached = cacheByKey.get(key);
    const now = Date.now();
    if (!force && action === "inspect" && cached && now - cached.fetchedAtMs < 6_000) {
      return cached.data;
    }
    if (!force && action === "inspect" && cached?.inFlight) {
      return cached.inFlight;
    }

    const promise = client
      .call(manageSessionLineageRpc, {
        action,
        workspaceId: workspaceId ?? undefined,
        agentId: agentId ?? undefined,
        autoFixTitles: true,
        source: "lineage-bar",
      })
      .then((res) => {
        ingestSessionLineageResponse(res);
        cacheByKey.set(key, { data: res, fetchedAtMs: Date.now() });
        return res;
      })
      .catch(() => null);

    if (cached) {
      cached.inFlight = promise;
    } else {
      cacheByKey.set(key, {
        data: {
          ok: true,
          action: "inspect",
          current: null,
          parent: null,
          siblings: [],
          children: [],
          projectPeers: [],
          directory: [],
          reconcileSummary: {
            untitledFound: 0,
            renamedCount: 0,
            unlinkedFound: 0,
            linkedCount: 0,
            renamedWorkspaces: [],
          },
          message: "",
          durationMs: 0,
        },
        fetchedAtMs: 0,
        inFlight: promise,
      });
    }
    return promise;
  };

  externalJumpToParentFn = async () => {
    const { workspaceId, agentId } = extractCurrentWorkspaceAndAgent(document, window);
    const returnCrumb = getReturnBreadcrumbForSession(workspaceId, agentId, window);
    if (returnCrumb) {
      clearReturnBreadcrumbForSession(workspaceId, agentId, window);
      return navigateToLineageNode(returnCrumb, document, window, {
        recordBreadcrumb: false,
      });
    }
    const data = await fetchLineage(workspaceId, agentId, true, "inspect");
    const jumpOrigin = data?.parent ?? data?.routedOrigin ?? null;
    if (jumpOrigin) {
      return navigateToLineageNode(jumpOrigin, document, window);
    }
    return false;
  };

  externalReconcileTitlesFn = async () => {
    const { workspaceId, agentId } = extractCurrentWorkspaceAndAgent(document, window);
    const res = await fetchLineage(workspaceId, agentId, true, "reconcile");
    if (res) {
      renderLineageBar(res);
    }
    return res;
  };

  const statusDotColor = (
    status: string,
    tokens: ReturnType<typeof syncPaseoThemeCssVariables>,
  ): string => {
    if (status === "running") return tokens.statusWarning;
    if (status === "failed" || status === "error") return tokens.destructive;
    return tokens.statusSuccess;
  };

  const formatNodeStatusWord = (status: string, zh: boolean): string => {
    if (status === "running") return zh ? "运行中" : "Running";
    if (status === "archived") return zh ? "已归档" : "Archived";
    if (status === "failed" || status === "error") return zh ? "失败" : "Failed";
    return zh ? "已完成" : "Done";
  };

  const renderLineageBar = (data: LineageRpcResponse | null) => {
    patchCommandCenterSearch(window);
    ingestSessionLineageResponse(data);
    enhanceTimelineSentByButtons(data, document, window);
    const referencedPeers = enhanceTimelineAgentMentions(data, document, window);

    const allExistingBars = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="paseo-finder-session-lineage-bar"]'),
    );
    const hasParent = Boolean(data?.parent);
    const hasRoutedOrigin = Boolean(data?.routedOrigin);
    const children = data?.children ?? [];
    const rawColleagues = data?.colleagues ?? [];
    const siblings = data?.siblings ?? [];
    const current = data?.current ?? null;
    const { workspaceId: curWksId, agentId: curAgentId } =
      extractCurrentWorkspaceAndAgent(document, window);
    if (current?.agentId && current?.workspaceId) {
      // Track the currently rendered session, but NEVER passively call recordSessionJump here:
      // a return breadcrumb (`↩ Back · ...`) is only recorded when the user explicitly clicks a
      // cross-session link (inline mention pill, commit pill, lineage bar pill, or #id search),
      // never when creating a new workspace or switching sessions in the sidebar.
      lastActiveSessionNode = current;
    }
    const returnBreadcrumb = getReturnBreadcrumbForSession(
      current?.workspaceId ?? curWksId,
      current?.agentId ?? curAgentId,
      window,
    );

    const childAgentIdSet = new Set(children.map((c) => c.agentId));
    const colleagues = rawColleagues.filter(
      (col) =>
        col.agentId !== data?.parent?.agentId &&
        col.agentId !== data?.routedOrigin?.agentId &&
        col.agentId !== returnBreadcrumb?.agentId &&
        !childAgentIdSet.has(col.agentId),
    );
    const colleagueAgentIdSet = new Set(colleagues.map((c) => c.agentId));
    const uniqueReferencedPeers = referencedPeers.filter(
      (peer) =>
        peer.agentId !== data?.parent?.agentId &&
        peer.agentId !== data?.routedOrigin?.agentId &&
        peer.agentId !== returnBreadcrumb?.agentId &&
        !childAgentIdSet.has(peer.agentId) &&
        !colleagueAgentIdSet.has(peer.agentId),
    );

    const hasBriefOrReport = Boolean(
      current?.briefPath || current?.reportPath || current?.notionUrl,
    );

    const hasCrossWorkspaceLineage = Boolean(
      (data?.parent && data.parent.workspaceId !== current?.workspaceId) ||
        (data?.routedOrigin && data.routedOrigin.workspaceId !== current?.workspaceId) ||
        children.some((c) => c.workspaceId !== current?.workspaceId) ||
        colleagues.length > 0,
    );

    const hasReturnOrPeerMentions = Boolean(
      returnBreadcrumb || uniqueReferencedPeers.length > 0 || colleagues.length > 0,
    );

    if (
      !data ||
      (!hasParent &&
        !hasRoutedOrigin &&
        children.length === 0 &&
        colleagues.length === 0 &&
        !hasBriefOrReport &&
        !hasReturnOrPeerMentions) ||
      (!hasCrossWorkspaceLineage &&
        !hasBriefOrReport &&
        !hasReturnOrPeerMentions)
    ) {
      for (const b of allExistingBars) b.remove();
      return;
    }

    const composer = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="agent-composer"], [data-testid="message-input-root"]',
      window,
    );
    const hostParent = composer?.parentElement ?? null;
    if (!hostParent || !composer) {
      for (const b of allExistingBars) b.remove();
      return;
    }

    const displayLabelFor = (node: SessionLineageNode): string => {
      const agentIsUrl = /^https?:\/\//i.test((node.agentTitle ?? "").trim());
      if (
        agentIsUrl &&
        node.workspaceTitle &&
        !/^https?:\/\//i.test(node.workspaceTitle.trim())
      ) {
        return cleanSessionDisplayTitle(node.workspaceTitle) || node.shortId;
      }
      const raw =
        (node.workspaceId && node.workspaceId === current?.workspaceId) ||
        node.relationKind === "intake-routed" ||
        node.agentTitle.startsWith("Intake ·")
          ? node.agentTitle || node.workspaceTitle
          : node.workspaceTitle || node.agentTitle;
      return cleanSessionDisplayTitle(raw) || node.shortId;
    };

    const zh = isZh();
    const tokens = syncPaseoThemeCssVariables(document as never, window as never);

    let bar = allExistingBars.find((b) => b.parentElement === hostParent) ?? null;
    for (const b of allExistingBars) {
      if (b !== bar) b.remove();
    }
    if (!bar || bar.parentElement !== hostParent) {
      bar = document.createElement("div");
      bar.setAttribute("data-testid", "paseo-finder-session-lineage-bar");
      hostParent.insertBefore(bar, composer);
    }

    const modelIconsMode = readSubsessionModelIconMode(window);
    const sig = JSON.stringify({
      cur: current?.agentId ?? curAgentId,
      curBrand: `${current?.provider ?? ""}:${current?.model ?? ""}`,
      ret: returnBreadcrumb
        ? `${returnBreadcrumb.agentId}:${returnBreadcrumb.provider}:${returnBreadcrumb.model}:${displayLabelFor(returnBreadcrumb)}`
        : null,
      par: data.parent?.agentId,
      parTitle: data.parent ? `${data.parent.provider}:${data.parent.model}:${displayLabelFor(data.parent)}` : null,
      orig: data.routedOrigin?.agentId,
      origTitle: data.routedOrigin ? `${data.routedOrigin.provider}:${data.routedOrigin.model}:${displayLabelFor(data.routedOrigin)}` : null,
      chCount: children.length,
      chIds: children.slice(0, 6).map((c) => `${c.shortId}:${c.status}:${c.provider}:${c.model}:${displayLabelFor(c)}`),
      colCount: colleagues.length,
      colIds: colleagues.slice(0, 6).map((c) => `${c.shortId}:${c.status}:${c.provider}:${c.model}:${displayLabelFor(c)}`),
      refCount: uniqueReferencedPeers.length,
      refIds: uniqueReferencedPeers
        .slice(0, 6)
        .map((p) => `${p.shortId}:${p.status}:${p.provider}:${p.model}:${displayLabelFor(p)}`),
      sibCount: siblings.length,
      brief: current?.briefPath,
      report: current?.reportExists,
      open: activePopoverSection,
      modelIconsMode,
      zh,
      theme: tokens.name,
    });

    if (bar.getAttribute("data-render-sig") === sig) {
      return;
    }
    bar.setAttribute("data-render-sig", sig);
    bar.innerHTML = "";

    Object.assign(bar.style, {
      position: "relative",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      margin: "0 16px 6px 16px",
      padding: "0",
      borderRadius: "0",
      backgroundColor: "transparent",
      border: "none",
      fontFamily:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "11.5px",
      color: tokens.foreground,
    });

    const styleTrackPill = (
      btn: HTMLElement,
      opts?: { active?: boolean; accentBorder?: boolean },
    ) => {
      Object.assign(btn.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        height: "24px",
        padding: "0 9px",
        borderRadius: "999px",
        border: `1px solid ${
          opts?.accentBorder
            ? tokens.accent
            : opts?.active
              ? tokens.borderAccent
              : tokens.border
        }`,
        backgroundColor: opts?.active ? tokens.surface2 : tokens.surface1,
        color: opts?.active ? tokens.foreground : tokens.foregroundMuted,
        fontSize: "11.5px",
        fontWeight: opts?.active || opts?.accentBorder ? "600" : "500",
        cursor: "pointer",
        lineHeight: "1",
        whiteSpace: "nowrap",
      });
    };

    const createDot = (status: string): HTMLElement => {
      const dot = document.createElement("span");
      Object.assign(dot.style, {
        width: "6px",
        height: "6px",
        borderRadius: "999px",
        backgroundColor: statusDotColor(status, tokens),
        flexShrink: "0",
      });
      return dot;
    };

    const nodeModelSuffix = (node: SessionLineageNode): string => {
      const cmp = compareSessionBrands(
        { provider: node.provider, model: node.model },
        current ? { provider: current.provider, model: current.model } : null,
      );
      return cmp.child.brand !== "unknown" ? ` · ${cmp.child.summary}` : "";
    };

    const createNodeLeading = (
      node: SessionLineageNode,
      cutoutBg = tokens.surface1,
    ): HTMLElement => {
      const cmp = compareSessionBrands(
        { provider: node.provider, model: node.model },
        current ? { provider: current.provider, model: current.model } : null,
      );
      const normStatus = (node.status ?? "").toLowerCase();
      const brandEl = createModelBrandIconElement({
        doc: document,
        comparison: cmp,
        mode: modelIconsMode,
        theme: tokens,
        sizePx: 12,
        statusPip:
          normStatus === "running"
            ? "running"
            : normStatus === "error" || normStatus === "failed"
              ? "error"
              : normStatus === "attention" || normStatus === "waiting_permission"
                ? "attention"
                : "none",
        pipCutoutBg: cutoutBg,
      });
      return brandEl ?? createDot(node.status);
    };

    const topRow = document.createElement("div");
    Object.assign(topRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "6px",
      flexWrap: "wrap",
    });

    const leftGroup = document.createElement("div");
    Object.assign(leftGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexWrap: "wrap",
      minWidth: "0",
    });

    // 0. Return Breadcrumb ("Don't Lose Yourself" 1-Click Jump Back)
    if (returnBreadcrumb) {
      const returnDisplay = displayLabelFor(returnBreadcrumb);
      const returnBtn = document.createElement("button");
      returnBtn.type = "button";
      returnBtn.setAttribute("data-testid", "paseo-finder-lineage-return-btn");
      returnBtn.title = zh
        ? `点击一键返回刚才浏览的会话 · ⌘[ · ${returnDisplay} · #${returnBreadcrumb.shortId}`
        : `Click to jump back to previous session · ⌘[ · ${returnDisplay} · #${returnBreadcrumb.shortId}`;

      const textSpan = document.createElement("span");
      const truncatedReturnTitle =
        returnDisplay.length > 28
          ? `${returnDisplay.slice(0, 28)}\u2026`
          : returnDisplay;
      textSpan.textContent = zh
        ? `↩ 返回 · ${truncatedReturnTitle}`
        : `↩ Back · ${truncatedReturnTitle}`;

      returnBtn.appendChild(createNodeLeading(returnBreadcrumb, tokens.surface2));
      returnBtn.appendChild(textSpan);
      styleTrackPill(returnBtn, { active: true, accentBorder: true });

      returnBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        clearReturnBreadcrumbForSession(
          current?.workspaceId ?? curWksId,
          current?.agentId ?? curAgentId,
          window,
        );
        navigateToLineageNode(returnBreadcrumb, document, window, {
          recordBreadcrumb: false,
        });
      });

      leftGroup.appendChild(returnBtn);
    }

    // 1A. True Parent Subagent Owner 1-Click Jump Pill (`↖ 父智能体`)
    if (
      data.parent &&
      data.parent.agentId !== returnBreadcrumb?.agentId
    ) {
      const parentNode = data.parent;
      const parentDisplay = displayLabelFor(parentNode);
      const parentBtn = document.createElement("button");
      parentBtn.type = "button";
      parentBtn.setAttribute("data-testid", "paseo-finder-lineage-parent-btn");
      parentBtn.title = zh
        ? `点击一键返回父智能体: ${parentDisplay} · #${parentNode.shortId}`
        : `Click to jump back to parent agent: ${parentDisplay} · #${parentNode.shortId}`;

      const textSpan = document.createElement("span");
      const truncatedParentTitle =
        parentDisplay.length > 28
          ? `${parentDisplay.slice(0, 28)}\u2026`
          : parentDisplay;
      textSpan.textContent = zh
        ? `↖ 父会话 · ${truncatedParentTitle}`
        : `↖ Parent · ${truncatedParentTitle}`;

      parentBtn.appendChild(createNodeLeading(parentNode, tokens.surface2));
      parentBtn.appendChild(textSpan);
      styleTrackPill(parentBtn, { active: true });

      parentBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(parentNode, document, window, current);
      });

      leftGroup.appendChild(parentBtn);
    }

    // 1B. Routed / Colleague Origin Session Pill (`⇄ 派发来源 / 协作发起`)
    if (
      !data.parent &&
      data.routedOrigin &&
      data.routedOrigin.agentId !== returnBreadcrumb?.agentId
    ) {
      const originNode = data.routedOrigin;
      const originDisplay = displayLabelFor(originNode);
      const originBtn = document.createElement("button");
      originBtn.type = "button";
      originBtn.setAttribute("data-testid", "paseo-finder-lineage-origin-btn");
      const isIntakeOrigin = current?.relationKind === "intake-routed";
      originBtn.title = zh
        ? `点击跳转至${isIntakeOrigin ? "队列触发来源会话" : "协作发起同伴"}: ${originDisplay} · #${originNode.shortId}`
        : `Click to jump to ${isIntakeOrigin ? "routing trigger session" : "collaborating peer"}: ${originDisplay} · #${originNode.shortId}`;

      const textSpan = document.createElement("span");
      const truncatedOriginTitle =
        originDisplay.length > 28
          ? `${originDisplay.slice(0, 28)}\u2026`
          : originDisplay;
      textSpan.textContent = zh
        ? `${isIntakeOrigin ? "派发自" : "协作"} · ${truncatedOriginTitle} ↗`
        : `${isIntakeOrigin ? "Routed from" : "Colleague"} · ${truncatedOriginTitle} ↗`;

      originBtn.appendChild(createNodeLeading(originNode, tokens.surface1));
      originBtn.appendChild(textSpan);
      styleTrackPill(originBtn);

      originBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(originNode, document, window, current);
      });

      leftGroup.appendChild(originBtn);
    }

    // 2. True Spawned Subagent Sessions Pill (`↳ 派生子智能体`)
    if (children.length > 0) {
      const runningCount = children.filter((c) => c.status === "running").length;
      if (children.length === 1) {
        const child = children[0];
        const childDisplay = displayLabelFor(child);
        const childStatusWord = formatNodeStatusWord(child.status, zh);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.setAttribute(
          "data-testid",
          `paseo-finder-lineage-child-chip-${child.shortId}`,
        );
        const shortTitle =
          childDisplay.length > 26
            ? `${childDisplay.slice(0, 26)}\u2026`
            : childDisplay;
        const chipLabel = document.createElement("span");
        chipLabel.textContent = `${zh ? "子会话" : "Subagent"} · ${shortTitle} · ${childStatusWord} ↗`;
        chip.appendChild(createNodeLeading(child, tokens.surface1));
        chip.appendChild(chipLabel);
        chip.title = `${childDisplay} · #${child.shortId}${nodeModelSuffix(child)} · ${childStatusWord}`;
        styleTrackPill(chip);
        chip.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          navigateToLineageNode(child, document, window, current);
        });
        leftGroup.appendChild(chip);
      } else {
        const isChildrenOpen = activePopoverSection === "children";
        const childrenToggleBtn = document.createElement("button");
        childrenToggleBtn.type = "button";
        childrenToggleBtn.setAttribute("data-testid", "paseo-finder-lineage-children-toggle");
        const statusSummaryText =
          runningCount > 0
            ? zh
              ? ` · ${runningCount} 运行中`
              : ` · ${runningCount} running`
            : zh
              ? " · 已完成"
              : " · Done";
        const labelSpan = document.createElement("span");
        labelSpan.textContent = zh
          ? `${children.length} 个子会话${statusSummaryText} ${isChildrenOpen ? "▴" : "▾"}`
          : `${children.length} subagents${statusSummaryText} ${isChildrenOpen ? "▴" : "▾"}`;
        childrenToggleBtn.appendChild(
          createDot(runningCount > 0 ? "running" : "done"),
        );
        childrenToggleBtn.appendChild(labelSpan);
        styleTrackPill(childrenToggleBtn, { active: isChildrenOpen });
        childrenToggleBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activePopoverSection = isChildrenOpen ? null : "children";
          bar?.removeAttribute("data-render-sig");
          renderLineageBar(data);
        });
        leftGroup.appendChild(childrenToggleBtn);
      }
    }

    // 2.2 Collaborated / Peer-Exchanged Colleague Sessions (`⇄ 协作同伴`)
    // Always surface the primary (most recent) colleague as a 1-click jump pill on the bar,
    // and if there are additional colleagues, render a compact `+N Colleagues ▾` toggle beside it.
    if (colleagues.length > 0) {
      const col = colleagues[0];
      const colDisplay = displayLabelFor(col);
      const colChip = document.createElement("button");
      colChip.type = "button";
      colChip.setAttribute(
        "data-testid",
        `paseo-finder-lineage-colleague-chip-${col.shortId}`,
      );
      const shortColTitle =
        colDisplay.length > 28
          ? `${colDisplay.slice(0, 28)}\u2026`
          : colDisplay;
      colChip.title = zh
        ? `跨会话协作同伴 · 点击跳转: ${colDisplay} · #${col.shortId}${nodeModelSuffix(col)}`
        : `Collaborating peer session · Click to jump: ${colDisplay} · #${col.shortId}${nodeModelSuffix(col)}`;
      const textSpan = document.createElement("span");
      textSpan.textContent = zh
        ? `协作 · ${shortColTitle} ↗`
        : `Colleague · ${shortColTitle} ↗`;
      colChip.appendChild(createNodeLeading(col, tokens.surface1));
      colChip.appendChild(textSpan);
      styleTrackPill(colChip);
      colChip.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(col, document, window, current);
      });
      leftGroup.appendChild(colChip);

      if (colleagues.length > 1) {
        const isColleaguesOpen = activePopoverSection === "colleagues";
        const anyColleagueRunning = colleagues.some((c) => c.status === "running");
        const extraCount = colleagues.length - 1;
        const colleaguesToggleBtn = document.createElement("button");
        colleaguesToggleBtn.type = "button";
        colleaguesToggleBtn.setAttribute("data-testid", "paseo-finder-lineage-colleagues-toggle");
        const labelSpan = document.createElement("span");
        labelSpan.textContent = zh
          ? `+${extraCount} 协作 ${isColleaguesOpen ? "▴" : "▾"}`
          : `+${extraCount} ${extraCount === 1 ? "Colleague" : "Colleagues"} ${isColleaguesOpen ? "▴" : "▾"}`;
        colleaguesToggleBtn.appendChild(
          createDot(anyColleagueRunning ? "running" : "done"),
        );
        colleaguesToggleBtn.appendChild(labelSpan);
        styleTrackPill(colleaguesToggleBtn, { active: isColleaguesOpen });
        colleaguesToggleBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activePopoverSection = isColleaguesOpen ? null : "colleagues";
          bar?.removeAttribute("data-render-sig");
          renderLineageBar(data);
        });
        leftGroup.appendChild(colleaguesToggleBtn);
      }
    }

    // 2.5 Referenced Sessions in Timeline Messages (`↗ 文中引用`)
    if (uniqueReferencedPeers.length > 0) {
      if (uniqueReferencedPeers.length === 1) {
        const peer = uniqueReferencedPeers[0];
        const peerDisplay = displayLabelFor(peer);
        const peerChip = document.createElement("button");
        peerChip.type = "button";
        peerChip.setAttribute(
          "data-testid",
          `paseo-finder-lineage-ref-peer-${peer.shortId}`,
        );
        const shortPeerTitle =
          peerDisplay.length > 28
            ? `${peerDisplay.slice(0, 28)}\u2026`
            : peerDisplay;
        peerChip.title = zh
          ? `文中提及关联会话 · 点击一键跳转: ${peerDisplay} · #${peer.shortId}`
          : `Referenced session · Click to jump: ${peerDisplay} · #${peer.shortId}`;
        const textSpan = document.createElement("span");
        textSpan.textContent = zh
          ? `引用 · ${shortPeerTitle} ↗`
          : `Referenced · ${shortPeerTitle} ↗`;
        peerChip.appendChild(createNodeLeading(peer, tokens.surface1));
        peerChip.appendChild(textSpan);
        styleTrackPill(peerChip);
        peerChip.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          navigateToLineageNode(peer, document, window, current);
        });
        leftGroup.appendChild(peerChip);
      } else {
        const isRefsOpen = activePopoverSection === "refs";
        const anyRefRunning = uniqueReferencedPeers.some((p) => p.status === "running");
        const refsToggleBtn = document.createElement("button");
        refsToggleBtn.type = "button";
        refsToggleBtn.setAttribute("data-testid", "paseo-finder-lineage-refs-toggle");
        const labelSpan = document.createElement("span");
        labelSpan.textContent = zh
          ? `${uniqueReferencedPeers.length} 个引用会话 ${isRefsOpen ? "▴" : "▾"}`
          : `${uniqueReferencedPeers.length} Referenced ${isRefsOpen ? "▴" : "▾"}`;
        refsToggleBtn.appendChild(createDot(anyRefRunning ? "running" : "done"));
        refsToggleBtn.appendChild(labelSpan);
        styleTrackPill(refsToggleBtn, { active: isRefsOpen });
        refsToggleBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activePopoverSection = isRefsOpen ? null : "refs";
          bar?.removeAttribute("data-render-sig");
          renderLineageBar(data);
        });
        leftGroup.appendChild(refsToggleBtn);
      }
    }

    // 3. Right side: Brief / Report / Notion quick open links
    const rightGroup = document.createElement("div");
    Object.assign(rightGroup.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexWrap: "wrap",
    });

    if (current?.briefPath) {
      const briefBtn = document.createElement("button");
      briefBtn.type = "button";
      briefBtn.textContent = zh ? "简报" : "Brief";
      briefBtn.title = current.briefPath;
      styleTrackPill(briefBtn);
      briefBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (current.briefPath) {
          void client.call(openFileTargetRpc, {
            workspaceId: current.workspaceId,
            path: current.briefPath,
            target: "finder-reveal",
          });
        }
      });
      rightGroup.appendChild(briefBtn);
    }

    if (current?.reportPath) {
      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.textContent = current.reportExists
        ? zh
          ? "报告 · 已就绪"
          : "Report · Ready"
        : zh
          ? "报告 · 待生成"
          : "Report";
      reportBtn.title = current.reportPath;
      styleTrackPill(reportBtn, { active: current.reportExists });
      reportBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (current.reportPath) {
          void client.call(openFileTargetRpc, {
            workspaceId: current.workspaceId,
            path: current.reportExists
              ? current.reportPath
              : current.briefPath ?? current.reportPath,
            target: "finder-reveal",
          });
        }
      });
      rightGroup.appendChild(reportBtn);
    }

    if (current?.notionUrl) {
      const notionLink = document.createElement("a");
      notionLink.href = current.notionUrl;
      notionLink.target = "_blank";
      notionLink.rel = "noopener noreferrer";
      notionLink.textContent = zh ? "Notion ↗" : "Notion ↗";
      styleTrackPill(notionLink);
      notionLink.style.textDecoration = "none";
      rightGroup.appendChild(notionLink);
    }

    const promptBtn = document.createElement("button");
    promptBtn.type = "button";
    promptBtn.setAttribute("data-testid", "paseo-finder-lineage-system-prompt-btn");
    promptBtn.textContent = zh ? "系统提示词" : "System Prompt";
    promptBtn.title = zh
      ? "查看当前生效的系统起始提示词与全局环境指令 (~/.paseo/config.json)"
      : "Inspect active system starter prompt & daemon instructions (~/.paseo/config.json)";
    styleTrackPill(promptBtn);
    promptBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openSystemPromptViewer(client, document, window, zh);
    });
    rightGroup.appendChild(promptBtn);

    topRow.appendChild(leftGroup);
    if (rightGroup.childElementCount > 0) {
      topRow.appendChild(rightGroup);
    }
    bar.appendChild(topRow);

    // 4. Floating Popover Menu above the Track Pill (Subagents / Colleagues / Referenced)
    const drawerItems =
      activePopoverSection === "children"
        ? children
        : activePopoverSection === "colleagues"
          ? colleagues
          : activePopoverSection === "refs"
            ? uniqueReferencedPeers
            : [];
    const drawerRowPrefix =
      activePopoverSection === "children"
        ? "paseo-finder-lineage-child-row"
        : activePopoverSection === "colleagues"
          ? "paseo-finder-lineage-colleague-row"
          : "paseo-finder-lineage-ref-row";

    if (activePopoverSection && drawerItems.length > 0) {
      const listGrid = document.createElement("div");
      listGrid.setAttribute("data-testid", "paseo-finder-lineage-popover");
      Object.assign(listGrid.style, {
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: "0",
        zIndex: "60",
        minWidth: "280px",
        maxWidth: "min(440px, 90vw)",
        maxHeight: "220px",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "4px",
        borderRadius: "10px",
        backgroundColor: tokens.surface0,
        border: `1px solid ${tokens.border}`,
        boxShadow: tokens.shadowLg,
      });

      for (const itemNode of drawerItems) {
        const itemBtn = document.createElement("button");
        itemBtn.type = "button";
        itemBtn.setAttribute(
          "data-testid",
          `${drawerRowPrefix}-${itemNode.shortId}`,
        );
        Object.assign(itemBtn.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "6px 8px",
          borderRadius: "6px",
          border: "none",
          backgroundColor: "transparent",
          color: tokens.foreground,
          fontSize: "12px",
          textAlign: "left",
          cursor: "pointer",
        });
        itemBtn.addEventListener("pointerenter", () => {
          itemBtn.style.backgroundColor = tokens.surface2;
        });
        itemBtn.addEventListener("pointerleave", () => {
          itemBtn.style.backgroundColor = "transparent";
        });

        const itemLeft = document.createElement("div");
        Object.assign(itemLeft.style, {
          display: "flex",
          alignItems: "center",
          gap: "7px",
          minWidth: "0",
          flex: "1",
        });

        const titleSpan = document.createElement("span");
        titleSpan.textContent = displayLabelFor(itemNode);
        Object.assign(titleSpan.style, {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: "500",
        });

        itemLeft.appendChild(createNodeLeading(itemNode, tokens.surface0));
        itemLeft.appendChild(titleSpan);
        const itemModelTag = nodeModelSuffix(itemNode);
        if (itemModelTag) {
          itemBtn.title = `${displayLabelFor(itemNode)} · #${itemNode.shortId}${itemModelTag}`;
        }

        const metaSpan = document.createElement("span");
        metaSpan.textContent = `#${itemNode.shortId} · ${formatNodeStatusWord(itemNode.status, zh)} ↗`;
        Object.assign(metaSpan.style, {
          color: tokens.foregroundMuted,
          fontSize: "11px",
          flexShrink: "0",
        });

        itemBtn.appendChild(itemLeft);
        itemBtn.appendChild(metaSpan);
        itemBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activePopoverSection = null;
          navigateToLineageNode(itemNode, document, window, current);
        });

        listGrid.appendChild(itemBtn);
      }

      bar.appendChild(listGrid);
    }
  };

  const syncLineageForCurrentRoute = (force = false) => {
    const { workspaceId, agentId } = extractCurrentWorkspaceAndAgent(document, window);
    const routeKey = `${workspaceId ?? ""}:${agentId ?? ""}`;
    if (!workspaceId && !agentId) {
      lastRouteKey = "";
      renderLineageBar(null);
      return;
    }

    const routeChanged = routeKey !== lastRouteKey;
    if (routeChanged) {
      lastRouteKey = routeKey;
      activePopoverSection = null;
    }

    const cleanReqWs = (workspaceId ?? "").replace(/^[^:]+:/, "").trim();
    const cached =
      cacheByKey.get(routeKey)?.data ??
      (cleanReqWs && !agentId ? cacheByKey.get(`${cleanReqWs}:`)?.data : null) ??
      null;
    if (cached) {
      renderLineageBar(cached);
    }

    const action = !initialReconcileDone ? "reconcile" : "inspect";
    initialReconcileDone = true;

    void fetchLineage(workspaceId, agentId, force || routeChanged, action).then((res) => {
      if (!res) return;
      const nowActive = extractCurrentWorkspaceAndAgent(document, window);
      const nowRouteKey = `${nowActive.workspaceId ?? ""}:${nowActive.agentId ?? ""}`;
      const cleanNowWs = (nowActive.workspaceId ?? "").replace(/^[^:]+:/, "").trim();
      const resWs = (res.current?.workspaceId ?? "").replace(/^[^:]+:/, "").trim();
      if (
        nowRouteKey === routeKey ||
        (cleanNowWs && (cleanNowWs === cleanReqWs || cleanNowWs === resWs)) ||
        (nowActive.agentId && res.current?.agentId === nowActive.agentId)
      ) {
        if (res.current?.workspaceId && res.current?.agentId) {
          cacheByKey.set(`${res.current.workspaceId}:${res.current.agentId}`, {
            data: res,
            fetchedAtMs: Date.now(),
          });
        }
        renderLineageBar(res);
      }
    });
  };
  externalSyncLineageFn = syncLineageForCurrentRoute;

  const observer = new MutationObserver(() => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      syncLineageForCurrentRoute(false);
    });
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  pollId = setInterval(() => {
    syncLineageForCurrentRoute(true);
  }, 10_000);

  const onKeyDown = (ev: KeyboardEvent) => {
    // ⌘[ or Cmd+Shift+Up jumps back to the Return Breadcrumb or Initiating (parent) session
    const isCmdShiftUp =
      (ev.metaKey || ev.ctrlKey) &&
      ev.shiftKey &&
      !ev.altKey &&
      ev.key === "ArrowUp";
    const isCmdBracketBack =
      (ev.metaKey || ev.ctrlKey) &&
      !ev.shiftKey &&
      !ev.altKey &&
      ev.key === "[";

    if (isCmdShiftUp || isCmdBracketBack) {
      const { workspaceId, agentId } = extractCurrentWorkspaceAndAgent(document, window);
      const returnCrumb = getReturnBreadcrumbForSession(workspaceId, agentId, window);
      if (returnCrumb) {
        ev.preventDefault();
        ev.stopPropagation();
        clearReturnBreadcrumbForSession(workspaceId, agentId, window);
        navigateToLineageNode(returnCrumb, document, window, {
          recordBreadcrumb: false,
        });
        return;
      }
      const cached = cacheByKey.get(`${workspaceId ?? ""}:${agentId ?? ""}`)?.data;
      const jumpOrigin = cached?.parent ?? cached?.routedOrigin ?? null;
      if (jumpOrigin) {
        ev.preventDefault();
        ev.stopPropagation();
        navigateToLineageNode(jumpOrigin, document, window);
      }
    }
  };

  const onModelIconPrefsChange = () => {
    syncLineageForCurrentRoute(true);
    const { workspaceId, agentId } = extractCurrentWorkspaceAndAgent(document, window);
    const cached = cacheByKey.get(`${workspaceId ?? ""}:${agentId ?? ""}`)?.data;
    enhanceTimelineAgentMentions(cached ?? null, document, window);
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("popstate", () => syncLineageForCurrentRoute(true), false);
  window.addEventListener(SIDEBAR_CHILD_SESSIONS_EVENT_NAME, onModelIconPrefsChange);
  setTimeout(() => syncLineageForCurrentRoute(true), 120);

  return () => {
    externalJumpToParentFn = null;
    externalReconcileTitlesFn = null;
    externalSyncLineageFn = null;
    observer.disconnect();
    if (pollId) clearInterval(pollId);
    if (rafId !== null) window.cancelAnimationFrame(rafId);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener(SIDEBAR_CHILD_SESSIONS_EVENT_NAME, onModelIconPrefsChange);
    document
      .querySelector('[data-testid="paseo-finder-session-lineage-bar"]')
      ?.remove();
  };
}
