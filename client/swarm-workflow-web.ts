/// <reference lib="dom" />
import { Platform } from "react-native";
import {
  extractSwarmSidecarQuery,
  isBareSwarmBoardCommand,
  isSwarmSidecarUrl,
} from "../shared/swarm-workflow-contracts";
import {
  extractCurrentWorkspaceAndAgent,
  navigateToLineageNode,
  openWorkspaceTargetTabViaStore,
  resolveSessionReference,
} from "./session-lineage-web";
import { triggerSubagentsTreeDrawer } from "./subagents-tree-web";
import { resolveActivePaseoTheme } from "./theme-web";
import { getWebWindow } from "./web";

export const SWARM_WORKFLOW_PREFS_KEY = "paseo:finder-plugin:swarm-workflow-prefs-v1";
export const SWARM_WORKFLOW_STATE_EVENT = "paseo:finder-swarm-workflow-state";
const SWARM_AUTO_OPENED_SESSION_KEY = "paseo:finder-plugin:swarm-auto-opened-v1";

export interface SwarmWorkflowPrefs {
  enableNativeSwarmBridge: boolean;
  interceptSwarmBoardCommand: boolean;
  interceptSidecarLinks: boolean;
  enableLiveSwarmCard: boolean;
  autoOpenSwarmTabOnStart: boolean;
  expandOverviewTasksByDefault: boolean;
}

export const DEFAULT_SWARM_WORKFLOW_PREFS: SwarmWorkflowPrefs = {
  enableNativeSwarmBridge: true,
  interceptSwarmBoardCommand: true,
  interceptSidecarLinks: true,
  enableLiveSwarmCard: true,
  autoOpenSwarmTabOnStart: true,
  expandOverviewTasksByDefault: true,
};

export interface SwarmWorkflowReceipt {
  at: string;
  event: string;
  detail: string;
  ok: boolean;
}

export interface SwarmOpenRequest {
  tab?: "swarm" | "workflows";
  conversationId?: string;
  swarmTab?: string;
  workspaceId?: string;
}

export interface WorkspaceSwarmPresence {
  workspaceId: string;
  swarmId: string;
  title: string;
  activeCount: number;
  memberCount: number;
  postCount: number;
}

const runtimeState = {
  installed: false,
  mountedIframes: 0,
  lastProxyUrl: null as string | null,
  lastConversationId: null as string | null,
  interceptedSidecarClicks: 0,
  interceptedBoardCommands: 0,
  openedMemberConversations: 0,
  openedMemberNativeTabs: 0,
  autoOpenedSwarmPanels: 0,
  pendingRequest: null as SwarmOpenRequest | null,
  receipts: [] as SwarmWorkflowReceipt[],
};

const requestListeners = new Set<(req: SwarmOpenRequest) => void>();
const presenceListeners = new Set<(presence: WorkspaceSwarmPresence) => void>();
let openPanelCallback: ((req?: SwarmOpenRequest) => void) | null = null;
const autoOpenedSwarmIdsMemory = new Set<string>();

function pushReceipt(event: string, detail: string, ok = true): void {
  runtimeState.receipts.unshift({
    at: new Date().toISOString(),
    event,
    detail: detail.slice(0, 220),
    ok,
  });
  if (runtimeState.receipts.length > 24) {
    runtimeState.receipts.length = 24;
  }
}

export function readSwarmWorkflowPrefs(): SwarmWorkflowPrefs {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return { ...DEFAULT_SWARM_WORKFLOW_PREFS };
  }
  try {
    const raw = window.localStorage?.getItem(SWARM_WORKFLOW_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SWARM_WORKFLOW_PREFS };
    const parsed = JSON.parse(raw) as Partial<SwarmWorkflowPrefs>;
    return {
      enableNativeSwarmBridge: parsed.enableNativeSwarmBridge ?? true,
      interceptSwarmBoardCommand: parsed.interceptSwarmBoardCommand ?? true,
      interceptSidecarLinks: parsed.interceptSidecarLinks ?? true,
      enableLiveSwarmCard: parsed.enableLiveSwarmCard ?? true,
      autoOpenSwarmTabOnStart: parsed.autoOpenSwarmTabOnStart ?? true,
      expandOverviewTasksByDefault: parsed.expandOverviewTasksByDefault ?? true,
    };
  } catch {
    return { ...DEFAULT_SWARM_WORKFLOW_PREFS };
  }
}

export function syncSwarmWorkflowPrefs(next: Partial<SwarmWorkflowPrefs>): SwarmWorkflowPrefs {
  const merged: SwarmWorkflowPrefs = { ...readSwarmWorkflowPrefs(), ...next };
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      window.localStorage?.setItem(SWARM_WORKFLOW_PREFS_KEY, JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent(SWARM_WORKFLOW_STATE_EVENT, { detail: merged }));
    } catch {
      // ignore
    }
  }
  return merged;
}

export function consumePendingSwarmOpenRequest(): SwarmOpenRequest | null {
  const req = runtimeState.pendingRequest;
  runtimeState.pendingRequest = null;
  return req;
}

export function subscribeSwarmOpenRequests(listener: (req: SwarmOpenRequest) => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

export function subscribeWorkspaceSwarmPresence(
  listener: (presence: WorkspaceSwarmPresence) => void,
): () => void {
  presenceListeners.add(listener);
  return () => {
    presenceListeners.delete(listener);
  };
}

export function notifyWorkspaceSwarmPresence(presence: WorkspaceSwarmPresence): void {
  if (!presence.workspaceId || !presence.swarmId) return;
  for (const fn of presenceListeners) {
    try {
      fn(presence);
    } catch {
      // ignore listener errors
    }
  }
}

function readAutoOpenedSwarmIds(): Set<string> {
  const set = new Set<string>(autoOpenedSwarmIdsMemory);
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage?.getItem(SWARM_AUTO_OPENED_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === "string" && id) set.add(id);
          }
        }
      }
    } catch {
      // ignore storage errors
    }
  }
  return set;
}

function markSwarmAutoOpened(swarmId: string): void {
  autoOpenedSwarmIdsMemory.add(swarmId);
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      const merged = Array.from(readAutoOpenedSwarmIds()).slice(-40);
      window.sessionStorage?.setItem(SWARM_AUTO_OPENED_SESSION_KEY, JSON.stringify(merged));
    } catch {
      // ignore storage errors
    }
  }
}

export function maybeAutoOpenSwarmPanelForActiveRun(input: {
  swarmId: string;
  workspaceId?: string | null;
  conversationId?: string;
  activeCount: number;
  isLiveStreaming?: boolean;
}): boolean {
  const sid = String(input.swarmId ?? "").trim();
  if (!sid) return false;
  const prefs = readSwarmWorkflowPrefs();
  if (!prefs.enableNativeSwarmBridge || !prefs.autoOpenSwarmTabOnStart) return false;
  if (!input.isLiveStreaming && input.activeCount <= 0) return false;
  const opened = readAutoOpenedSwarmIds();
  if (opened.has(sid)) return false;
  // Never steal view if a visible Swarm panel is already open in the active workspace deck.
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="paseo-swarm-workspace-panel"]'),
    );
    const hasVisiblePanel = panels.some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80;
    });
    if (hasVisiblePanel) {
      markSwarmAutoOpened(sid);
      return false;
    }
  }
  markSwarmAutoOpened(sid);
  runtimeState.autoOpenedSwarmPanels += 1;
  pushReceipt("auto-open-swarm-tab", sid, true);
  requestOpenSwarmWorkspacePanel({
    tab: "swarm",
    conversationId: input.conversationId ?? sid,
    workspaceId: input.workspaceId ?? undefined,
  });
  return true;
}

export function requestOpenSwarmWorkspacePanel(req?: SwarmOpenRequest): void {
  const normalized: SwarmOpenRequest = {
    tab: req?.tab ?? "swarm",
    conversationId: req?.conversationId,
    swarmTab: req?.swarmTab,
    workspaceId: req?.workspaceId,
  };
  runtimeState.pendingRequest = normalized;
  for (const fn of requestListeners) {
    try {
      fn(normalized);
    } catch {
      // ignore
    }
  }
  openPanelCallback?.(normalized);
}

export function buildSwarmSidecarThemePayload(doc?: Document | null, win?: Window | null): {
  colorScheme: "light" | "dark";
  cssVariables: Record<string, string>;
} {
  const t = resolveActivePaseoTheme(doc ?? null, win ?? null);
  return {
    colorScheme: t.colorScheme,
    cssVariables: {
      "--background": t.surface0,
      "--foreground": t.foreground,
      "--card": t.surface1,
      "--card-foreground": t.foreground,
      "--popover": t.surface1,
      "--popover-foreground": t.foreground,
      "--secondary": t.surface2,
      "--secondary-foreground": t.foreground,
      "--muted": t.surface2,
      "--muted-foreground": t.foregroundMuted,
      "--accent": t.surface2,
      "--accent-foreground": t.foreground,
      "--border": t.border,
      "--input": t.surface2,
      "--primary": t.accentBright || t.accent,
      "--primary-foreground": t.accentForeground,
      "--destructive": t.destructive,
      "--ring": t.borderAccent,
      "--font-family":
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    },
  };
}

export function openSwarmMemberConversationInPaseo(
  conversationId: string,
  options?: { workspaceId?: string | null; parentAgentId?: string | null },
): boolean {
  const cid = String(conversationId ?? "").trim();
  if (!cid) return false;
  runtimeState.openedMemberConversations += 1;
  pushReceipt("open-member-conversation", cid, true);
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof window === "undefined") return false;
  const refNode = resolveSessionReference(cid);
  if (refNode && !(refNode as { externalSource?: unknown }).externalSource && refNode.workspaceId) {
    navigateToLineageNode(refNode, document, window);
    return true;
  }
  // Prefer opening a native Paseo workspace subagent tab (`Swarm Worker (<name>)`) when the
  // worker is registered as a provider subagent of the current workspace's coordinator session.
  const routeCtx = extractCurrentWorkspaceAndAgent(document, window);
  const wsId = options?.workspaceId ?? routeCtx.workspaceId ?? null;
  const parentAgentId = options?.parentAgentId ?? routeCtx.agentId ?? null;
  if (wsId && parentAgentId && cid !== parentAgentId) {
    const openedNativeTab = openWorkspaceTargetTabViaStore(
      { workspaceId: wsId, parentAgentId, subagentId: cid },
      window,
    );
    if (openedNativeTab) {
      runtimeState.openedMemberNativeTabs += 1;
      pushReceipt("open-member-native-tab", cid, true);
      return true;
    }
  }
  triggerSubagentsTreeDrawer({
    conversationId: cid,
    layoutMode: "docked-right",
  });
  return true;
}

export interface MountSwarmBoardIframeOptions {
  hostTestId: string;
  proxyUrl: string;
  conversationId: string;
  initialSwarmTab?: string;
  onStatusChange?: (status: { ready: boolean; error: string | null }) => void;
}

export function mountSwarmBoardIframe(options: MountSwarmBoardIframeOptions): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  const { hostTestId, proxyUrl, conversationId, initialSwarmTab, onStatusChange } = options;
  let disposed = false;
  let iframeEl: HTMLIFrameElement | null = null;
  let themeObserver: MutationObserver | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const pushThemeToFrame = () => {
    if (!iframeEl?.contentWindow) return;
    const payload = buildSwarmSidecarThemePayload(document, window);
    try {
      iframeEl.contentWindow.postMessage({ type: "theme-change", payload }, "*");
    } catch {
      // ignore cross-frame post failure
    }
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (disposed || !iframeEl || event.source !== iframeEl.contentWindow) return;
    const data = event.data as { type?: string; payload?: Record<string, unknown> } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "paseo-swarm-preload-ready") {
      pushThemeToFrame();
      onStatusChange?.({ ready: true, error: null });
    } else if (data.type === "paseo-swarm-open-conversation") {
      const cid = String(data.payload?.conversationId ?? "").trim();
      if (cid) openSwarmMemberConversationInPaseo(cid);
    } else if (data.type === "paseo-swarm-open-file") {
      const uri = String(data.payload?.uri ?? "").trim();
      if (uri) {
        const cleanPath = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
        pushReceipt("open-aux-file", cleanPath, true);
        openFileCallback?.(cleanPath);
      }
    }
  };

  window.addEventListener("message", onWindowMessage);

  const onPrefsChanged = () => {
    if (disposed || !iframeEl?.contentWindow) return;
    try {
      iframeEl.contentWindow.postMessage(
        {
          type: "paseo-swarm-set-prefs",
          payload: { expandDoneTasks: readSwarmWorkflowPrefs().expandOverviewTasksByDefault },
        },
        "*",
      );
    } catch {
      // ignore
    }
  };
  window.addEventListener(SWARM_WORKFLOW_STATE_EVENT, onPrefsChanged);

  const attach = (attempt = 0) => {
    if (disposed) return;
    const host = document.querySelector<HTMLElement>(`[data-testid="${hostTestId}"]`);
    if (!host) {
      if (attempt < 20) {
        retryTimer = setTimeout(() => attach(attempt + 1), 60);
      }
      return;
    }

    const url = new URL("/", proxyUrl);
    // Keep same-site hostname with localhost hosts so Chromium Retina (dpr=2) never triggers
    // cross-site OOPIF half-viewport clipping (localhost -> 127.0.0.1).
    if (window.location.hostname === "localhost" && url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
    }
    if (conversationId) url.searchParams.set("conversationId", conversationId);
    if (initialSwarmTab) url.searchParams.set("tab", initialSwarmTab);
    url.searchParams.set("scheme", buildSwarmSidecarThemePayload(document, window).colorScheme);
    url.searchParams.set(
      "expandDoneTasks",
      readSwarmWorkflowPrefs().expandOverviewTasksByDefault ? "1" : "0",
    );

    let frame = host.querySelector<HTMLIFrameElement>("iframe[data-paseo-swarm-board-frame='true']");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.setAttribute("data-paseo-swarm-board-frame", "true");
      frame.setAttribute("data-testid", "paseo-swarm-board-iframe");
      frame.setAttribute("data-paseo-finder-injected", "true");
      frame.setAttribute("title", "Antigravity Native Swarm Board");
      frame.style.position = "absolute";
      frame.style.inset = "0";
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.border = "0";
      frame.style.display = "block";
      frame.style.background = "transparent";
      host.style.position = "relative";
      host.style.width = "100%";
      host.style.flex = "1 1 auto";
      host.appendChild(frame);
      runtimeState.mountedIframes += 1;
    }
    iframeEl = frame;
    runtimeState.lastProxyUrl = proxyUrl;
    runtimeState.lastConversationId = conversationId || null;

    const targetHref = url.toString();
    if (frame.src !== targetHref) {
      frame.src = targetHref;
    } else if (conversationId && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage(
          { type: "paseo-swarm-set-conversation", conversationId },
          "*",
        );
      } catch {
        // ignore
      }
    }

    frame.addEventListener("load", () => {
      if (disposed) return;
      pushThemeToFrame();
      onStatusChange?.({ ready: true, error: null });
    });

    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      themeObserver = new MutationObserver(() => {
        pushThemeToFrame();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }
  };

  attach(0);

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    window.removeEventListener("message", onWindowMessage);
    window.removeEventListener(SWARM_WORKFLOW_STATE_EVENT, onPrefsChanged);
    themeObserver?.disconnect();
    if (iframeEl) {
      try {
        iframeEl.remove();
        runtimeState.mountedIframes = Math.max(0, runtimeState.mountedIframes - 1);
      } catch {
        // ignore
      }
      iframeEl = null;
    }
  };
}

export function handleSwarmSidecarExternalUrl(rawUrl: string): boolean {
  if (!isSwarmSidecarUrl(rawUrl)) return false;
  const prefs = readSwarmWorkflowPrefs();
  if (!prefs.interceptSidecarLinks) return false;
  const q = extractSwarmSidecarQuery(rawUrl);
  runtimeState.interceptedSidecarClicks += 1;
  pushReceipt("sidecar-url-intercept", rawUrl, true);
  requestOpenSwarmWorkspacePanel({
    tab: "swarm",
    conversationId: q.conversationId,
    swarmTab: q.tab,
  });
  return true;
}

export function getSwarmWorkflowClientStatus() {
  return {
    installed: runtimeState.installed,
    prefs: readSwarmWorkflowPrefs(),
    mountedIframes: runtimeState.mountedIframes,
    lastProxyUrl: runtimeState.lastProxyUrl,
    lastConversationId: runtimeState.lastConversationId,
    interceptedSidecarClicks: runtimeState.interceptedSidecarClicks,
    interceptedBoardCommands: runtimeState.interceptedBoardCommands,
    openedMemberConversations: runtimeState.openedMemberConversations,
    openedMemberNativeTabs: runtimeState.openedMemberNativeTabs,
    autoOpenedSwarmPanels: runtimeState.autoOpenedSwarmPanels,
    receipts: [...runtimeState.receipts],
  };
}

let openFileCallback: ((filePath: string) => void) | null = null;

export function installSwarmWorkflowDesktopBridge(options: {
  onOpenSwarmPanel: (req?: SwarmOpenRequest) => void;
  onOpenFile?: (filePath: string) => void;
}): () => void {
  openPanelCallback = options.onOpenSwarmPanel;
  openFileCallback = options.onOpenFile ?? null;
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof window === "undefined") {
    return () => {
      if (openPanelCallback === options.onOpenSwarmPanel) openPanelCallback = null;
      if (openFileCallback === (options.onOpenFile ?? null)) openFileCallback = null;
    };
  }

  runtimeState.installed = true;

  const onDocumentClickCapture = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;
    const anchor = target.closest<HTMLAnchorElement>('a[href^="sidecar://"]');
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!isSwarmSidecarUrl(href)) return;
    if (!readSwarmWorkflowPrefs().interceptSidecarLinks) return;
    ev.preventDefault();
    ev.stopPropagation();
    handleSwarmSidecarExternalUrl(href);
  };

  const onDocumentKeyDownCapture = (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.altKey || ev.isComposing) return;
    if (!readSwarmWorkflowPrefs().interceptSwarmBoardCommand) return;
    const target = ev.target as HTMLTextAreaElement | null;
    if (!target || target.tagName !== "TEXTAREA") return;
    if (!target.hasAttribute("data-composer-input")) return;
    const val = String(target.value ?? "");
    if (!isBareSwarmBoardCommand(val)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Clear composer value cleanly via native setter so React controlled input updates.
    try {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (setter) setter.call(target, "");
      else target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      // ignore
    }
    runtimeState.interceptedBoardCommands += 1;
    pushReceipt("bare-swarm-board-command", val.trim(), true);
    requestOpenSwarmWorkspacePanel({ tab: "swarm" });
  };

  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);

  (window as unknown as Record<string, unknown>).__paseoFinderSwarmWorkflow = {
    status: getSwarmWorkflowClientStatus,
    openPanel: (req?: SwarmOpenRequest) => requestOpenSwarmWorkspacePanel(req),
    openMember: (cid: string) => openSwarmMemberConversationInPaseo(cid),
  };

  return () => {
    document.removeEventListener("click", onDocumentClickCapture, true);
    document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
    if (openPanelCallback === options.onOpenSwarmPanel) openPanelCallback = null;
    if (openFileCallback === (options.onOpenFile ?? null)) openFileCallback = null;
    runtimeState.installed = false;
  };
}
