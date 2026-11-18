/// <reference lib="dom" />
import {
  type AgentSnapshotLike,
  type LatestTurnQuotaSignal,
  type QuotaQueueGateDecision,
  type QuotaQueueItem,
  type TimelineItemLike,
  evaluateQuotaQueueDrainGate,
  extractLatestTurnQuotaSignal,
} from "../shared/quota-queue-contracts";
import { getMetroModuleMap, requireMetroExport, type MetroWindow } from "./metro-registry";
import { syncPaseoThemeCssVariables } from "./theme-web";

export interface QuotaQueueGuardPrefs {
  enabled: boolean;
  autoDrain: boolean;
}

export const DEFAULT_QUOTA_QUEUE_GUARD_PREFS: QuotaQueueGuardPrefs = {
  enabled: true,
  autoDrain: true,
};

export const QUOTA_QUEUE_PREFS_STORAGE_KEY = "paseo:finder-plugin:quota-queue-prefs";
export const QUOTA_QUEUE_RECEIPTS_STORAGE_KEY = "paseo:finder-plugin:quota-queue-receipts";
export const QUOTA_QUEUE_EVENT = "paseo-finder:quota-queue-updated";
const GLOBAL_BRIDGE_KEY = "__paseoFinderQuotaQueue";
const PATCH_MARKER_KEY = "__paseoFinderQuotaQueuePatch";
const MAX_LOCAL_RECEIPTS = 20;
// A failed native send puts the message back at the queue front and nothing retries it
// (Paseo only drains on a turn ending). Retry with backoff, then hold visibly.
const DEFAULT_DISPATCH_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const MAX_DISPATCH_FAILURES = 8;
// While any queue is non-empty: refresh the server snapshot (the headless drainer only acts
// when this heartbeat is >= 90s old) and drain queues stranded on idle/errored agents.
const DEFAULT_HEARTBEAT_MS = 30_000;
const STALL_GRACE_MS = 15_000;
const DISPATCH_OUTCOME_POLL_MS = 100;
const DISPATCH_OUTCOME_TIMEOUT_MS = 180_000;

export interface QuotaQueueClientReceipt {
  at: string;
  agentId: string;
  action: "held" | "drained_one" | "checked" | "restored" | "released" | "dispatch_failed" | "deduped";
  queuedCount: number;
  reasonCode: string;
  detail: string;
}

export interface AgentHoldState {
  serverId: string;
  agentId: string;
  held: boolean;
  reasonCode: string;
  reason: string;
  resumeAtMs: number | null;
  lastErrorText: string | null;
  checkedAtMs: number | null;
  quotaRefreshed: boolean | null;
  previousTurnCompleted: boolean | null;
  readyToDrain: boolean;
  queuedCount: number;
}

export interface QuotaQueueRpcResult {
  ok: boolean;
  readyToDrain: boolean;
  quotaRefreshed: boolean | null;
  previousTurnCompleted: boolean | null;
  resumeAtIso: string | null;
  holdReason: string;
  entries?: Array<{
    agentId: string;
    serverId: string;
    held: boolean;
    reasonCode: string;
    holdReason: string;
    quotaRefreshed?: boolean | null;
    previousTurnCompleted?: boolean | null;
    resumeAtIso?: string | null;
    lastErrorText?: string | null;
    queuedMessages: QuotaQueueItem[];
  }>;
  /** Ids the server ledger says were already sent (by any drainer); drop them locally. */
  drainedMessageIds?: string[];
}

export type QuotaQueueRpcCaller = (input: {
  action: "status" | "sync" | "check" | "drain_one" | "release" | "clear_agent" | "reset";
  agentId?: string;
  serverId?: string;
  provider?: string;
  model?: string;
  title?: string;
  held?: boolean;
  reasonCode?: string;
  holdReason?: string;
  lastErrorText?: string | null;
  resumeAtMs?: number | null;
  queuedMessages?: QuotaQueueItem[];
  dispatchedMessageIds?: string[];
  triggerRecoveryIfReady?: boolean;
  source?: "runtime-guard" | "settings-ui" | "slash-command" | "command-center" | "agent-tool";
}) => Promise<QuotaQueueRpcResult>;

export interface SessionStoreAgentEntry extends AgentSnapshotLike {
  title?: unknown;
  workspaceId?: unknown;
}

export interface SessionStoreSlice {
  agents?: Map<string, SessionStoreAgentEntry>;
  agentDetails?: Map<string, SessionStoreAgentEntry>;
  queuedMessages?: Map<string, QuotaQueueItem[]>;
  initializingAgents?: Map<string, boolean>;
  pendingPermissions?: Map<string, { agentId?: string }>;
  agentStreamTail?: Map<string, TimelineItemLike[]>;
  agentStreamHead?: Map<string, TimelineItemLike[]>;
  client?: unknown;
}

export interface QuotaSessionStoreLike {
  getState(): {
    sessions?: Record<string, SessionStoreSlice>;
    setQueuedMessages?: (
      serverId: string,
      updater:
        | Map<string, QuotaQueueItem[]>
        | ((prev: Map<string, QuotaQueueItem[]>) => Map<string, QuotaQueueItem[]>),
    ) => void;
  };
  subscribe?(listener: () => void): () => void;
}

export interface HostRuntimeStoreLike {
  drainQueuedAgentMessage?: (serverId: string, agentId: string) => unknown;
  queuedAgentDrainInFlight?: Set<string>;
}

const evalToken = Symbol("paseoFinderQuotaQueueEval");
let activeController: {
  dispose: () => void;
  getStatus: () => Record<string, unknown>;
  inspectAgent: (agentId: string) => Record<string, unknown> | null;
  checkNow: (agentId: string) => Promise<QuotaQueueGateDecision | null>;
  release: (agentId: string) => Promise<void>;
  reconcileFromServer: (res: QuotaQueueRpcResult & { action?: string; agentId?: string }) => void;
} | null = null;

export function reconcileQuotaQueueFromServer(
  res: (QuotaQueueRpcResult & { action?: string; agentId?: string }) | null | undefined,
): void {
  if (!res) return;
  try {
    activeController?.reconcileFromServer(res);
  } catch {
    // Ignore reconcile failure when guard is inactive
  }
}

function getSafeStorage(storageOverride?: Storage | null): Storage | null {
  if (storageOverride) return storageOverride;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readQuotaQueuePrefs(storageOverride?: Storage | null): QuotaQueueGuardPrefs {
  const store = getSafeStorage(storageOverride);
  if (!store) return { ...DEFAULT_QUOTA_QUEUE_GUARD_PREFS };
  try {
    const raw = store.getItem(QUOTA_QUEUE_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_QUOTA_QUEUE_GUARD_PREFS };
    const parsed = JSON.parse(raw) as Partial<QuotaQueueGuardPrefs>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      autoDrain: typeof parsed.autoDrain === "boolean" ? parsed.autoDrain : true,
    };
  } catch {
    return { ...DEFAULT_QUOTA_QUEUE_GUARD_PREFS };
  }
}

export function syncQuotaQueuePrefs(
  partial: Partial<QuotaQueueGuardPrefs>,
  storageOverride?: Storage | null,
  win?: Window | null,
): QuotaQueueGuardPrefs {
  const store = getSafeStorage(storageOverride);
  const current = readQuotaQueuePrefs(store);
  const next: QuotaQueueGuardPrefs = {
    enabled: typeof partial.enabled === "boolean" ? partial.enabled : current.enabled,
    autoDrain: typeof partial.autoDrain === "boolean" ? partial.autoDrain : current.autoDrain,
  };
  if (store) {
    try {
      store.setItem(QUOTA_QUEUE_PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage write errors
    }
  }
  try {
    win?.dispatchEvent(new CustomEvent(QUOTA_QUEUE_EVENT, { detail: next }));
  } catch {
    // Ignore event dispatch errors
  }
  return next;
}

function readLocalReceipts(storageOverride?: Storage | null): QuotaQueueClientReceipt[] {
  const store = getSafeStorage(storageOverride);
  if (!store) return [];
  try {
    const raw = store.getItem(QUOTA_QUEUE_RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QuotaQueueClientReceipt[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_LOCAL_RECEIPTS) : [];
  } catch {
    return [];
  }
}

function recordLocalReceipt(
  receipt: QuotaQueueClientReceipt,
  storageOverride?: Storage | null,
  win?: Window | null,
): void {
  const store = getSafeStorage(storageOverride);
  const next = [receipt, ...readLocalReceipts(store)].slice(0, MAX_LOCAL_RECEIPTS);
  if (store) {
    try {
      store.setItem(QUOTA_QUEUE_RECEIPTS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage errors
    }
  }
  try {
    win?.dispatchEvent(new CustomEvent(QUOTA_QUEUE_EVENT));
  } catch {
    // Ignore event errors
  }
}

export function findQuotaSessionStore(win?: MetroWindow | null): QuotaSessionStoreLike | null {
  const target = (win ?? (typeof window !== "undefined" ? window : null)) as MetroWindow | null;
  if (!target) return null;
  const map = getMetroModuleMap(target);
  if (map) {
    for (const mod of map.values()) {
      const candidate = mod?.isInitialized ? mod.publicModule?.exports?.useSessionStore : null;
      if (candidate && typeof (candidate as QuotaSessionStoreLike).getState === "function") {
        return candidate as QuotaSessionStoreLike;
      }
    }
  }
  const hit = requireMetroExport("useSessionStore", target);
  const candidate = hit?.exports?.useSessionStore;
  if (candidate && typeof (candidate as QuotaSessionStoreLike).getState === "function") {
    return candidate as QuotaSessionStoreLike;
  }
  return null;
}

export function findHostRuntimeModule(win?: MetroWindow | null): {
  HostRuntimeStore?: { prototype?: HostRuntimeStoreLike };
  getHostRuntimeStore?: () => HostRuntimeStoreLike;
} | null {
  const target = (win ?? (typeof window !== "undefined" ? window : null)) as MetroWindow | null;
  if (!target) return null;
  const hit =
    requireMetroExport("HostRuntimeStore", target) ??
    requireMetroExport("getHostRuntimeStore", target);
  return (hit?.exports as {
    HostRuntimeStore?: { prototype?: HostRuntimeStoreLike };
    getHostRuntimeStore?: () => HostRuntimeStoreLike;
  }) ?? null;
}

export function collectAgentTimelineItems(
  session: SessionStoreSlice | undefined,
  agentId: string,
): TimelineItemLike[] {
  if (!session) return [];
  const tail = session.agentStreamTail?.get(agentId) ?? [];
  const head = session.agentStreamHead?.get(agentId) ?? [];
  if (head.length === 0) return tail;
  return [...tail, ...head];
}

export function hasAgentPendingPermission(
  session: SessionStoreSlice | undefined,
  agentId: string,
): boolean {
  const perms = session?.pendingPermissions;
  if (!perms) return false;
  for (const p of perms.values()) {
    if (p?.agentId === agentId) return true;
  }
  return false;
}

function isAgentRunningSnapshot(agent: SessionStoreAgentEntry | undefined): boolean {
  if (!agent) return false;
  const phase = String(agent.turn?.phase ?? "");
  const status = String(agent.status ?? "").toLowerCase();
  return phase === "open" || status === "running";
}

function resolveAgentModelAndProvider(agent: SessionStoreAgentEntry | undefined): {
  provider: string;
  model: string;
  title: string;
} {
  const provider = String(agent?.provider ?? agent?.runtimeInfo?.provider ?? "").trim();
  const model = String(agent?.model ?? agent?.runtimeInfo?.model ?? "").trim();
  const title = String(agent?.title ?? "").trim();
  return { provider, model, title };
}

function extractRouteAgentId(win: Window): string | null {
  try {
    const href = `${win.location?.pathname ?? ""} ${win.location?.hash ?? ""}`;
    const m = /\/agents?\/([a-zA-Z0-9_-]{6,})/.exec(href);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractRouteWorkspaceId(win: Window): string | null {
  try {
    const href = `${win.location?.pathname ?? ""} ${win.location?.hash ?? ""}`;
    const m = /\/workspace\/(?:[^:/?#\s]+:)?(wks_[a-zA-Z0-9_-]+)/.exec(href);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractDomSelectedAgentId(doc: Document | null | undefined): string | null {
  try {
    if (!doc?.querySelector) return null;
    const activeTab =
      doc.querySelector('[data-testid^="workspace-tab-agent_"][aria-selected="true"]') ??
      doc.querySelector('[data-testid^="workspace-tab-agent_"][data-active="true"]');
    const tid = activeTab?.getAttribute?.("data-testid") ?? "";
    if (tid.startsWith("workspace-tab-agent_")) {
      return tid.slice("workspace-tab-agent_".length) || null;
    }
    return null;
  } catch {
    return null;
  }
}

function formatRemainingWait(resumeAtMs: number | null, nowMs: number, isZh: boolean): string {
  if (!resumeAtMs || resumeAtMs <= nowMs) return "";
  const secs = Math.max(1, Math.ceil((resumeAtMs - nowMs) / 1000));
  if (secs < 90) return isZh ? `约 ${secs} 秒后刷新` : `~${secs}s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 90) return isZh ? `约 ${mins} 分钟后刷新` : `~${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return isZh ? `约 ${hrs}h${remMins > 0 ? `${remMins}m` : ""}后刷新` : `~${hrs}h${remMins > 0 ? `${remMins}m` : ""}`;
}

const BANNER_ID = "paseo-finder-quota-queue-banner";

function removeHoldBanner(doc: Document | null | undefined): void {
  if (!doc) return;
  try {
    doc.getElementById(BANNER_ID)?.remove();
  } catch {
    // Ignore DOM errors
  }
}

function renderHoldBanner(options: {
  doc: Document;
  win: Window;
  hold: AgentHoldState | null;
  queuedCount: number;
  isZh: boolean;
  onCheckNow: (agentId: string) => void;
}): void {
  const { doc, win, hold, queuedCount, isZh, onCheckNow } = options;
  if (!hold || !hold.held || queuedCount <= 0) {
    removeHoldBanner(doc);
    return;
  }

  // Locate Paseo's native queued-message edit/send buttons to anchor cleanly right above the queue track
  const queueActionBtn = doc.querySelector<HTMLElement>(
    '[aria-label*="queued message" i], [aria-label*="排队" i]',
  );
  const composerTextarea = doc.querySelector<HTMLElement>("textarea");
  const anchorRoot =
    queueActionBtn?.parentElement?.parentElement?.parentElement?.parentElement ??
    composerTextarea?.parentElement?.parentElement?.parentElement ??
    null;
  if (!anchorRoot || !anchorRoot.parentElement) {
    removeHoldBanner(doc);
    return;
  }

  syncPaseoThemeCssVariables(doc, win);

  let banner = doc.getElementById(BANNER_ID) as HTMLElement | null;
  if (!banner) {
    banner = doc.createElement("div");
    banner.id = BANNER_ID;
    banner.setAttribute("data-testid", BANNER_ID);
    banner.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:8px",
      "padding:6px 10px",
      "margin-bottom:6px",
      "border-radius:8px",
      "font-size:12px",
      "line-height:16px",
      "background:var(--paseo-finder-surface-1, #fafafa)",
      "border:1px solid var(--paseo-finder-border-accent, #e4e4e7)",
      "color:var(--paseo-finder-fg-muted, #71717a)",
    ].join(";");
  }

  if (banner.parentElement !== anchorRoot.parentElement) {
    anchorRoot.parentElement.insertBefore(banner, anchorRoot);
  }

  const quotaAlreadyHealthy =
    hold.quotaRefreshed === true ||
    hold.reasonCode === "agent_running" ||
    hold.reasonCode === "previous_turn_incomplete" ||
    hold.reasonCode === "drain_cooldown";
  const etaTxt = quotaAlreadyHealthy ? "" : formatRemainingWait(hold.resumeAtMs, Date.now(), isZh);
  const statusText = quotaAlreadyHealthy
    ? isZh
      ? `配额正常 · 当前回合运行中，完成后逐条发送 · ${queuedCount} 条排队`
      : `Quota healthy · waiting for current turn before draining 1 by 1 · ${queuedCount} queued`
    : isZh
      ? `等待配额刷新并完成当前回合后再逐条发送 · ${queuedCount} 条排队${etaTxt ? ` · ${etaTxt}` : ""}`
      : `Waiting for quota refresh & current turn before draining one by one · ${queuedCount} queued${etaTxt ? ` · ${etaTxt}` : ""}`;

  let textSpan = banner.querySelector<HTMLSpanElement>('[data-role="status"]');
  let checkBtn = banner.querySelector<HTMLButtonElement>('[data-role="check"]');
  if (!textSpan || !checkBtn) {
    banner.replaceChildren();
    textSpan = doc.createElement("span");
    textSpan.setAttribute("data-role", "status");
    textSpan.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    checkBtn = doc.createElement("button");
    checkBtn.setAttribute("data-role", "check");
    checkBtn.type = "button";
    checkBtn.style.cssText = [
      "flex-shrink:0",
      "padding:2px 8px",
      "border-radius:6px",
      "font-size:11px",
      "font-weight:500",
      "cursor:pointer",
      "background:var(--paseo-finder-surface-2, #f4f4f5)",
      "border:1px solid var(--paseo-finder-border-accent, #e4e4e7)",
      "color:var(--paseo-finder-fg, #1a1a1e)",
    ].join(";");

    banner.append(textSpan, checkBtn);
  }

  textSpan.textContent = statusText;
  textSpan.title = hold.reason || statusText;
  checkBtn.textContent = isZh ? "立即检测" : "Check now";
  checkBtn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onCheckNow(hold.agentId);
  };
}

export function installQuotaQueueGuard(options: {
  win?: Window | null;
  storage?: Storage | null;
  rpcCall?: QuotaQueueRpcCaller;
  getLocale?: () => string;
  nowFn?: () => number;
  retryDelaysMs?: number[];
  heartbeatMs?: number;
}): () => void {
  const win = options.win ?? (typeof window !== "undefined" ? window : null);
  if (!win) return () => {};
  const storage = getSafeStorage(options.storage ?? win.localStorage ?? null);
  const nowFn = options.nowFn ?? (() => Date.now());
  const getLocale = options.getLocale ?? (() => "en");

  if (activeController) {
    activeController.dispose();
  }

  let disposed = false;
  let boundStore: QuotaSessionStoreLike | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let bindPollTimer: ReturnType<typeof setInterval> | null = null;
  let fetchedPersistedEntries = false;
  let pendingRestoreEntries: NonNullable<QuotaQueueRpcResult["entries"]> = [];
  const restoredAgentIds = new Set<string>();
  const serialPendingAgents = new Set<string>();

  const heldStateByAgent = new Map<string, AgentHoldState>();
  const lastDispatchedAtByAgent = new Map<string, number>();
  const prevRunningByAgent = new Map<string, boolean>();
  const prevQueueSigByAgent = new Map<string, string>();
  const pollTimerByAgent = new Map<string, ReturnType<typeof setTimeout>>();
  const checkInFlightByAgent = new Map<string, Promise<QuotaQueueGateDecision | null>>();
  const syncChainByAgent = new Map<string, Promise<void>>();
  const dispatchInFlight = new Set<string>();
  const dispatchFailuresByAgent = new Map<string, number>();
  const retryTimerByAgent = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingDispatchedIdsByAgent = new Map<string, string[]>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;

  const getRuntimeProto = (): HostRuntimeStoreLike | null => {
    const mod = findHostRuntimeModule(win as unknown as MetroWindow);
    return mod?.HostRuntimeStore?.prototype ?? null;
  };

  const getRuntimeInstance = (): HostRuntimeStoreLike | null => {
    const mod = findHostRuntimeModule(win as unknown as MetroWindow);
    try {
      return typeof mod?.getHostRuntimeStore === "function" ? mod.getHostRuntimeStore() : null;
    } catch {
      return null;
    }
  };

  const clearAgentPollTimer = (agentId: string) => {
    const t = pollTimerByAgent.get(agentId);
    if (t !== undefined) {
      clearTimeout(t);
      pollTimerByAgent.delete(agentId);
    }
  };

  const syncAgentToServer = (
    serverId: string,
    agentId: string,
    hold: AgentHoldState | null,
    queued: QuotaQueueItem[],
  ): Promise<void> => {
    if (!options.rpcCall || disposed) return Promise.resolve();
    const state = boundStore?.getState();
    const slice = state?.sessions?.[serverId];
    const agent = slice?.agents?.get(agentId) ?? slice?.agentDetails?.get(agentId);
    const meta = resolveAgentModelAndProvider(agent);
    const prev = syncChainByAgent.get(agentId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        if (!options.rpcCall || disposed) return;
        const dispatchedMessageIds = pendingDispatchedIdsByAgent.get(agentId) ?? [];
        pendingDispatchedIdsByAgent.delete(agentId);
        try {
          const res = await options.rpcCall({
            action: "sync",
            agentId,
            serverId,
            provider: meta.provider,
            model: meta.model,
            title: meta.title,
            held: Boolean(hold?.held),
            reasonCode: hold?.reasonCode ?? "",
            holdReason: hold?.reason ?? "",
            lastErrorText: hold?.lastErrorText ?? null,
            resumeAtMs: hold?.resumeAtMs ?? null,
            queuedMessages: queued,
            ...(dispatchedMessageIds.length > 0 ? { dispatchedMessageIds } : {}),
            source: "runtime-guard",
          });
          dropAlreadySent(serverId, agentId, res?.drainedMessageIds ?? []);
        } catch {
          // Non-fatal sync failure; re-offer the ids on the next sync.
          if (dispatchedMessageIds.length > 0) {
            const again = pendingDispatchedIdsByAgent.get(agentId) ?? [];
            pendingDispatchedIdsByAgent.set(agentId, [...dispatchedMessageIds, ...again]);
          }
        }
      });
    syncChainByAgent.set(agentId, next);
    return next;
  };

  const currentQueue = (serverId: string, agentId: string): QuotaQueueItem[] =>
    boundStore?.getState()?.sessions?.[serverId]?.queuedMessages?.get(agentId) ?? [];

  // The server ledger knows ids another drainer already sent (e.g. headless recovery while this
  // window's heartbeat looked stale). Remove them so they are never sent a second time.
  const dropAlreadySent = (serverId: string, agentId: string, ids: readonly string[]) => {
    if (disposed || ids.length === 0) return;
    const setQueued = boundStore?.getState()?.setQueuedMessages;
    const sent = new Set(ids);
    const before = currentQueue(serverId, agentId);
    const dropped = before.filter((m) => sent.has(m.id));
    if (dropped.length === 0 || typeof setQueued !== "function") return;
    setQueued(serverId, (prev) => {
      const next = new Map(prev);
      const kept = (prev.get(agentId) ?? []).filter((m) => !sent.has(m.id));
      if (kept.length === 0) next.delete(agentId);
      else next.set(agentId, kept);
      return next;
    });
    recordLocalReceipt(
      {
        at: new Date(nowFn()).toISOString(),
        agentId,
        action: "deduped",
        queuedCount: before.length - dropped.length,
        reasonCode: "already_sent",
        detail: `Dropped ${dropped.length} queued message(s) already sent by another drainer (${dropped[0]?.text?.slice(0, 60) ?? ""})`,
      },
      storage,
      win,
    );
  };

  const clearRetryTimer = (agentId: string) => {
    const t = retryTimerByAgent.get(agentId);
    if (t !== undefined) {
      clearTimeout(t);
      retryTimerByAgent.delete(agentId);
    }
  };

  const scheduleDispatchRetry = (serverId: string, agentId: string, attempt: number, errorText: string) => {
    clearRetryTimer(agentId);
    if (attempt >= MAX_DISPATCH_FAILURES) {
      const queuedCount = currentQueue(serverId, agentId).length;
      heldStateByAgent.set(agentId, {
        serverId,
        agentId,
        held: true,
        reasonCode: "dispatch_failed",
        reason: `Queued message failed to send ${attempt} times: ${errorText}`,
        resumeAtMs: null,
        lastErrorText: errorText,
        checkedAtMs: null,
        quotaRefreshed: null,
        previousTurnCompleted: true,
        readyToDrain: false,
        queuedCount,
      });
      updateBanner();
      return;
    }
    const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_DISPATCH_RETRY_DELAYS_MS;
    const delayMs = delays[Math.min(attempt - 1, delays.length - 1)];
    retryTimerByAgent.set(
      agentId,
      setTimeout(() => {
        retryTimerByAgent.delete(agentId);
        if (!disposed) void checkAndMaybeDrain(agentId, false, serverId);
      }, delayMs),
    );
  };

  // Paseo 0.16.1's native drain does NOT return its send promise. It marks `${serverId}:${agentId}`
  // in `queuedAgentDrainInFlight`, clears it in `finally`, and on failure puts the head back at the
  // queue front. So the outcome is read from that state: in-flight cleared + head back = failed.
  // (A returned promise, should upstream add one, is honoured first.)
  // Persist the queue only once the outcome is known, so the server never stores a mid-send snapshot.
  const handleDispatchOutcome = (
    serverId: string,
    agentId: string,
    headId: string | undefined,
    out: unknown,
    runtime: HostRuntimeStoreLike | null,
  ) => {
    const settle = (status: string, errorText: string) => {
      dispatchInFlight.delete(agentId);
      if (disposed) return;
      if (status === "failed") {
        const attempt = (dispatchFailuresByAgent.get(agentId) ?? 0) + 1;
        dispatchFailuresByAgent.set(agentId, attempt);
        lastDispatchedAtByAgent.delete(agentId);
        recordLocalReceipt(
          {
            at: new Date(nowFn()).toISOString(),
            agentId,
            action: "dispatch_failed",
            queuedCount: currentQueue(serverId, agentId).length,
            reasonCode: "send_failed",
            detail: `Send failed (attempt ${attempt}): ${errorText.slice(0, 160)}`,
          },
          storage,
          win,
        );
        scheduleDispatchRetry(serverId, agentId, attempt, errorText);
      } else if (status === "submitted") {
        dispatchFailuresByAgent.delete(agentId);
        clearRetryTimer(agentId);
        if (headId) {
          pendingDispatchedIdsByAgent.set(agentId, [...(pendingDispatchedIdsByAgent.get(agentId) ?? []), headId]);
        }
      }
      void syncAgentToServer(serverId, agentId, heldStateByAgent.get(agentId) ?? null, currentQueue(serverId, agentId));
      updateBanner();
    };
    if (out && typeof (out as PromiseLike<unknown>).then === "function") {
      dispatchInFlight.add(agentId);
      (out as PromiseLike<unknown>).then(
        (r) => {
          const res = (r ?? {}) as { status?: unknown; errorMessage?: unknown };
          settle(String(res.status ?? "submitted"), String(res.errorMessage ?? "unknown error"));
        },
        (err: unknown) => settle("failed", err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const inFlight = runtime?.queuedAgentDrainInFlight;
    const key = `${serverId}:${agentId}`;
    if (inFlight instanceof Set && inFlight.has(key)) {
      dispatchInFlight.add(agentId);
      const startedAt = Date.now();
      const poll = () => {
        if (disposed) {
          dispatchInFlight.delete(agentId);
          return;
        }
        if (inFlight.has(key) && Date.now() - startedAt < DISPATCH_OUTCOME_TIMEOUT_MS) {
          setTimeout(poll, DISPATCH_OUTCOME_POLL_MS);
          return;
        }
        const restored = Boolean(headId) && currentQueue(serverId, agentId)[0]?.id === headId;
        if (inFlight.has(key)) settle("unknown", "");
        else if (restored) settle("failed", "Paseo could not send the queued message (see daemon.log)");
        else settle("submitted", "");
      };
      setTimeout(poll, DISPATCH_OUTCOME_POLL_MS);
      return;
    }
    // Native declined (nothing in flight) or a legacy drain: just persist what is left shortly after.
    setTimeout(() => settle("unknown", ""), 150);
  };

  const isStalledQueue = (serverId: string, agentId: string): boolean => {
    const slice = boundStore?.getState()?.sessions?.[serverId];
    const agent = slice?.agents?.get(agentId) ?? slice?.agentDetails?.get(agentId);
    if (!agent) return false;
    if (isAgentRunningSnapshot(agent) || slice?.initializingAgents?.get(agentId)) return false;
    if (hasAgentPendingPermission(slice, agentId)) return false;
    if (heldStateByAgent.get(agentId)?.held) return false;
    if (
      dispatchInFlight.has(agentId) ||
      retryTimerByAgent.has(agentId) ||
      pollTimerByAgent.has(agentId) ||
      checkInFlightByAgent.has(agentId)
    ) {
      return false;
    }
    const last = lastDispatchedAtByAgent.get(agentId);
    return !(typeof last === "number" && nowFn() - last < STALL_GRACE_MS);
  };

  const heartbeatTick = () => {
    if (disposed || !boundStore) return;
    const prefs = readQuotaQueuePrefs(storage);
    if (!prefs.enabled) return;
    const sessions = boundStore.getState()?.sessions ?? {};
    for (const [serverId, slice] of Object.entries(sessions)) {
      for (const [agentId, items] of slice?.queuedMessages?.entries() ?? []) {
        if (!items || items.length === 0) continue;
        void syncAgentToServer(serverId, agentId, heldStateByAgent.get(agentId) ?? null, items);
        if (prefs.autoDrain && isStalledQueue(serverId, agentId)) {
          void checkAndMaybeDrain(agentId, false, serverId);
        }
      }
    }
  };

  const updateBanner = () => {
    if (disposed || !win.document) return;
    const isZh = getLocale().toLowerCase().startsWith("zh");
    const routeAgentId = extractRouteAgentId(win) ?? extractDomSelectedAgentId(win.document);
    const routeWorkspaceId = extractRouteWorkspaceId(win);
    const sessions = boundStore?.getState()?.sessions ?? {};
    let activeHold: AgentHoldState | null = null;
    let activeQueued = 0;

    if (routeAgentId) {
      const h = heldStateByAgent.get(routeAgentId);
      if (h && h.held) {
        const qLen = sessions[h.serverId]?.queuedMessages?.get(routeAgentId)?.length ?? 0;
        if (qLen > 0) {
          activeHold = h;
          activeQueued = qLen;
        }
      }
    } else if (routeWorkspaceId) {
      for (const h of heldStateByAgent.values()) {
        if (!h.held) continue;
        const slice = sessions[h.serverId];
        const ag = slice?.agents?.get(h.agentId) ?? slice?.agentDetails?.get(h.agentId);
        if (String(ag?.workspaceId ?? "") !== routeWorkspaceId) continue;
        const qLen = slice?.queuedMessages?.get(h.agentId)?.length ?? 0;
        if (qLen > 0) {
          activeHold = h;
          activeQueued = qLen;
          break;
        }
      }
    } else {
      const pathStr = String(win.location?.pathname ?? "");
      if (!pathStr.includes("/settings") && !pathStr.includes("/schedules")) {
        // Fallback only when no workspace/agent route is present (e.g. root single-agent test)
        for (const h of heldStateByAgent.values()) {
          const qLen = sessions[h.serverId]?.queuedMessages?.get(h.agentId)?.length ?? 0;
          if (h.held && qLen > 0) {
            activeHold = h;
            activeQueued = qLen;
            break;
          }
        }
      }
    }

    renderHoldBanner({
      doc: win.document,
      win,
      hold: activeHold,
      queuedCount: activeQueued,
      isZh,
      onCheckNow: (aid) => {
        void checkAndMaybeDrain(aid, true);
      },
    });
  };

  const evaluateLocalSnapshot = (
    serverId: string,
    agentId: string,
  ): {
    prefs: QuotaQueueGuardPrefs;
    slice: SessionStoreSlice | undefined;
    agent: SessionStoreAgentEntry | undefined;
    queued: QuotaQueueItem[];
    turnSignal: LatestTurnQuotaSignal;
    decision: QuotaQueueGateDecision;
  } => {
    const prefs = readQuotaQueuePrefs(storage);
    const slice = boundStore?.getState()?.sessions?.[serverId];
    const agent = slice?.agents?.get(agentId) ?? slice?.agentDetails?.get(agentId);
    const queued = slice?.queuedMessages?.get(agentId) ?? [];
    const timeline = collectAgentTimelineItems(slice, agentId);
    const nowMs = nowFn();
    const turnSignal = extractLatestTurnQuotaSignal(agent, timeline, nowMs);
    const serverHold = heldStateByAgent.get(agentId);
    const serverFresh =
      serverHold && serverHold.checkedAtMs !== null && nowMs - serverHold.checkedAtMs < 60_000;

    const decision = evaluateQuotaQueueDrainGate({
      enabled: prefs.enabled,
      queuedCount: queued.length,
      initializing: Boolean(slice?.initializingAgents?.get(agentId)),
      agentRunning: isAgentRunningSnapshot(agent),
      hasPendingPermission: hasAgentPendingPermission(slice, agentId),
      turnSignal,
      serverReadyToDrain: serverFresh ? serverHold.readyToDrain : null,
      serverPreviousTurnCompleted: serverFresh ? serverHold.previousTurnCompleted : null,
      serverHoldReason: serverHold?.reason || null,
      serverResumeAtMs: serverHold?.resumeAtMs ?? null,
      lastDispatchedAtMs: lastDispatchedAtByAgent.get(agentId) ?? null,
      nowMs,
    });

    return { prefs, slice, agent, queued, turnSignal, decision };
  };

  const scheduleHoldCheck = (
    serverId: string,
    agentId: string,
    resumeAtMs: number | null,
    reasonCode?: string,
  ) => {
    if (disposed || pollTimerByAgent.has(agentId)) return;
    const prefs = readQuotaQueuePrefs(storage);
    if (!prefs.enabled || !prefs.autoDrain) return;

    const nowMs = nowFn();
    let delayMs =
      reasonCode === "drain_cooldown"
        ? 1_500
        : reasonCode === "agent_running"
          ? 60_000
          : 20_000;
    if (resumeAtMs && resumeAtMs > nowMs) {
      const remaining = resumeAtMs - nowMs;
      // Check slightly more often if near expiry, otherwise every 45s so early pool/credit recovery is caught promptly
      if (reasonCode === "drain_cooldown") {
        delayMs = Math.max(300, remaining + 100);
      } else {
        delayMs = remaining <= 60_000 ? Math.max(5_000, remaining + 1_000) : 45_000;
      }
    }

    const timer = setTimeout(() => {
      pollTimerByAgent.delete(agentId);
      if (disposed) return;
      void checkAndMaybeDrain(agentId, false, serverId);
    }, delayMs);
    pollTimerByAgent.set(agentId, timer);
  };

  const callOriginalDrain = (serverId: string, agentId: string): boolean => {
    const runtime = getRuntimeInstance();
    const proto = getRuntimeProto();
    const patchInfo = proto?.[PATCH_MARKER_KEY as keyof HostRuntimeStoreLike] as
      | { origDrain?: (s: string, a: string) => unknown }
      | undefined;
    const orig = patchInfo?.origDrain;
    if (!runtime || typeof orig !== "function") return false;
    lastDispatchedAtByAgent.set(agentId, nowFn());
    const headId = currentQueue(serverId, agentId)[0]?.id;
    handleDispatchOutcome(serverId, agentId, headId, orig.call(runtime, serverId, agentId), runtime);
    return true;
  };

  const checkAndMaybeDrain = async (
    agentId: string,
    bypassDebounce: boolean,
    explicitServerId?: string,
  ): Promise<QuotaQueueGateDecision | null> => {
    if (disposed) return null;
    const existingFlight = checkInFlightByAgent.get(agentId);
    if (existingFlight) return existingFlight;

    if (bypassDebounce) dispatchFailuresByAgent.delete(agentId);
    const run = (async (): Promise<QuotaQueueGateDecision | null> => {
      const serverId =
        explicitServerId ??
        heldStateByAgent.get(agentId)?.serverId ??
        findServerIdForAgent(agentId);
      if (!serverId) return null;

      const { prefs, slice, agent, queued, turnSignal } = evaluateLocalSnapshot(serverId, agentId);
      if (queued.length === 0) {
        heldStateByAgent.delete(agentId);
        clearAgentPollTimer(agentId);
        updateBanner();
        return null;
      }
      if (!prefs.enabled) {
        heldStateByAgent.delete(agentId);
        clearAgentPollTimer(agentId);
        updateBanner();
        if (prefs.autoDrain) callOriginalDrain(serverId, agentId);
        return { allow: true, reasonCode: "disabled", reason: "Disabled", resumeAtMs: null };
      }

      const locallyRunningOrInit =
        isAgentRunningSnapshot(agent) || Boolean(slice?.initializingAgents?.get(agentId));

      // Smart Skip: While the agent is visibly running/initializing in useSessionStore, do not
      // spawn `antigravity-ops paseo-recovery` subprocesses on the plugin worker every 20s;
      // `onStoreUpdate` triggers `checkAndMaybeDrain` immediately once the turn settles.
      if (options.rpcCall && (bypassDebounce || !locallyRunningOrInit)) {
        try {
          const rpcRes = await options.rpcCall({
            action: "check",
            agentId,
            serverId,
            triggerRecoveryIfReady: true,
            source: bypassDebounce ? "settings-ui" : "runtime-guard",
          });
          const resumeAtMs = rpcRes.resumeAtIso ? Date.parse(rpcRes.resumeAtIso) : null;
          const prev = heldStateByAgent.get(agentId);
          const nextReasonCode = rpcRes.readyToDrain
            ? "ok"
            : rpcRes.quotaRefreshed === true
              ? "agent_running"
              : "quota_wait";
          heldStateByAgent.set(agentId, {
            serverId,
            agentId,
            held: !rpcRes.readyToDrain,
            reasonCode: nextReasonCode,
            reason: rpcRes.holdReason || prev?.reason || "Waiting for quota refresh",
            resumeAtMs:
              rpcRes.quotaRefreshed === true
                ? null
                : (Number.isFinite(resumeAtMs) ? resumeAtMs : (prev?.resumeAtMs ?? null)),
            lastErrorText:
              rpcRes.quotaRefreshed === true
                ? null
                : (prev?.lastErrorText ?? turnSignal.errorText),
            checkedAtMs: nowFn(),
            quotaRefreshed: rpcRes.quotaRefreshed,
            previousTurnCompleted: rpcRes.previousTurnCompleted,
            readyToDrain: rpcRes.readyToDrain,
            queuedCount: queued.length,
          });
        } catch {
          // Keep current hold state on RPC error
        }
      }

      const post = evaluateLocalSnapshot(serverId, agentId);
      if (post.decision.allow) {
        heldStateByAgent.delete(agentId);
        clearAgentPollTimer(agentId);
        updateBanner();
        if (post.prefs.autoDrain) {
          const hadMoreThanOne = post.queued.length > 1;
          const sent = callOriginalDrain(serverId, agentId);
          if (sent) {
            if (hadMoreThanOne) serialPendingAgents.add(agentId);
            else serialPendingAgents.delete(agentId);
            recordLocalReceipt(
              {
                at: new Date(nowFn()).toISOString(),
                agentId,
                action: "drained_one",
                queuedCount: Math.max(0, post.queued.length - 1),
                reasonCode: "ok",
                detail: `Quota refreshed; drained 1 queued message (${post.queued[0]?.text?.slice(0, 60) ?? ""})`,
              },
              storage,
              win,
            );
          }
        }
      } else {
        const prev = heldStateByAgent.get(agentId);
        const hold: AgentHoldState = {
          serverId,
          agentId,
          held: true,
          reasonCode: post.decision.reasonCode,
          reason: post.decision.reason,
          resumeAtMs: post.decision.resumeAtMs ?? prev?.resumeAtMs ?? null,
          lastErrorText: post.turnSignal.errorText ?? prev?.lastErrorText ?? null,
          checkedAtMs: prev?.checkedAtMs ?? null,
          quotaRefreshed: prev?.quotaRefreshed ?? false,
          previousTurnCompleted: prev?.previousTurnCompleted ?? false,
          readyToDrain: false,
          queuedCount: post.queued.length,
        };
        heldStateByAgent.set(agentId, hold);
        updateBanner();
        scheduleHoldCheck(serverId, agentId, hold.resumeAtMs, hold.reasonCode);
      }

      return post.decision;
    })().finally(() => {
      checkInFlightByAgent.delete(agentId);
    });

    checkInFlightByAgent.set(agentId, run);
    return run;
  };

  const findServerIdForAgent = (agentId: string): string | null => {
    const sessions = boundStore?.getState()?.sessions ?? {};
    for (const [sid, slice] of Object.entries(sessions)) {
      if (slice?.agents?.has(agentId) || slice?.queuedMessages?.has(agentId)) {
        return sid;
      }
    }
    return null;
  };

  const installRuntimeDrainPatch = (): boolean => {
    const proto = getRuntimeProto();
    if (!proto || typeof proto.drainQueuedAgentMessage !== "function") return false;

    const existingPatch = proto[PATCH_MARKER_KEY as keyof HostRuntimeStoreLike] as
      | { evalToken?: symbol; origDrain?: (s: string, a: string) => unknown }
      | undefined;

    if (existingPatch?.evalToken === evalToken) {
      return true;
    }

    const origDrain = existingPatch?.origDrain ?? proto.drainQueuedAgentMessage;
    const wrappedDrain = function wrappedDrainQueuedAgentMessage(
      this: HostRuntimeStoreLike,
      serverId: string,
      agentId: string,
    ) {
      if (disposed || !boundStore) {
        return origDrain.call(this, serverId, agentId);
      }

      const { prefs, queued, turnSignal, decision } = evaluateLocalSnapshot(serverId, agentId);
      if (!prefs.enabled || queued.length === 0) {
        return origDrain.call(this, serverId, agentId);
      }

      // Hold immediately whenever quota error, incomplete previous turn, or active hold is present
      if (!decision.allow) {
        const prev = heldStateByAgent.get(agentId);
        const hold: AgentHoldState = {
          serverId,
          agentId,
          held: true,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
          resumeAtMs: decision.resumeAtMs ?? prev?.resumeAtMs ?? null,
          lastErrorText: turnSignal.errorText ?? prev?.lastErrorText ?? null,
          checkedAtMs: prev?.checkedAtMs ?? null,
          quotaRefreshed: false,
          previousTurnCompleted: decision.reasonCode !== "previous_turn_incomplete" && !turnSignal.previousTurnIncomplete,
          readyToDrain: false,
          queuedCount: queued.length,
        };
        heldStateByAgent.set(agentId, hold);
        recordLocalReceipt(
          {
            at: new Date(nowFn()).toISOString(),
            agentId,
            action: "held",
            queuedCount: queued.length,
            reasonCode: decision.reasonCode,
            detail: decision.reason,
          },
          storage,
          win,
        );
        void syncAgentToServer(serverId, agentId, hold, queued);
        updateBanner();
        scheduleHoldCheck(serverId, agentId, hold.resumeAtMs, hold.reasonCode);
        return;
      }

      // Even if local timeline has no quota text yet, if this agent had an error or an active hold,
      // confirm with backend before allowing drain so we never pour into a cooling pool.
      if (turnSignal.hasAnyError || heldStateByAgent.has(agentId)) {
        const existingHold = heldStateByAgent.get(agentId);
        const freshlyChecked =
          existingHold?.checkedAtMs !== null &&
          existingHold?.checkedAtMs !== undefined &&
          nowFn() - existingHold.checkedAtMs < 8_000 &&
          existingHold.readyToDrain;
        if (!freshlyChecked) {
          void checkAndMaybeDrain(agentId, false, serverId);
          return;
        }
      }

      // Allowed: drain strictly 1 item (`o[0]`) and record dispatch timestamp for serial pacing
      if (queued.length > 1) serialPendingAgents.add(agentId);
      else serialPendingAgents.delete(agentId);
      lastDispatchedAtByAgent.set(agentId, nowFn());
      const out = origDrain.call(this, serverId, agentId);
      handleDispatchOutcome(serverId, agentId, queued[0]?.id, out, this);
      recordLocalReceipt(
        {
          at: new Date(nowFn()).toISOString(),
          agentId,
          action: "drained_one",
          queuedCount: Math.max(0, queued.length - 1),
          reasonCode: "ok",
          detail: `Dispatched 1 queued message (${queued[0]?.text?.slice(0, 60) ?? ""})`,
        },
        storage,
        win,
      );
      return out;
    };

    proto.drainQueuedAgentMessage = wrappedDrain;
    (proto as Record<string, unknown>)[PATCH_MARKER_KEY] = {
      evalToken,
      origDrain,
    };
    return true;
  };

  const applyPendingRestores = () => {
    if (disposed || !boundStore || pendingRestoreEntries.length === 0) return;
    const state = boundStore.getState();
    const sessions = state.sessions ?? {};
    const setQueued = state.setQueuedMessages;
    const stillPending: NonNullable<QuotaQueueRpcResult["entries"]> = [];
    let restoredAny = false;

    for (const entry of pendingRestoreEntries) {
      if (restoredAgentIds.has(entry.agentId)) continue;
      if (!entry.queuedMessages || entry.queuedMessages.length === 0) continue;

      const byExplicitServer =
        sessions[entry.serverId]?.agents?.has(entry.agentId) ? entry.serverId : undefined;
      const byAgentScan = Object.keys(sessions).find((sid) =>
        sessions[sid]?.agents?.has(entry.agentId),
      );
      const targetServerId = byExplicitServer ?? byAgentScan;
      if (!targetServerId) {
        stillPending.push(entry);
        continue;
      }

      restoredAgentIds.add(entry.agentId);
      restoredAny = true;
      const existingQueue = sessions[targetServerId]?.queuedMessages?.get(entry.agentId) ?? [];
      if (existingQueue.length === 0 && typeof setQueued === "function") {
        setQueued(targetServerId, (prev) => {
          const next = new Map(prev);
          next.set(entry.agentId, entry.queuedMessages);
          return next;
        });
        recordLocalReceipt(
          {
            at: new Date(nowFn()).toISOString(),
            agentId: entry.agentId,
            action: "restored",
            queuedCount: entry.queuedMessages.length,
            reasonCode: entry.reasonCode || "restored",
            detail: `Restored ${entry.queuedMessages.length} held queued message(s) after reload`,
          },
          storage,
          win,
        );
      }

      if (entry.held) {
        const entryQuotaRefreshed =
          entry.quotaRefreshed === true ||
          entry.reasonCode === "agent_running" ||
          entry.reasonCode === "previous_turn_incomplete";
        const resumeMs =
          entryQuotaRefreshed || !entry.resumeAtIso ? null : Date.parse(entry.resumeAtIso);
        heldStateByAgent.set(entry.agentId, {
          serverId: targetServerId,
          agentId: entry.agentId,
          held: true,
          reasonCode: entry.reasonCode || (entryQuotaRefreshed ? "agent_running" : "quota_error_hold"),
          reason: entry.holdReason || "Waiting for quota refresh",
          resumeAtMs: resumeMs !== null && Number.isFinite(resumeMs) ? resumeMs : null,
          lastErrorText: entryQuotaRefreshed ? null : (entry.lastErrorText ?? null),
          checkedAtMs: null,
          quotaRefreshed: entryQuotaRefreshed,
          previousTurnCompleted: Boolean(entry.previousTurnCompleted),
          readyToDrain: false,
          queuedCount: Math.max(existingQueue.length, entry.queuedMessages.length),
        });
        scheduleHoldCheck(
          targetServerId,
          entry.agentId,
          resumeMs !== null && Number.isFinite(resumeMs) ? resumeMs : null,
          entry.reasonCode || (entryQuotaRefreshed ? "agent_running" : "quota_error_hold"),
        );
      } else if (entry.queuedMessages.length > 0) {
        serialPendingAgents.add(entry.agentId);
      }
    }

    pendingRestoreEntries = stillPending;
    if (restoredAny) {
      updateBanner();
    }
  };

  const restorePersistedQueuesIfEmpty = async () => {
    if (fetchedPersistedEntries || !options.rpcCall || !boundStore || disposed) return;
    fetchedPersistedEntries = true;
    try {
      const status = await options.rpcCall({ action: "status", source: "runtime-guard" });
      const entries = status.entries ?? [];
      if (entries.length === 0) return;
      pendingRestoreEntries = entries;
      applyPendingRestores();
    } catch {
      fetchedPersistedEntries = false;
    }
  };

  const reconcileFromServer = (
    res: QuotaQueueRpcResult & { action?: string; agentId?: string },
  ) => {
    if (disposed || !boundStore) return;
    const state = boundStore.getState();
    const sessions = state.sessions ?? {};
    const setQueued = state.setQueuedMessages;
    const entriesByAgent = new Map((res.entries ?? []).map((e) => [e.agentId, e]));

    if (res.action === "reset") {
      for (const aid of heldStateByAgent.keys()) clearAgentPollTimer(aid);
      heldStateByAgent.clear();
      serialPendingAgents.clear();
      pendingRestoreEntries = [];
      updateBanner();
      return;
    }

    const targetAgents = new Set<string>([
      ...heldStateByAgent.keys(),
      ...entriesByAgent.keys(),
      ...(res.agentId ? [res.agentId] : []),
    ]);
    for (const aid of targetAgents) {
      const entry = entriesByAgent.get(aid);
      const serverId =
        entry?.serverId && sessions[entry.serverId]
          ? entry.serverId
          : (heldStateByAgent.get(aid)?.serverId ?? findServerIdForAgent(aid));
      if (!serverId) continue;

      if (!entry) {
        heldStateByAgent.delete(aid);
        serialPendingAgents.delete(aid);
        clearAgentPollTimer(aid);
        if (typeof setQueued === "function") {
          setQueued(serverId, (prev) => {
            if (!prev.has(aid)) return prev;
            const next = new Map(prev);
            next.delete(aid);
            return next;
          });
        }
        continue;
      }

      if (typeof setQueued === "function") {
        setQueued(serverId, (prev) => {
          const next = new Map(prev);
          if (entry.queuedMessages.length === 0) next.delete(aid);
          else next.set(aid, entry.queuedMessages);
          return next;
        });
      }

      if (entry.held) {
        const entryQuotaRefreshed =
          res.quotaRefreshed === true ||
          entry.quotaRefreshed === true ||
          entry.reasonCode === "agent_running" ||
          entry.reasonCode === "previous_turn_incomplete";
        const resumeMs =
          entryQuotaRefreshed || !entry.resumeAtIso ? null : Date.parse(entry.resumeAtIso);
        heldStateByAgent.set(aid, {
          serverId,
          agentId: aid,
          held: true,
          reasonCode: entry.reasonCode || (entryQuotaRefreshed ? "agent_running" : "quota_error_hold"),
          reason: entry.holdReason || "Waiting for quota refresh",
          resumeAtMs: resumeMs !== null && Number.isFinite(resumeMs) ? resumeMs : null,
          lastErrorText: entryQuotaRefreshed ? null : (entry.lastErrorText ?? null),
          checkedAtMs: nowFn(),
          quotaRefreshed: entryQuotaRefreshed,
          previousTurnCompleted: Boolean(res.previousTurnCompleted),
          readyToDrain: Boolean(res.readyToDrain),
          queuedCount: entry.queuedMessages.length,
        });
      } else {
        heldStateByAgent.delete(aid);
        clearAgentPollTimer(aid);
        if (entry.queuedMessages.length > 0) serialPendingAgents.add(aid);
        else serialPendingAgents.delete(aid);
      }
    }
    updateBanner();
  };

  const onStoreUpdate = () => {
    if (disposed || !boundStore) return;
    installRuntimeDrainPatch();
    if (pendingRestoreEntries.length > 0) {
      applyPendingRestores();
    }
    const sessions = boundStore.getState()?.sessions ?? {};

    for (const [serverId, slice] of Object.entries(sessions)) {
      const queuedMap = slice?.queuedMessages;
      const agentsMap = slice?.agents;

      if (queuedMap) {
        for (const [agentId, items] of queuedMap.entries()) {
          const sig = `${items.length}:${items.map((x) => x.id).join(",")}`;
          if (prevQueueSigByAgent.get(agentId) !== sig) {
            prevQueueSigByAgent.set(agentId, sig);
            let hold = heldStateByAgent.get(agentId) ?? null;
            if (items.length > 0 && !hold?.held && agentsMap?.get(agentId)?.status === "error") {
              const ev = evaluateLocalSnapshot(serverId, agentId);
              if (!ev.decision.allow) {
                hold = {
                  serverId,
                  agentId,
                  held: true,
                  reasonCode: ev.decision.reasonCode,
                  reason: ev.decision.reason,
                  resumeAtMs: ev.decision.resumeAtMs,
                  lastErrorText: ev.turnSignal.errorText ?? null,
                  checkedAtMs: null,
                  quotaRefreshed: false,
                  previousTurnCompleted:
                    ev.decision.reasonCode !== "previous_turn_incomplete" &&
                    !ev.turnSignal.previousTurnIncomplete,
                  readyToDrain: false,
                  queuedCount: items.length,
                };
                heldStateByAgent.set(agentId, hold);
                scheduleHoldCheck(serverId, agentId, hold.resumeAtMs, hold.reasonCode);
              }
            }
            if (items.length > 0 && !dispatchInFlight.has(agentId)) {
              void syncAgentToServer(serverId, agentId, hold?.held ? hold : null, items);
            } else if (items.length === 0 && hold) {
              heldStateByAgent.delete(agentId);
              serialPendingAgents.delete(agentId);
              clearAgentPollTimer(agentId);
              void syncAgentToServer(serverId, agentId, null, []);
            }
          }
        }
      }

      if (agentsMap) {
        for (const [agentId, agent] of agentsMap.entries()) {
          const runningNow = isAgentRunningSnapshot(agent);
          const wasRunning = prevRunningByAgent.get(agentId) ?? false;
          prevRunningByAgent.set(agentId, runningNow);

          if (wasRunning && !runningNow && (heldStateByAgent.has(agentId) || serialPendingAgents.has(agentId))) {
            const qLen = queuedMap?.get(agentId)?.length ?? 0;
            if (qLen > 0) {
              setTimeout(() => {
                if (!disposed) void checkAndMaybeDrain(agentId, false, serverId);
              }, 350);
            } else {
              serialPendingAgents.delete(agentId);
            }
          }
        }
      }
    }

    updateBanner();
  };

  const tryBind = () => {
    if (disposed) return;
    installRuntimeDrainPatch();
    const store = findQuotaSessionStore(win as unknown as MetroWindow);
    if (!store) return;
    boundStore = store;
    if (bindPollTimer !== null) {
      clearInterval(bindPollTimer);
      bindPollTimer = null;
    }
    if (typeof store.subscribe === "function") {
      unsubscribeStore = store.subscribe(onStoreUpdate);
    }
    void restorePersistedQueuesIfEmpty();
    onStoreUpdate();
    if (heartbeatTimer === null) {
      const everyMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      heartbeatTimer = setInterval(heartbeatTick, everyMs);
      // First sweep soon after bind, so a queue stranded before a reload does not wait a full period.
      firstSweepTimer = setTimeout(() => {
        firstSweepTimer = null;
        heartbeatTick();
      }, Math.min(2_000, everyMs));
    }
  };

  tryBind();
  if (!boundStore) {
    let attempts = 0;
    bindPollTimer = setInterval(() => {
      attempts += 1;
      tryBind();
      if (boundStore || attempts >= 40) {
        if (bindPollTimer !== null) {
          clearInterval(bindPollTimer);
          bindPollTimer = null;
        }
      }
    }, 250);
  }

  const onRouteOrFocus = () => {
    updateBanner();
  };
  win.addEventListener("popstate", onRouteOrFocus);
  win.addEventListener("hashchange", onRouteOrFocus);

  const getStatusSnapshot = () => {
    const prefs = readQuotaQueuePrefs(storage);
    const proto = getRuntimeProto();
    const patch = proto?.[PATCH_MARKER_KEY as keyof HostRuntimeStoreLike] as
      | { evalToken?: symbol }
      | undefined;
    return {
      prefs,
      installed: Boolean(proto && patch?.evalToken === evalToken),
      storeAvailable: Boolean(boundStore),
      heldAgents: Array.from(heldStateByAgent.values()),
      receipts: readLocalReceipts(storage),
    };
  };

  const dispose = () => {
    disposed = true;
    if (bindPollTimer !== null) {
      clearInterval(bindPollTimer);
      bindPollTimer = null;
    }
    if (unsubscribeStore) {
      unsubscribeStore();
      unsubscribeStore = null;
    }
    for (const t of pollTimerByAgent.values()) clearTimeout(t);
    pollTimerByAgent.clear();
    for (const t of retryTimerByAgent.values()) clearTimeout(t);
    retryTimerByAgent.clear();
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (firstSweepTimer !== null) clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
    win.removeEventListener("popstate", onRouteOrFocus);
    win.removeEventListener("hashchange", onRouteOrFocus);
    removeHoldBanner(win.document);
    if (activeController?.dispose === dispose) {
      activeController = null;
    }
  };

  activeController = {
    dispose,
    getStatus: getStatusSnapshot,
    inspectAgent: (agentId: string) => {
      const sid = findServerIdForAgent(agentId) ?? "local";
      const ev = evaluateLocalSnapshot(sid, agentId);
      return {
        serverId: sid,
        agentId,
        queuedCount: ev.queued.length,
        turnSignal: ev.turnSignal,
        decision: ev.decision,
        hold: heldStateByAgent.get(agentId) ?? null,
      };
    },
    checkNow: (agentId: string) => checkAndMaybeDrain(agentId, true),
    release: async (agentId: string) => {
      const sid = heldStateByAgent.get(agentId)?.serverId ?? findServerIdForAgent(agentId);
      heldStateByAgent.delete(agentId);
      clearAgentPollTimer(agentId);
      if (options.rpcCall) {
        await options.rpcCall({ action: "release", agentId, serverId: sid ?? undefined, source: "settings-ui" });
      }
      updateBanner();
      if (sid && readQuotaQueuePrefs(storage).autoDrain) {
        callOriginalDrain(sid, agentId);
      }
    },
    reconcileFromServer,
  };

  (win as unknown as Record<string, unknown>)[GLOBAL_BRIDGE_KEY] = {
    status: getStatusSnapshot,
    inspectAgent: activeController.inspectAgent,
    checkNow: activeController.checkNow,
    release: activeController.release,
    reconcileFromServer,
    setPrefs: (partial: Partial<QuotaQueueGuardPrefs>) =>
      syncQuotaQueuePrefs(partial, storage, win),
  };

  return dispose;
}
