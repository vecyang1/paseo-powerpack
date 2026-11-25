/// <reference lib="dom" />
/**
 * Sidebar child sessions (T-055): a session that another session started is listed under its
 * parent in the left sidebar, the way Claude's desktop app nests sub-sessions.
 *
 * Which sessions are children is decided in `shared/sidebar-child-sessions.ts` from Paseo's own
 * session store (`parentAgentId`, the daemon-written `paseo.parent-agent-id` label). This module
 * only places them:
 *
 * - Child workspace (the child runs in its own workspace): Paseo already renders a native row
 *   for it. We keep that row (its menu, status, rename stay native) and move it under the parent
 *   row with CSS `order` on the list item, plus an indent and a connector. No list item is moved
 *   or added, so the list's own children stay exactly what React rendered.
 * - Tab child (the child runs in its parent's workspace): Paseo shows it only as a tab, never in
 *   the sidebar. We add a light row under the workspace row that opens the tab. That block sits
 *   inside the row's parent element (React-owned, like the T-037 subagents tree beside it).
 *
 * Two places where CSS order must not lie:
 * - When a list's children change, the `order` rules name stale slots, so the observer re-renders
 *   synchronously (before paint) instead of waiting for the throttle.
 * - Rows are dnd-kit sortables, which compute the drop index from the items array, not from
 *   where CSS drew them. dnd-kit starts a mouse drag once the press has moved more than
 *   DRAG_START_PX (Paseo 0.15.3 `getDragActivationConstraints`; touch: a 180 ms hold). At that
 *   distance (touch: after 120 ms) this list's rules are suspended until release. The
 *   capture-phase `pointermove` runs before dnd-kit's `mousemove` for the same input, so dnd-kit
 *   measures Paseo's own order. A click with a few px of trackpad jitter stays nested.
 *
 * Upstream test ids used (`components/sidebar-workspace-list.tsx`, Paseo 0.15.3):
 *   row        `sidebar-workspace-row-<serverId>:<workspaceId>`
 *   lists      `sidebar-workspace-list-<viewKey>` | `sidebar-status-group-rows-<key>` | `sidebar-pinned-list`
 *
 * 能读 / 能试 / 能调: Settings -> Plugins -> File Inspector & Finder -> "Sub-sessions in the
 * sidebar" (status, self-test that measures row positions, toggles). Agents read the same plan
 * from disk with `scripts/sidebar-child-sessions-plan.mts`.
 */
import {
  DEFAULT_SUBSESSION_MODEL_ICON_MODE,
  compareSessionBrands,
  normalizeSubsessionModelIconMode,
  shouldShowModelBrandIcon,
  type ModelBrandId,
  type SubsessionModelIconMode,
} from "../shared/model-brand-icons";
import {
  childWorkspaceDepth,
  orderSidebarRows,
  planChildSessions,
  type ChildSessionAgent,
  type ChildSessionPlan,
  type ChildSessionSkip,
  type TabChildRow,
} from "../shared/sidebar-child-sessions";
import {
  MODEL_BRAND_ICON_TESTID,
  createModelBrandIconElement,
} from "./model-brand-icon-web";
import {
  extractCurrentWorkspaceAndAgent,
  getMetroModuleList,
  navigateToLineageNode,
} from "./session-lineage-web";
import { resolveActivePaseoTheme } from "./theme-web";

export interface SidebarChildSessionsPrefs {
  enabled: boolean;
  /** Also list children that run as tabs in their parent's workspace. */
  tabChildren: boolean;
  /** Show model-company brand icon on sub-sessions (always | different | off). */
  modelIcons?: SubsessionModelIconMode;
}

export interface NestedWorkspaceStatus {
  workspaceId: string;
  parentWorkspaceId: string;
  title: string;
  parentTitle: string;
  depth: number;
  /** null = one of the two rows is not on screen (collapsed project, hidden sidebar). */
  onScreen: boolean;
  brand?: ModelBrandId;
  modelSummary?: string;
  differsFromParent?: boolean;
}

export interface SidebarChildSessionsStatus {
  prefs: SidebarChildSessionsPrefs;
  installed: boolean;
  storeFound: boolean;
  renderedAt: string | null;
  nested: NestedWorkspaceStatus[];
  tabRows: Array<{
    workspaceId: string;
    title: string;
    count: number;
    onScreen: boolean;
    crossModelCount?: number;
  }>;
  skipped: Array<ChildSessionSkip & { title: string }>;
  cssRules: number;
  /** Last render's cost; renders run on store updates (throttled) and on sidebar list changes. */
  renderMs: number;
  /** A press or drag is in progress in this list, so its order rules are off until release. */
  suspendedList: string | null;
  /** Paseo's `navigateToAgent` was found (tab rows open through it). */
  nativeNavigation: boolean;
  crossModelCount?: number;
  modelIconsShown?: number;
}

export interface SidebarChildSessionsCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export const SIDEBAR_CHILD_SESSIONS_EVENT = "paseo-finder:sidebar-child-sessions";
export const ROW_PREFIX = "sidebar-workspace-row-";
export const TAB_BLOCK_TESTID = "paseo-finder-sidebar-child-rows";
export const TAB_ROW_TESTID = "paseo-finder-sidebar-child-row";
export const MOVED_BRAND_BADGE_TESTID = "paseo-finder-moved-child-brand";
const STYLE_ID = "paseo-finder-sidebar-child-sessions-style";
const PREFS_KEY = "paseo:finder-plugin:sidebar-child-sessions";
const LIST_SELECTOR =
  '[data-testid^="sidebar-workspace-list-"],[data-testid^="sidebar-status-group-rows-"],[data-testid="sidebar-pinned-list"]';
/** Tab children shown before "N more". */
const TAB_ROWS_VISIBLE = 5;
/** Store updates stream several times a second while agents work; render at most this often. */
const RENDER_THROTTLE_MS = 300;
/** dnd-kit's mouse activation distance in Paseo's sidebar (`movementDistance: 6`, strict `>`). */
const DRAG_START_PX = 6;
/** Horizontal step per nesting level, and the connector's x inside a list item. */
const INDENT_PX = 22;
const CONNECTOR_X_PX = 16;

const DEFAULT_PREFS: SidebarChildSessionsPrefs = {
  enabled: true,
  tabChildren: true,
  modelIcons: DEFAULT_SUBSESSION_MODEL_ICON_MODE,
};

// ---------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readSidebarChildSessionsPrefs(): SidebarChildSessionsPrefs {
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<SidebarChildSessionsPrefs>) : {};
    return {
      enabled: value.enabled !== false,
      tabChildren: value.tabChildren !== false,
      modelIcons: normalizeSubsessionModelIconMode(value.modelIcons),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function syncSidebarChildSessionsPrefs(
  prefs: Partial<SidebarChildSessionsPrefs>,
): SidebarChildSessionsPrefs {
  const prev = readSidebarChildSessionsPrefs();
  const next: SidebarChildSessionsPrefs = {
    ...prev,
    ...prefs,
    modelIcons: normalizeSubsessionModelIconMode(prefs.modelIcons ?? prev.modelIcons),
  };
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors
  }
  activeHandle?.renderNow();
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(SIDEBAR_CHILD_SESSIONS_EVENT));
    } catch {
      // Ignore event errors
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Store snapshot (Paseo's zustand `useSessionStore`, found once through Metro)
// ---------------------------------------------------------------------------

interface SessionStoreLike {
  getState(): { sessions?: Record<string, Record<string, unknown>> };
  subscribe?(listener: () => void): () => void;
}

export interface StoreSnapshot {
  serverId: string;
  agents: ChildSessionAgent[];
  archivedWorkspaceIds: string[];
  workspaceTitles: Map<string, string>;
}

let cachedStore: SessionStoreLike | null = null;
let cachedNavigateToAgent: ((input: { serverId: string; agentId: string; workspaceId?: string }) => unknown) | null = null;

/**
 * Paseo's own `navigateToAgent` (module `navigateToAgent`): opens the workspace and reveals the
 * agent's tab, reopening it when it was closed. It needs the real server id (`srv_...`); the
 * layout key is `<serverId>:<workspaceId>`, so a placeholder id opens the workspace with no tab.
 */
function resolveNativeNavigateToAgent(win: Window): typeof cachedNavigateToAgent {
  if (!cachedNavigateToAgent) {
    for (const mod of getMetroModuleList(win)) {
      const fn = mod?.isInitialized ? mod.publicModule?.exports?.navigateToAgent : null;
      if (typeof fn === "function") {
        cachedNavigateToAgent = fn;
        break;
      }
    }
  }
  return cachedNavigateToAgent;
}

export function hasNativeNavigation(win: Window): boolean {
  return Boolean(resolveNativeNavigateToAgent(win));
}

export function openAgentTab(
  target: { serverId: string; workspaceId: string; agentId: string },
  doc: Document,
  win: Window,
): boolean {
  const navigate = resolveNativeNavigateToAgent(win);
  if (navigate) {
    try {
      navigate({ serverId: target.serverId, agentId: target.agentId, workspaceId: target.workspaceId });
      return true;
    } catch {
      // Fall back to the shared lineage navigation below
    }
  }
  return navigateToLineageNode(
    { workspaceId: target.workspaceId, agentId: target.agentId, projectId: null, projectName: null },
    doc,
    win,
  );
}

export function findSessionStore(win?: Window | null): SessionStoreLike | null {
  if (cachedStore) return cachedStore;
  for (const mod of getMetroModuleList(win)) {
    const store = mod?.isInitialized ? mod.publicModule?.exports?.useSessionStore : null;
    if (store && typeof store.getState === "function") {
      cachedStore = store as SessionStoreLike;
      return cachedStore;
    }
  }
  return null;
}

function mapValues<T>(value: unknown): T[] {
  if (value instanceof Map) return Array.from(value.values()) as T[];
  if (value && typeof value === "object") return Object.values(value) as T[];
  return [];
}

export function snapshotSessionStore(store: SessionStoreLike | null): StoreSnapshot[] {
  if (!store) return [];
  const sessions = store.getState()?.sessions ?? {};
  return Object.entries(sessions).map(([serverId, session]) => {
    const agents = mapValues<Record<string, any>>(session.agents).map(
      (a): ChildSessionAgent => {
        const runtimeModel =
          typeof a.runtimeInfo?.model === "string" ? a.runtimeInfo.model.trim() : "";
        const directModel = typeof a.model === "string" ? a.model.trim() : "";
        const cfgModel =
          typeof a.config?.model === "string" ? a.config.model.trim() : "";
        return {
          id: String(a.id ?? ""),
          workspaceId: a.workspaceId ? String(a.workspaceId) : null,
          parentAgentId: typeof a.parentAgentId === "string" ? a.parentAgentId : null,
          labels: a.labels ?? null,
          archivedAt: a.archivedAt ?? null,
          title: typeof a.title === "string" ? a.title : null,
          status: typeof a.status === "string" ? a.status : null,
          running: a.turn?.phase === "open",
          requiresAttention: Boolean(a.requiresAttention),
          attentionReason: typeof a.attentionReason === "string" ? a.attentionReason : null,
          pendingPermissionCount: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : 0,
          createdAt: a.createdAt ?? null,
          lastActivityAt: a.lastActivityAt ?? null,
          provider: typeof a.provider === "string" ? a.provider.trim() || null : null,
          model: runtimeModel || directModel || cfgModel || null,
        };
      },
    );
    const workspaces = mapValues<Record<string, any>>(session.workspaces);
    const workspaceTitles = new Map<string, string>();
    const archivedWorkspaceIds: string[] = [];
    for (const ws of workspaces) {
      const id = String(ws.id ?? "");
      if (!id) continue;
      const title = String(ws.title ?? "").trim() || (ws.name && ws.name !== "main" ? String(ws.name) : "");
      if (title) workspaceTitles.set(id, title);
      if (ws.archivedAt && !ws.pinnedAt) archivedWorkspaceIds.push(id);
    }
    return { serverId, agents, archivedWorkspaceIds, workspaceTitles };
  });
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}

function rowSelector(key: string): string {
  return `[data-testid=${cssString(`${ROW_PREFIX}${key}`)}]`;
}

/** `srv_x:wks_y` -> `{ serverId, workspaceId }`. */
export function parseRowKey(key: string): { serverId: string; workspaceId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx === key.length - 1) return null;
  return { serverId: key.slice(0, idx), workspaceId: key.slice(idx + 1) };
}

/** The ancestor of `row` that is a direct child of its list container. */
function listItemOf(row: Element, list: Element): Element | null {
  let item: Element | null = row;
  while (item && item.parentElement !== list) item = item.parentElement;
  return item;
}

function relativeAge(ms: number | null, now: number): string {
  if (!ms) return "";
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Stylesheet: list order, indent and connector for moved native rows, look of tab rows
// ---------------------------------------------------------------------------

interface ThemeColors {
  name: string;
  colorScheme?: "light" | "dark";
  fg: string;
  muted: string;
  extraMuted: string;
  border: string;
  hover: string;
  selected: string;
  surfaceSidebar?: string;
  surface1?: string;
  running: string;
  success?: string;
  warning: string;
  danger?: string;
}

function themeColors(doc: Document, win: Window): ThemeColors {
  const t = resolveActivePaseoTheme(doc as never, win as never);
  return {
    name: t.name,
    colorScheme: t.colorScheme,
    fg: t.foreground,
    muted: t.foregroundMuted,
    extraMuted: t.foregroundExtraMuted,
    border: t.border,
    hover: t.surfaceSidebarHover,
    selected: t.surfaceSidebarSelected,
    surfaceSidebar: t.surfaceSidebar,
    surface1: t.surface1,
    running: t.statusDotRunning,
    success: t.statusSuccess,
    warning: t.statusWarning,
    danger: t.statusDanger,
  };
}

function baseCss(c: ThemeColors): string {
  const tab = `[data-testid="${TAB_ROW_TESTID}"]`;
  return [
    `[data-testid="${TAB_BLOCK_TESTID}"]{display:flex;flex-direction:column;position:relative;}`,
    `${tab}{all:unset;box-sizing:border-box;position:relative;display:flex;align-items:center;gap:8px;height:32px;padding:0 12px 0 8px;border-radius:8px;cursor:pointer;color:${c.fg};font:400 14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}`,
    `${tab}:hover{background:${c.hover};}`,
    `${tab}[aria-current="true"]{background:${c.selected};font-weight:500;}`,
    `${tab}:focus-visible{outline:2px solid ${c.running};outline-offset:-2px;}`,
    `${tab} .pff-dot{flex:0 0 14px;display:flex;align-items:center;justify-content:center;}`,
    `${tab} .pff-dot::after{content:"";width:6px;height:6px;border-radius:50%;background:${c.extraMuted};}`,
    `${tab}[data-state="running"] .pff-dot::after{width:6px;height:6px;border:2px solid ${c.running};background:transparent;}`,
    `${tab}[data-state="attention"] .pff-dot::after{background:${c.warning};}`,
    `${tab}:hover .pff-brand-icon,${tab}[aria-current="true"] .pff-brand-icon{opacity:1 !important;}`,
    `${tab} .pff-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `${tab} .pff-age{flex:0 0 auto;font-size:12px;color:${c.muted};}`,
    `${tab}[data-more="true"]{color:${c.muted};font-size:13px;}`,
    `[data-testid="${MOVED_BRAND_BADGE_TESTID}"]{position:absolute;top:21px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:999px;background:${c.surfaceSidebar ?? c.hover};box-shadow:0 0 0 1.5px ${c.surfaceSidebar ?? c.hover};pointer-events:none;}`,
    // Connector: "╰" from the parent's status icon down into this row.
    `.pff-elbow{position:absolute;top:-3px;height:calc(50% + 3px);width:6px;border-left:1px solid ${c.border};border-bottom:1px solid ${c.border};border-bottom-left-radius:6px;pointer-events:none;}`,
    `.pff-stem{position:absolute;top:50%;bottom:0;border-left:1px solid ${c.border};pointer-events:none;}`,
  ].join("\n");
}

function connectorCss(selector: string, depth: number, hasNext: boolean, c: ThemeColors): string {
  const x = CONNECTOR_X_PX + INDENT_PX * (depth - 1);
  const rules = [
    `${selector}{position:relative;padding-left:${INDENT_PX * depth}px;}`,
    `${selector}::before{content:"";position:absolute;left:${x}px;top:-1px;height:calc(50% + 1px);width:6px;border-left:1px solid ${c.border};border-bottom:1px solid ${c.border};border-bottom-left-radius:6px;pointer-events:none;}`,
  ];
  if (hasNext) {
    rules.push(
      `${selector}::after{content:"";position:absolute;left:${x}px;top:50%;bottom:0;border-left:1px solid ${c.border};pointer-events:none;}`,
    );
  }
  return rules.join("\n");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface MovedWorkspaceBadgePlan {
  key: string;
  workspaceId: string;
  depth: number;
  row: TabChildRow;
}

interface RenderResult {
  css: string;
  cssRules: number;
  nested: NestedWorkspaceStatus[];
  tabBlocks: Array<{ key: string; workspaceId: string; rows: TabChildRow[]; hasMovedChildren: boolean }>;
  movedBadges: MovedWorkspaceBadgePlan[];
}

/**
 * Builds the stylesheet for every list that holds a parent row and one of its child workspace
 * rows. Exported for tests: it reads only `querySelectorAll` / `parentElement` / `getAttribute`.
 */
export function planSidebarLayout(
  doc: Document,
  plans: Array<{ serverId: string; plan: ChildSessionPlan; titles: Map<string, string> }>,
  colors: ThemeColors,
  prefs: SidebarChildSessionsPrefs,
  suspendedListIds: ReadonlySet<string> = new Set(),
): RenderResult {
  const rules: string[] = [baseCss(colors)];
  const nested: NestedWorkspaceStatus[] = [];
  const tabBlocks: RenderResult["tabBlocks"] = [];
  const movedBadges: MovedWorkspaceBadgePlan[] = [];
  const planByServer = new Map(plans.map((p) => [p.serverId, p]));

  const parentKeyOf = (key: string): string | null => {
    const parsed = parseRowKey(key);
    const entry = parsed ? planByServer.get(parsed.serverId) : null;
    const link = parsed && entry ? entry.plan.childWorkspaces.get(parsed.workspaceId) : null;
    return link ? `${parsed!.serverId}:${link.parentWorkspaceId}` : null;
  };

  const rows = Array.from(doc.querySelectorAll(`[data-testid^="${ROW_PREFIX}"]`));
  const onScreen = new Set(rows.map((r) => (r.getAttribute("data-testid") ?? "").slice(ROW_PREFIX.length)));
  const lists = new Map<Element, Array<{ key: string; item: Element }>>();
  for (const row of rows) {
    const key = (row.getAttribute("data-testid") ?? "").slice(ROW_PREFIX.length);
    const list = row.closest(LIST_SELECTOR);
    const item = list ? listItemOf(row, list) : null;
    if (!list || !item) continue;
    const entries = lists.get(list) ?? [];
    entries.push({ key, item });
    lists.set(list, entries);
  }

  for (const [list, entries] of lists) {
    const listId = list.getAttribute("data-testid") ?? "";
    if (suspendedListIds.has(listId)) continue;
    const keys = entries.map((e) => e.key);
    const present = new Set(keys);
    const movedHere = keys.filter((k) => {
      const parent = parentKeyOf(k);
      return parent !== null && present.has(parent);
    });
    if (movedHere.length === 0) continue;
    const ordered = orderSidebarRows(keys, parentKeyOf);
    const itemOfKey = new Map(entries.map((e) => [e.key, e.item]));
    const children = Array.from(list.children);
    const rowItems = new Set(entries.map((e) => e.item));
    // Non-row children (a "New workspace" row, etc.) keep their DOM slot; row slots take `ordered`.
    let next = 0;
    const listSel = `[data-testid=${cssString(listId)}]`;
    children.forEach((child, index) => {
      if (rowItems.has(child)) {
        const key = ordered[next];
        next += 1;
        if (key && itemOfKey.has(key)) {
          rules.push(`${listSel} > :has(${rowSelector(key)}){order:${index};}`);
        }
      } else {
        rules.push(`${listSel} > :nth-child(${index + 1}):not(:has([data-testid^="${ROW_PREFIX}"])){order:${index};}`);
      }
    });
    for (const key of movedHere) {
      const parsed = parseRowKey(key)!;
      const entry = planByServer.get(parsed.serverId)!;
      const depth = Math.max(1, childWorkspaceDepth(entry.plan, parsed.workspaceId));
      const pos = ordered.indexOf(key);
      const parentKey = parentKeyOf(key);
      const hasNext = ordered.slice(pos + 1).some((k) => parentKeyOf(k) === parentKey);
      rules.push(connectorCss(`${listSel} > :has(${rowSelector(key)})`, depth, hasNext, colors));
    }
  }

  for (const { serverId, plan, titles } of plans) {
    for (const [wsId, link] of plan.childWorkspaces) {
      const key = `${serverId}:${wsId}`;
      const parentKey = `${serverId}:${link.parentWorkspaceId}`;
      const visibleHere = onScreen.has(key) && onScreen.has(parentKey);
      const primaryRow = link.linkRows?.[0];
      const brandComparison = primaryRow
        ? compareSessionBrands(
            { provider: primaryRow.provider, model: primaryRow.model },
            { provider: primaryRow.parentProvider, model: primaryRow.parentModel },
          )
        : null;
      const depth = childWorkspaceDepth(plan, wsId);
      if (visibleHere && primaryRow) {
        movedBadges.push({
          key,
          workspaceId: wsId,
          depth: Math.max(1, depth),
          row: primaryRow,
        });
      }
      nested.push({
        workspaceId: wsId,
        parentWorkspaceId: link.parentWorkspaceId,
        title: titles.get(wsId) ?? wsId,
        parentTitle: titles.get(link.parentWorkspaceId) ?? link.parentWorkspaceId,
        depth,
        onScreen: visibleHere,
        brand: brandComparison?.child.brand,
        modelSummary: brandComparison?.child.summary,
        differsFromParent: Boolean(
          brandComparison && (brandComparison.differsBrand || brandComparison.differsCompany),
        ),
      });
    }
    if (!prefs.tabChildren) continue;
    for (const [wsId, tabRows] of plan.tabChildren) {
      const key = `${serverId}:${wsId}`;
      const hasMovedChildren = [...plan.childWorkspaces.values()].some(
        (l) => l.parentWorkspaceId === wsId && onScreen.has(`${serverId}:${l.workspaceId}`),
      );
      tabBlocks.push({ key, workspaceId: wsId, rows: tabRows, hasMovedChildren });
    }
  }

  const css = rules.join("\n");
  return { css, cssRules: rules.length - 1, nested, tabBlocks, movedBadges };
}

function toIconTheme(colors: ThemeColors) {
  return {
    colorScheme: colors.colorScheme ?? (colors.name === "light" ? ("light" as const) : ("dark" as const)),
    foreground: colors.fg,
    foregroundMuted: colors.muted,
    surfaceSidebar: colors.surfaceSidebar ?? colors.hover,
    surface1: colors.surface1 ?? colors.hover,
    statusDotRunning: colors.running,
    statusSuccess: colors.success ?? colors.running,
    statusWarning: colors.warning,
    statusDanger: colors.danger ?? colors.warning,
  };
}

function renderTabBlock(
  doc: Document,
  win: Window,
  block: RenderResult["tabBlocks"][number],
  expanded: Set<string>,
  activeAgentId: string | null,
  colors: ThemeColors,
  modelIconsMode: SubsessionModelIconMode,
  rerender: () => void,
): { shown: boolean; iconsRendered: number; crossModelCount: number } {
  const row = doc.querySelector(rowSelector(block.key));
  const host = row?.parentElement;
  const existing = doc.querySelector<HTMLElement>(
    `[data-testid="${TAB_BLOCK_TESTID}"][data-row-key=${cssString(block.key)}]`,
  );
  if (!row || !host) {
    existing?.remove();
    return { shown: false, iconsRendered: 0, crossModelCount: 0 };
  }
  const isOpen = expanded.has(block.key);
  const visible = isOpen ? block.rows : block.rows.slice(0, TAB_ROWS_VISIBLE);
  const hidden = block.rows.length - visible.length;
  const now = Date.now();
  const iconTheme = toIconTheme(colors);
  let crossModelCount = 0;
  let iconsRendered = 0;
  block.rows.forEach((r) => {
    const cmp = compareSessionBrands(
      { provider: r.provider, model: r.model },
      { provider: r.parentProvider, model: r.parentModel },
    );
    if (cmp.differsBrand || cmp.differsCompany) crossModelCount += 1;
  });
  visible.forEach((r) => {
    const cmp = compareSessionBrands(
      { provider: r.provider, model: r.model },
      { provider: r.parentProvider, model: r.parentModel },
    );
    if (shouldShowModelBrandIcon(modelIconsMode, cmp)) iconsRendered += 1;
  });

  const sig = JSON.stringify([
    visible.map((r) => [
      r.agentId,
      r.title,
      r.state,
      r.attentionReason ?? "",
      r.depth,
      r.provider ?? "",
      r.model ?? "",
      r.parentProvider ?? "",
      r.parentModel ?? "",
      relativeAge(r.lastActivityMs, now),
    ]),
    hidden,
    isOpen,
    activeAgentId,
    block.hasMovedChildren,
    colors.name,
    modelIconsMode,
  ]);
  // Keep our block after the row (and after any other plugin block already placed there).
  let el = existing;
  if (!el || el.parentElement !== host) {
    existing?.remove();
    el = doc.createElement("div");
    el.setAttribute("data-testid", TAB_BLOCK_TESTID);
    el.setAttribute("data-row-key", block.key);
    el.setAttribute("role", "group");
    host.appendChild(el);
  }
  if (el.getAttribute("data-sig") === sig) {
    return { shown: true, iconsRendered, crossModelCount };
  }
  el.setAttribute("data-sig", sig);
  el.textContent = "";

  const hasMoreRow = hidden > 0 || (isOpen && block.rows.length > TAB_ROWS_VISIBLE);
  const total = visible.length + (hasMoreRow ? 1 : 0);
  const addRow = (index: number, depth: number, build: (btn: HTMLButtonElement) => void) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-testid", TAB_ROW_TESTID);
    btn.style.marginLeft = `${INDENT_PX * depth}px`;
    const elbow = doc.createElement("span");
    elbow.className = "pff-elbow";
    // The parent's status icon sits CONNECTOR_X_PX into the list item; this button starts one
    // indent further right, so the elbow reaches back by the difference.
    elbow.style.left = `${CONNECTOR_X_PX - INDENT_PX}px`;
    btn.appendChild(elbow);
    const isLast = index === total - 1;
    if (!isLast || block.hasMovedChildren) {
      const stem = doc.createElement("span");
      stem.className = "pff-stem";
      stem.style.left = elbow.style.left;
      btn.appendChild(stem);
    }
    build(btn);
    el!.appendChild(btn);
  };

  visible.forEach((child, index) => {
    addRow(index, child.depth, (btn) => {
      btn.setAttribute("data-agent-id", child.agentId);
      btn.setAttribute("data-state", child.state);
      const isActive = child.agentId === activeAgentId;
      btn.setAttribute("aria-current", isActive ? "true" : "false");
      const comparison = compareSessionBrands(
        { provider: child.provider, model: child.model },
        { provider: child.parentProvider, model: child.parentModel },
      );
      if (comparison.child.brand !== "unknown") {
        btn.setAttribute("data-brand", comparison.child.brand);
        btn.setAttribute(
          "data-brand-diff",
          comparison.differsBrand || comparison.differsCompany ? "true" : "false",
        );
      }
      const modelLine =
        comparison.child.brand !== "unknown"
          ? comparison.parent && (comparison.differsBrand || comparison.differsCompany)
            ? `${comparison.child.summary} (parent: ${comparison.parent.summary})`
            : comparison.child.summary
          : "";
      const metaParts = [modelLine, "Started by another session", `#${child.agentId.slice(0, 8)}`].filter(Boolean);
      btn.title = `${child.title}\n${metaParts.join(" · ")}`;

      const brandEl = createModelBrandIconElement({
        doc,
        comparison,
        mode: modelIconsMode,
        theme: iconTheme,
        sizePx: 13,
        statusPip:
          child.state === "running"
            ? "running"
            : child.state === "attention"
              ? child.attentionReason === "finished"
                ? "finished"
                : child.attentionReason === "error"
                  ? "error"
                  : "attention"
              : "none",
        pipCutoutBg: isActive ? colors.selected : iconTheme.surfaceSidebar,
      });
      const leading = brandEl ?? (() => {
        const dot = doc.createElement("span");
        dot.className = "pff-dot";
        return dot;
      })();

      const title = doc.createElement("span");
      title.className = "pff-title";
      title.textContent = child.title;
      const age = doc.createElement("span");
      age.className = "pff-age";
      age.textContent = relativeAge(child.lastActivityMs, now);
      btn.append(leading, title, age);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const serverId = parseRowKey(block.key)?.serverId ?? "";
        openAgentTab({ serverId, workspaceId: child.workspaceId, agentId: child.agentId }, doc, win);
        win.setTimeout(rerender, 400);
      });
    });
  });
  if (hasMoreRow) {
    addRow(visible.length, 1, (btn) => {
      btn.setAttribute("data-more", "true");
      const dot = doc.createElement("span");
      dot.className = "pff-dot";
      const label = doc.createElement("span");
      label.className = "pff-title";
      label.textContent = isOpen ? "Show fewer" : `${hidden} more`;
      btn.append(dot, label);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isOpen) expanded.delete(block.key);
        else expanded.add(block.key);
        rerender();
      });
    });
  }
  return { shown: true, iconsRendered, crossModelCount };
}

function renderMovedWorkspaceBrandBadges(
  doc: Document,
  movedBadges: MovedWorkspaceBadgePlan[],
  colors: ThemeColors,
  modelIconsMode: SubsessionModelIconMode,
): number {
  const keep = new Set<string>();
  let shownCount = 0;
  const iconTheme = toIconTheme(colors);

  movedBadges.forEach((item) => {
    const comparison = compareSessionBrands(
      { provider: item.row.provider, model: item.row.model },
      { provider: item.row.parentProvider, model: item.row.parentModel },
    );
    const shouldBadge =
      modelIconsMode !== "off" &&
      shouldShowModelBrandIcon("different", comparison);
    if (!shouldBadge) return;

    const row = doc.querySelector(rowSelector(item.key));
    const host = row?.parentElement;
    if (!row || !host) return;

    const sig = JSON.stringify([
      item.key,
      item.depth,
      comparison.child.brand,
      comparison.child.summary,
      colors.name,
      modelIconsMode,
    ]);
    let badge = doc.querySelector<HTMLElement>(
      `[data-testid="${MOVED_BRAND_BADGE_TESTID}"][data-row-key=${cssString(item.key)}]`,
    );
    if (!badge || badge.parentElement !== host) {
      badge?.remove();
      badge = doc.createElement("span");
      badge.setAttribute("data-testid", MOVED_BRAND_BADGE_TESTID);
      badge.setAttribute("data-row-key", item.key);
      badge.setAttribute("aria-hidden", "true");
      host.appendChild(badge);
    }
    keep.add(item.key);
    shownCount += 1;
    if (badge.getAttribute("data-sig") === sig) return;

    badge.setAttribute("data-sig", sig);
    badge.setAttribute("data-brand", comparison.child.brand);
    badge.title = comparison.child.summary;
    badge.style.left = `${INDENT_PX * item.depth + 19}px`;
    badge.textContent = "";
    const icon = createModelBrandIconElement({
      doc,
      comparison,
      mode: "always",
      theme: iconTheme,
      sizePx: 10,
      alwaysEmphasize: true,
    });
    if (icon) badge.appendChild(icon);
  });

  doc.querySelectorAll(`[data-testid="${MOVED_BRAND_BADGE_TESTID}"]`).forEach((n) => {
    if (!keep.has(n.getAttribute("data-row-key") ?? "")) n.remove();
  });
  return shownCount;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

interface Handle {
  (): void;
  renderNow(): void;
}

let activeHandle: Handle | null = null;
let lastStatus: SidebarChildSessionsStatus | null = null;

export function installSidebarChildSessions(docOverride?: Document | null): Handle {
  const doc = docOverride ?? (typeof document !== "undefined" ? document : null);
  const win = doc?.defaultView ?? (typeof window !== "undefined" ? window : null);
  const noop = Object.assign(() => {}, { renderNow: () => {} });
  if (!doc || !doc.body || !win) return noop;

  let timer = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const expanded = new Set<string>();
  let press: { x: number; y: number; listId: string; touchTimer: number } | null = null;
  let suspendedList: string | null = null;

  const styleEl = (): HTMLStyleElement => {
    let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = doc.createElement("style");
      el.id = STYLE_ID;
      doc.head.appendChild(el);
    }
    return el;
  };

  const clear = () => {
    doc.getElementById(STYLE_ID)?.remove();
    doc.querySelectorAll(`[data-testid="${TAB_BLOCK_TESTID}"]`).forEach((n) => n.remove());
    doc.querySelectorAll(`[data-testid="${MOVED_BRAND_BADGE_TESTID}"]`).forEach((n) => n.remove());
  };

  const render = () => {
    if (timer) win.clearTimeout(timer);
    timer = 0;
    if (disposed) return;
    const started = Date.now();
    const prefs = readSidebarChildSessionsPrefs();
    const modelIconsMode = normalizeSubsessionModelIconMode(prefs.modelIcons);
    const store = findSessionStore(win);
    if (store && !unsubscribe && typeof store.subscribe === "function") {
      unsubscribe = store.subscribe(schedule);
    }
    if (!prefs.enabled) {
      clear();
      publish({
        prefs,
        installed: true,
        storeFound: Boolean(store),
        renderedAt: new Date().toISOString(),
        nested: [],
        tabRows: [],
        skipped: [],
        cssRules: 0,
        renderMs: Date.now() - started,
        suspendedList: null,
        nativeNavigation: hasNativeNavigation(win),
        crossModelCount: 0,
        modelIconsShown: 0,
      });
      return;
    }
    const snapshots = snapshotSessionStore(store);
    const titleOf = new Map<string, string>();
    const plans = snapshots.map((s) => {
      for (const a of s.agents) if (a.title) titleOf.set(a.id, a.title);
      return {
        serverId: s.serverId,
        plan: planChildSessions(s.agents, { serverId: s.serverId, archivedWorkspaceIds: s.archivedWorkspaceIds }),
        titles: s.workspaceTitles,
      };
    });
    const colors = themeColors(doc, win);
    const layout = planSidebarLayout(doc, plans, colors, prefs, suspendedList ? new Set([suspendedList]) : new Set());
    const activeAgentId = extractCurrentWorkspaceAndAgent(doc, win).agentId;
    // A tab sub-session is the selected session: let only its row look selected, as Claude does.
    const activeTabBlock = activeAgentId
      ? layout.tabBlocks.find((b) => b.rows.some((r) => r.agentId === activeAgentId))
      : undefined;
    const css = activeTabBlock
      ? `${layout.css}\n${rowSelector(activeTabBlock.key)}[aria-selected="true"]{background-color:transparent !important;}`
      : layout.css;
    const style = styleEl();
    if (style.textContent !== css) style.textContent = css;
    const keep = new Set<string>();
    const tabRows: SidebarChildSessionsStatus["tabRows"] = [];
    let modelIconsShown = 0;
    let tabCrossModelCount = 0;
    layout.tabBlocks.forEach((block) => {
      const res = renderTabBlock(doc, win, block, expanded, activeAgentId, colors, modelIconsMode, render);
      if (res.shown) {
        keep.add(block.key);
        modelIconsShown += res.iconsRendered;
      }
      tabCrossModelCount += res.crossModelCount;
      const ws = plans.find((p) => block.key.startsWith(`${p.serverId}:`));
      tabRows.push({
        workspaceId: block.workspaceId,
        title: ws?.titles.get(block.workspaceId) ?? block.workspaceId,
        count: block.rows.length,
        onScreen: res.shown,
        crossModelCount: res.crossModelCount,
      });
    });
    doc.querySelectorAll(`[data-testid="${TAB_BLOCK_TESTID}"]`).forEach((n) => {
      if (!keep.has(n.getAttribute("data-row-key") ?? "")) n.remove();
    });
    modelIconsShown += renderMovedWorkspaceBrandBadges(doc, layout.movedBadges, colors, modelIconsMode);
    const movedCrossModelCount = layout.nested.filter((n) => n.differsFromParent).length;

    publish({
      prefs,
      installed: true,
      storeFound: Boolean(store),
      renderedAt: new Date().toISOString(),
      nested: layout.nested,
      tabRows,
      skipped: plans.flatMap((p) => p.plan.skipped.map((s) => ({ ...s, title: titleOf.get(s.agentId) ?? s.agentId.slice(0, 8) }))),
      cssRules: layout.cssRules,
      renderMs: Date.now() - started,
      suspendedList,
      nativeNavigation: hasNativeNavigation(win),
      crossModelCount: tabCrossModelCount + movedCrossModelCount,
      modelIconsShown,
    });
  };

  const schedule = () => {
    if (!timer && !disposed) timer = win.setTimeout(render, RENDER_THROTTLE_MS) as unknown as number;
  };

  const isOwnBlock = (n: Node) => {
    const tid = (n as Element).getAttribute?.("data-testid");
    return tid === TAB_BLOCK_TESTID || tid === MOVED_BRAND_BADGE_TESTID;
  };
  /** Streaming answers and typing mutate constantly and never change the sidebar. */
  const QUIET_REGIONS = '[data-testid="agent-timeline"],[data-testid="agent-composer"]';
  const touchesList = (m: MutationRecord) =>
    m.type === "childList" &&
    ((m.target as Element).matches?.(LIST_SELECTOR) ||
      Array.from(m.addedNodes).some(
        (n) => n.nodeType === 1 && ((n as Element).matches(LIST_SELECTOR) || Boolean((n as Element).querySelector(LIST_SELECTOR))),
      ));
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.filter((m) => !(m.target as Element).closest?.(QUIET_REGIONS));
    // A sidebar list gained, lost or reordered items (or was mounted again): the `order` rules
    // name the old slots, so re-render now. Observer callbacks run before paint.
    if (relevant.some(touchesList)) {
      render();
      return;
    }
    // Our own tab rows mutate the sidebar too; skip those so a render cannot trigger itself.
    // Anything else, including a native row being removed, schedules a render.
    const foreign = relevant.some((m) => {
      if (
        (m.target as Element).closest?.(
          `[data-testid="${TAB_BLOCK_TESTID}"],[data-testid="${MOVED_BRAND_BADGE_TESTID}"]`,
        )
      ) {
        return false;
      }
      const touched = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
      return touched.length === 0 || !touched.every(isOwnBlock);
    });
    if (foreign) schedule();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  win.addEventListener("popstate", schedule);

  const suspend = (listId: string) => {
    if (suspendedList === listId) return;
    suspendedList = listId;
    render();
  };
  const onPointerDown = (ev: PointerEvent) => {
    const list = (ev.target as Element | null)?.closest?.(LIST_SELECTOR);
    if (!list) return;
    const listId = list.getAttribute("data-testid") ?? "";
    const touchTimer =
      ev.pointerType === "touch" ? (win.setTimeout(() => suspend(listId), 120) as unknown as number) : 0;
    press = { x: ev.clientX, y: ev.clientY, listId, touchTimer };
  };
  const onPointerMove = (ev: PointerEvent) => {
    if (!press || suspendedList) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) >= DRAG_START_PX) suspend(press.listId);
  };
  const onPointerEnd = () => {
    if (press?.touchTimer) win.clearTimeout(press.touchTimer);
    press = null;
    if (suspendedList) {
      suspendedList = null;
      render();
    }
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerup", onPointerEnd, true);
  doc.addEventListener("pointercancel", onPointerEnd, true);
  schedule();

  const handle = Object.assign(
    () => {
      disposed = true;
      observer.disconnect();
      win.removeEventListener("popstate", schedule);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerEnd, true);
      doc.removeEventListener("pointercancel", onPointerEnd, true);
      unsubscribe?.();
      if (timer) win.clearTimeout(timer);
      clear();
      if (activeHandle === handle) activeHandle = null;
    },
    { renderNow: render },
  ) as Handle;
  activeHandle = handle;
  // DevTools / e2e entry point: read the status or run the self-test from the console.
  (win as unknown as Record<string, unknown>).__paseoFinderSidebarChildSessions = {
    status: getSidebarChildSessionsStatus,
    selfTest: () => runSidebarChildSessionsSelfTest(doc),
    setPrefs: (prefs: Partial<SidebarChildSessionsPrefs>) => syncSidebarChildSessionsPrefs(prefs),
  };
  return handle;
}

function publish(status: SidebarChildSessionsStatus): void {
  const prev = lastStatus;
  lastStatus = status;
  const changed =
    !prev ||
    prev.nested.length !== status.nested.length ||
    prev.tabRows.length !== status.tabRows.length ||
    prev.skipped.length !== status.skipped.length ||
    prev.prefs.enabled !== status.prefs.enabled ||
    prev.prefs.tabChildren !== status.prefs.tabChildren ||
    prev.prefs.modelIcons !== status.prefs.modelIcons ||
    prev.modelIconsShown !== status.modelIconsShown ||
    prev.crossModelCount !== status.crossModelCount;
  if (changed && typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(SIDEBAR_CHILD_SESSIONS_EVENT));
    } catch {
      // Ignore event errors
    }
  }
}

const SKIP_TEXT: Record<ChildSessionSkip["reason"], [string, string]> = {
  "not-a-subagent": ["intake task or colleague, not a sub-session", "Intake 任务或协作同伴，不算子会话"],
  "parent-unknown": ["parent session not loaded (archived, or on another host)", "父会话未加载（已归档或在另一台主机上）"],
  "parent-archived": ["parent session is archived", "父会话已归档"],
  "parent-server-differs": ["parent is on another host", "父会话在另一台主机上"],
  "mixed-roots": ["its workspace also has a session you started", "所在工作区还有你自己发起的会话"],
  "parents-in-several-workspaces": ["its workspace has parents in several workspaces", "所在工作区的父会话分属多个工作区"],
  cycle: ["parent chain loops", "父子链成环"],
};

export function describeSkipReason(reason: ChildSessionSkip["reason"], zh = false): string {
  return SKIP_TEXT[reason]?.[zh ? 1 : 0] ?? reason;
}

export function getSidebarChildSessionsStatus(): SidebarChildSessionsStatus {
  return (
    lastStatus ?? {
      prefs: readSidebarChildSessionsPrefs(),
      installed: Boolean(activeHandle),
      storeFound: false,
      renderedAt: null,
      nested: [],
      tabRows: [],
      skipped: [],
      cssRules: 0,
      renderMs: 0,
      suspendedList: null,
      nativeNavigation: false,
    }
  );
}

/**
 * Self-test against the real sidebar: renders now, then measures where each nested row landed.
 * A nested row passes when it sits below its parent row and only that parent's other children
 * sit between them.
 */
export function runSidebarChildSessionsSelfTest(docOverride?: Document | null): SidebarChildSessionsCheck[] {
  const doc = docOverride ?? (typeof document !== "undefined" ? document : null);
  activeHandle?.renderNow();
  const status = getSidebarChildSessionsStatus();
  const checks: SidebarChildSessionsCheck[] = [
    { name: "store", ok: status.storeFound, detail: status.storeFound ? "Paseo session store found" : "session store not found (Paseo update?)" },
  ];
  checks.push({
    name: "navigation",
    ok: status.nativeNavigation,
    detail: status.nativeNavigation ? "Paseo navigateToAgent found" : "navigateToAgent not found; tab rows fall back to lineage navigation",
  });
  if (!doc) return checks;
  const tops = new Map<string, number>();
  doc.querySelectorAll(`[data-testid^="${ROW_PREFIX}"]`).forEach((row) => {
    const key = (row.getAttribute("data-testid") ?? "").slice(ROW_PREFIX.length);
    tops.set(parseRowKey(key)?.workspaceId ?? key, row.getBoundingClientRect().top);
  });
  for (const n of status.nested) {
    if (!n.onScreen) {
      checks.push({ name: n.title, ok: true, detail: `not on screen (parent "${n.parentTitle}" collapsed or hidden)` });
      continue;
    }
    const top = tops.get(n.workspaceId)!;
    const parentTop = tops.get(n.parentWorkspaceId)!;
    const siblings = new Set(status.nested.filter((x) => x.parentWorkspaceId === n.parentWorkspaceId).map((x) => x.workspaceId));
    const between = [...tops.entries()].filter(([ws, t]) => t > parentTop && t < top && !siblings.has(ws));
    const ok = top > parentTop && between.every(([ws]) => status.nested.some((x) => x.workspaceId === ws));
    checks.push({
      name: n.title,
      ok,
      detail: ok ? `under "${n.parentTitle}"` : `expected under "${n.parentTitle}" (row at ${Math.round(top)}, parent at ${Math.round(parentTop)})`,
    });
  }
  for (const t of status.tabRows) {
    const shown = doc.querySelectorAll(`[data-testid="${TAB_BLOCK_TESTID}"] [data-testid="${TAB_ROW_TESTID}"]`).length > 0;
    checks.push({ name: `${t.title} (tabs)`, ok: !t.onScreen || shown, detail: t.onScreen ? `${t.count} tab sub-session(s) listed` : "workspace row not on screen" });
  }
  const mode = normalizeSubsessionModelIconMode(status.prefs.modelIcons);
  const renderedIcons = doc.querySelectorAll(
    `[data-testid="${TAB_BLOCK_TESTID}"] [data-testid="${MODEL_BRAND_ICON_TESTID}"], [data-testid="${MOVED_BRAND_BADGE_TESTID}"] [data-testid="${MODEL_BRAND_ICON_TESTID}"]`,
  ).length;
  const visibleTabRows = doc.querySelectorAll(
    `[data-testid="${TAB_BLOCK_TESTID}"] [data-testid="${TAB_ROW_TESTID}"][data-agent-id]`,
  ).length;
  const expectIcon = mode === "always" ? visibleTabRows > 0 : mode === "different" ? (status.crossModelCount ?? 0) > 0 && visibleTabRows > 0 : false;
  checks.push({
    name: "model-icons",
    ok: mode === "off" ? renderedIcons === 0 : !expectIcon || renderedIcons > 0,
    detail:
      mode === "off"
        ? `mode=off · ${renderedIcons} icon(s) rendered`
        : `mode=${mode} · ${renderedIcons} brand icon(s) rendered · ${status.crossModelCount ?? 0} cross-model`,
  });
  return checks;
}
