/// <reference lib="dom" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type FlatSubagentNode,
  type OpenerTarget,
  type SubagentAgentTree,
  type SubagentTimelineItem,
  type SubagentTimerOrTaskNode,
  manageSubagentsRpc,
  openFileTargetRpc,
} from "../shared/contracts";
import {
  handleSwarmSidecarExternalUrl,
  requestOpenSwarmWorkspacePanel,
} from "./swarm-workflow-web";
import { isChineseLocale } from "./i18n";
import {
  buildProviderSubagentTabTestId,
  extractCurrentWorkspaceAndAgent,
  extractFocusedWorkspaceTabTarget,
  getMetroModuleList,
  navigateToLineageNode,
  openWorkspaceTargetTabViaStore,
  parseProviderSubagentTabTestId,
  queryFirstVisible,
  resolveSessionReference,
} from "./session-lineage-web";
import {
  formatConciseLocalFinishedTime,
  formatFullLocalFinishedTooltip,
} from "./session-time-web";
import { syncPaseoThemeCssVariables } from "./theme-web";
import { focusWorkspaceInApp } from "./web";

export interface SubagentsTreeWebClient {
  call<TDef extends typeof manageSubagentsRpc | typeof openFileTargetRpc>(
    def: TDef,
    input: RpcInput<TDef>,
  ): Promise<RpcOutput<TDef>>;
  getLocale?: () => string | undefined;
}

const KNOWN_SUBAGENT_TYPES = new Set([
  "deepcoder",
  "deepcoderworkerl0",
  "deepcoderimprovementworker",
  "deepinvestigator",
  "deepinvestigatorworkerl0",
  "deepinvestigatorimprovementworker",
  "orchestrator",
  "research",
  "self",
  "image-generator",
  "firestore-rules-author",
  "browser_subagent",
]);

const DRAWER_MODE_STORAGE_KEY = "paseo:finder-plugin:subagents-drawer-mode";
const LEFT_SIDEBAR_COLLAPSED_KEY = "paseo:finder-plugin:left-sidebar-subagents-collapsed";
const LEFT_SIDEBAR_COLLAPSED_MAP_KEY = "paseo:finder-plugin:left-sidebar-subagents-collapsed-by-ws-v1";
export const ARCHIVED_SUBAGENTS_STORAGE_KEY = "paseo:finder-plugin:archived-subagents-v1";
const SUBAGENTS_TRACK_PATCH_STAMP = `subagents-track:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

function normalizeSubagentArchiveId(rawId: string | null | undefined): string {
  const trimmed = String(rawId ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^vec-subagent:/i, "").trim();
}

export function readArchivedSubagentIds(
  agentId?: string | null,
  win?: Window | null,
): Set<string> {
  const result = new Set<string>();
  const key = String(agentId ?? "").trim();
  if (!key) return result;
  const w = win ?? (typeof window !== "undefined" ? window : null);
  try {
    const raw = w?.localStorage?.getItem(ARCHIVED_SUBAGENTS_STORAGE_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const list = parsed?.[key] ?? parsed?.[key.slice(0, 8)] ?? [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const norm = normalizeSubagentArchiveId(item);
        if (norm) {
          result.add(norm);
          result.add(`vec-subagent:${norm}`);
        }
      }
    }
  } catch {
    // ignore storage errors
  }
  return result;
}

export function markSubagentsArchivedForAgent(
  agentId: string | null | undefined,
  subagentIds: string[],
  win?: Window | null,
): void {
  const key = String(agentId ?? "").trim();
  if (!key || !Array.isArray(subagentIds) || subagentIds.length === 0) return;
  const w = win ?? (typeof window !== "undefined" ? window : null);
  try {
    const raw = w?.localStorage?.getItem(ARCHIVED_SUBAGENTS_STORAGE_KEY);
    const parsed: Record<string, string[]> = raw ? JSON.parse(raw) : {};
    const existing = new Set<string>(Array.isArray(parsed[key]) ? parsed[key] : []);
    for (const id of subagentIds) {
      const norm = normalizeSubagentArchiveId(id);
      if (norm) existing.add(norm);
    }
    const merged = Array.from(existing);
    parsed[key] = merged;
    parsed[key.slice(0, 8)] = merged;
    w?.localStorage?.setItem(ARCHIVED_SUBAGENTS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore storage errors
  }
}

export function isAllSubagentsArchivedForTree(
  tree: SubagentAgentTree | null | undefined,
  win?: Window | null,
): boolean {
  if (!tree || tree.flatSubagents.length === 0) return false;
  if (tree.subagentSummary.running > 0) return false;
  if (tree.archived) return true;
  const archivedSet = readArchivedSubagentIds(tree.agentId, win);
  if (archivedSet.size === 0) return false;
  const l1Subs = tree.flatSubagents.filter((s) => s.depth === 1);
  const checkTargets = l1Subs.length > 0 ? l1Subs : tree.flatSubagents;
  return checkTargets.every((s) =>
    archivedSet.has(normalizeSubagentArchiveId(s.conversationId)),
  );
}

export function patchPaseoSubagentTrackModules(
  win?: Window | null,
  onArchivedCallback?: (parentAgentId: string, subagentIds: string[]) => void,
  onConversationUrlCallback?: (cid: string, rawUrl: string) => void,
): boolean {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const modules = getMetroModuleList(w);
  if (modules.length === 0) return false;
  let patchedAny = false;

  for (const mod of modules) {
    if (!mod || mod.isInitialized !== true) continue;
    const exp = mod.publicModule?.exports;
    if (!exp || typeof exp !== "object") continue;

    // 1. Patch buildSubagentPillPresentation & buildSubagentRowPresentationData (Metro module 5397)
    // Paseo 0.15.4 calls buildSubagentPillPresentation(t, rows), whereas 0.15.3 / tests call (rows, t).
    // Stamp with SUBAGENTS_TRACK_PATCH_STAMP so `paseo plugin reload` hot-swaps closures without stacking.
    if (
      typeof exp.buildSubagentPillPresentation === "function" &&
      exp.__paseoSubagentPillPatchStamp !== SUBAGENTS_TRACK_PATCH_STAMP
    ) {
      const origBuildPill =
        typeof exp.__paseoSubagentPillOrig === "function"
          ? exp.__paseoSubagentPillOrig
          : exp.buildSubagentPillPresentation;
      exp.__paseoSubagentPillOrig = origBuildPill;
      exp.buildSubagentPillPresentation = function patchedBuildSubagentPillPresentation(
        arg0: unknown,
        arg1?: unknown,
      ) {
        const res = origBuildPill.call(this, arg0, arg1);
        const rows = Array.isArray(arg0) ? arg0 : Array.isArray(arg1) ? arg1 : null;
        if (!rows || rows.length === 0) return res;
        const zh = isChineseLocale(w?.navigator?.language);
        const total = rows.length;
        const runningCount = rows.filter((r) => {
          if (!r || typeof r !== "object") return false;
          if (r.statusBucket) return r.statusBucket === "running";
          if (r.kind === "paseo") return r.turn?.phase === "open";
          return r.status === "running";
        }).length;
        const doneCount = total - runningCount;
        const baseSegText = String(
          res?.segments?.[0]?.text ??
            (total === 1 ? "1 subagent" : `${total} subagents`),
        )
          .replace(/\s*\u00b7\s*(?:Done|已完成)$/i, "")
          .trim();

        if (runningCount === 0) {
          const doneWord = zh ? "已完成" : "Done";
          return {
            ...res,
            segments: [
              {
                bucket: "done",
                text: `${baseSegText} \u00b7 ${doneWord}`,
              },
            ],
          };
        }

        if (doneCount > 0 && Array.isArray(res?.segments)) {
          const hasDoneSeg = res.segments.some((s: any) => s?.bucket === "done");
          if (!hasDoneSeg) {
            return {
              ...res,
              segments: [
                ...res.segments,
                {
                  bucket: "done",
                  text: zh ? `${doneCount} 已完成` : `${doneCount} done`,
                },
              ],
            };
          }
        }
        return res;
      };
      exp.__paseoSubagentPillDonePatched = true;
      exp.__paseoSubagentPillPatchStamp = SUBAGENTS_TRACK_PATCH_STAMP;
      patchedAny = true;
    }

    if (
      typeof exp.buildSubagentRowPresentationData === "function" &&
      exp.__paseoSubagentRowPatchStamp !== SUBAGENTS_TRACK_PATCH_STAMP
    ) {
      const origBuildRow =
        typeof exp.__paseoSubagentRowOrig === "function"
          ? exp.__paseoSubagentRowOrig
          : exp.buildSubagentRowPresentationData;
      exp.__paseoSubagentRowOrig = origBuildRow;
      exp.buildSubagentRowPresentationData = function patchedBuildSubagentRowPresentationData(
        row: Record<string, any>,
        t?: unknown,
      ) {
        const res = origBuildRow.call(this, row, t);
        const isRunning =
          row &&
          (row.statusBucket === "running" ||
            (row.statusBucket === undefined && row.status === "running"));
        if (row && !isRunning && res) {
          if (typeof res.detailText === "string") {
            res.detailText = res.detailText.replace(/\[Running\b/gi, "[Done");
          }
          if (typeof res.label === "string") {
            res.label = res.label.replace(/\[Running\b/gi, "[Done");
          }
        }
        return res;
      };
      exp.__paseoSubagentRowDonePatched = true;
      exp.__paseoSubagentRowPatchStamp = SUBAGENTS_TRACK_PATCH_STAMP;
      patchedAny = true;
    }

    // 2. Patch getStatusDotColor (Metro module 4303) so "done" bucket shows a green status dot on ComposerTrackPill
    if (
      typeof exp.getStatusDotColor === "function" &&
      exp.__paseoStatusDotPatchStamp !== SUBAGENTS_TRACK_PATCH_STAMP
    ) {
      const origGetDot =
        typeof exp.__paseoStatusDotOrig === "function"
          ? exp.__paseoStatusDotOrig
          : exp.getStatusDotColor;
      exp.__paseoStatusDotOrig = origGetDot;
      exp.getStatusDotColor = function patchedGetStatusDotColor(
        theme: Record<string, any>,
        bucket: string | null | undefined,
        opts?: Record<string, any>,
      ) {
        if (bucket === "done") {
          return theme?.colors?.statusDotSuccess ?? "#22c55e";
        }
        return origGetDot.call(this, theme, bucket, opts);
      };
      exp.__paseoStatusDotDonePatched = true;
      exp.__paseoStatusDotPatchStamp = SUBAGENTS_TRACK_PATCH_STAMP;
      patchedAny = true;
    }

    // 3. Patch useProviderSubagentStore (Metro module 4939) so archiving finished subagents persists & syncs
    if (
      typeof exp.useProviderSubagentStore?.getState === "function" &&
      exp.__paseoProviderSubagentStorePatchStamp !== SUBAGENTS_TRACK_PATCH_STAMP
    ) {
      try {
        const storeState = exp.useProviderSubagentStore.getState();
        if (storeState && typeof storeState.hideFromTrack === "function") {
          const origHideFromTrack =
            typeof exp.__paseoProviderSubagentHideOrig === "function"
              ? exp.__paseoProviderSubagentHideOrig
              : storeState.hideFromTrack;
          exp.__paseoProviderSubagentHideOrig = origHideFromTrack;
          const wrappedHideFromTrack = function (
            this: unknown,
            serverId: string,
            parentAgentId: string,
            subagentIds: string[],
          ) {
            markSubagentsArchivedForAgent(parentAgentId, subagentIds, w);
            const out = origHideFromTrack.call(this, serverId, parentAgentId, subagentIds);
            onArchivedCallback?.(parentAgentId, subagentIds);
            return out;
          };
          storeState.hideFromTrack = wrappedHideFromTrack;
          if (typeof exp.useProviderSubagentStore.setState === "function") {
            exp.useProviderSubagentStore.setState({ hideFromTrack: wrappedHideFromTrack });
          }
        }
        exp.__paseoProviderSubagentStorePatched = true;
        exp.__paseoProviderSubagentStorePatchStamp = SUBAGENTS_TRACK_PATCH_STAMP;
        patchedAny = true;
      } catch {
        // ignore store patch errors
      }
    }

    // 4. Patch openExternalUrl (Metro module 3687) so `conversation://<uuid>` Markdown links open our subagent / session inspector instead of being ignored
    if (
      typeof exp.openExternalUrl === "function" &&
      exp.__paseoConversationUrlPatchStamp !== SUBAGENTS_TRACK_PATCH_STAMP
    ) {
      const origOpenExternalUrl =
        typeof exp.__paseoOpenExternalUrlOrig === "function"
          ? exp.__paseoOpenExternalUrlOrig
          : exp.openExternalUrl;
      exp.__paseoOpenExternalUrlOrig = origOpenExternalUrl;
      exp.openExternalUrl = async function patchedOpenExternalUrl(
        this: unknown,
        url: string,
      ) {
        const rawUrl = String(url ?? "").trim();
        if (handleSwarmSidecarExternalUrl(rawUrl)) {
          return;
        }
        const convMatch = rawUrl.match(/^conversation:\/\/([A-Za-z0-9-]+)/i);
        if (convMatch?.[1]) {
          const cid = convMatch[1];
          onConversationUrlCallback?.(cid, rawUrl);
          const refNode = resolveSessionReference(cid);
          if (refNode && typeof document !== "undefined") {
            navigateToLineageNode(refNode, document, w);
            return;
          }
          triggerSubagentsTreeDrawer({
            conversationId: cid,
            layoutMode: "docked-right",
          });
          return;
        }
        return origOpenExternalUrl.call(this, url);
      };
      exp.__paseoConversationUrlPatched = true;
      exp.__paseoConversationUrlPatchStamp = SUBAGENTS_TRACK_PATCH_STAMP;
      patchedAny = true;
    }
  }

  return patchedAny;
}

const GENERIC_SUBAGENT_TYPES = new Set([
  "self",
  "subagent",
  "research",
  "orchestrator",
  "agent",
  "worker",
  "swarm worker",
]);

const KNOWN_COORDINATOR_PREFIXES = ["DeepInvestigator", "DeepCoder"];

export function formatSubagentDisplayName(
  sub: { subAgentType: string; role?: string | null; depth?: number },
  parentSub?: { subAgentType: string; role?: string | null } | null,
  maxLen = 28,
): string {
  const rawType = (sub.subAgentType ?? "").trim();
  const rawRole = (sub.role ?? "").trim();
  const isGenericType = !rawType || GENERIC_SUBAGENT_TYPES.has(rawType.toLowerCase());
  let chosen = isGenericType && rawRole ? rawRole : rawType || rawRole || "subagent";

  if (!isGenericType) {
    const candidatePrefixes = [
      ...(parentSub?.subAgentType ? [parentSub.subAgentType.trim()] : []),
      ...((sub.depth ?? 1) >= 2 ? KNOWN_COORDINATOR_PREFIXES : []),
    ];
    for (const prefix of candidatePrefixes) {
      if (prefix && chosen.length > prefix.length && chosen.startsWith(prefix)) {
        const rest = chosen.slice(prefix.length).replace(/^[-_\s]+/, "");
        if (rest.length >= 3) {
          chosen = rest;
          break;
        }
      }
    }
  }

  if (maxLen > 0 && chosen.length > maxLen) {
    return `${chosen.slice(0, Math.max(4, maxLen - 1)).trimEnd()}…`;
  }
  return chosen;
}

export function cleanSubagentSecondaryText(
  rawSecondary: string,
  subAgentType: string,
  role?: string | null,
  depth = 1,
): string {
  let s = (rawSecondary ?? "").trim();
  if (!s) return "";
  const cleanType = (subAgentType ?? "").trim();
  const cleanRole = (role ?? "").trim();

  // 1. Strip bracketed status summary (`[Done · 16 steps · 2 subagents]`) because the interactive pill renders it
  s = s.replace(/\s*\[(?:Running|Done|Failed|Canceled|运行中|已完成|失败|已取消)[^\]]*\]/gi, "");

  // 2. Strip leading repeated `L1 DeepInvestigator` (primary label already renders `DeepInvestigator`)
  if (cleanType) {
    const escapedType = cleanType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(
      new RegExp(`^L(\\d+)\\s+${escapedType}\\b(?:\\s*\\([^)]*\\))?\\s*(?:[·—:-]\\s*)?`, "i"),
      (_m, lvl) => `L${lvl} · `,
    );
  }

  // 3. Strip trailing ` — <duplicate role or truncated role prefix>` (`Ecommerce ... — Ec...`)
  const dashIdx = s.indexOf(" — ");
  if (dashIdx >= 0) {
    const head = s.slice(0, dashIdx).trim();
    const tail = s
      .slice(dashIdx + 3)
      .replace(/(?:\.{3}|…)$/, "")
      .trim();
    const headLower = head.toLowerCase();
    const tailLower = tail.toLowerCase();
    const roleLower = cleanRole.toLowerCase();
    if (
      !tailLower ||
      (tailLower.length >= 2 &&
        (headLower.includes(tailLower) ||
          (roleLower && roleLower.startsWith(tailLower)) ||
          cleanType.toLowerCase().startsWith(tailLower)))
    ) {
      s = head;
    }
  }

  s = s.replace(/\s*[·—:-]\s*$/, "").trim();
  if (/^L\d+$/i.test(s) && cleanRole && cleanRole.toLowerCase() !== cleanType.toLowerCase()) {
    return `L${depth} · ${cleanRole}`;
  }
  return s;
}

export function decorateConversationLinksAndSubagentMentionsInDom(
  tree: SubagentAgentTree | null | undefined,
  doc?: Document | null,
  zh = false,
): number {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  if (!d) return 0;
  let decoratedCount = 0;
  const subs = tree?.flatSubagents ?? [];

  // 1. Decorate all `<a href="conversation://<cid>">` Markdown links rendered in assistant messages
  const allLinks = Array.from(d.querySelectorAll<HTMLAnchorElement>("a[href]"));
  for (const aEl of allLinks) {
    const href = (aEl.getAttribute("href") ?? "").trim();
    const convMatch = href.match(/conversation:\/\/([A-Za-z0-9-]+)/i);
    if (!convMatch?.[1]) continue;
    const rawCid = convMatch[1];
    const linkText = (aEl.textContent ?? "")
      .replace(/\s*↗$/, "")
      .trim();
    const matchedSub =
      subs.find(
        (s) =>
          s.conversationId.toLowerCase() === rawCid.toLowerCase() ||
          s.conversationId.toLowerCase().startsWith(rawCid.toLowerCase()),
      ) ??
      (linkText.length >= 4
        ? subs.find(
            (s) =>
              Boolean(s.role) &&
              s.role.trim().toLowerCase() === linkText.toLowerCase(),
          )
        : undefined) ??
      null;

    const effectiveCid = matchedSub?.conversationId ?? rawCid;
    aEl.setAttribute("data-vec-conversation-cid", effectiveCid);
    if (matchedSub) {
      aEl.setAttribute("data-vec-subagent-cid", matchedSub.conversationId);
    }
    aEl.setAttribute(
      "data-testid",
      `paseo-finder-conversation-link-${effectiveCid.slice(0, 8)}`,
    );
    aEl.style.cursor = "pointer";
    aEl.style.textDecoration = "underline";
    aEl.style.textDecorationStyle = "dotted";
    aEl.style.textUnderlineOffset = "3px";

    if (matchedSub) {
      const displayRole = formatSubagentDisplayName(matchedSub, null, 48);
      const statusWord = formatStatusLabel(matchedSub.status, zh);
      const stepsWord = zh ? `${matchedSub.stepCount} 步` : `${matchedSub.stepCount} steps`;
      aEl.title = zh
        ? `L${matchedSub.depth} ${displayRole} · ${statusWord} (${stepsWord}) — 点击在右侧栏查看子会话 (Alt/⌘+点击切换标签页)`
        : `L${matchedSub.depth} ${displayRole} · ${statusWord} (${stepsWord}) — Click to inspect subagent in Right Sidebar (Alt/⌘+Click switches tab)`;
    } else {
      aEl.title = zh
        ? `点击打开关联会话 (${effectiveCid.slice(0, 8)})`
        : `Click to open linked conversation (${effectiveCid.slice(0, 8)})`;
    }

    if (!aEl.querySelector('[data-testid="paseo-finder-conv-link-badge"]')) {
      const arrowSpan = d.createElement("span");
      arrowSpan.setAttribute("data-testid", "paseo-finder-conv-link-badge");
      arrowSpan.textContent = " ↗";
      Object.assign(arrowSpan.style, {
        fontSize: "11px",
        opacity: "0.85",
        userSelect: "none",
      });
      aEl.appendChild(arrowSpan);
    }
    decoratedCount += 1;
  }

  // 2. Also decorate inline `<strong>`, `<b>`, `<code>` mentions that match a subagent's exact Role or non-generic TypeName
  if (subs.length > 0) {
    const inlineCandidates = Array.from(
      d.querySelectorAll<HTMLElement>("strong, b, code"),
    );
    for (const el of inlineCandidates) {
      if (
        el.closest(
          'a[href], [data-vec-subagent-cid], [data-vec-conversation-cid], [data-testid^="paseo-finder-"], [data-testid^="sidebar-"], [data-testid="tool-call-badge"]',
        )
      ) {
        continue;
      }
      const cleanTxt = (el.textContent ?? "")
        .replace(/\s*↗$/, "")
        .trim()
        .replace(/^['"“”‘’`]+|['"“”‘’`：:]+$/g, "")
        .trim();
      if (cleanTxt.length < 4 || cleanTxt.length > 120) continue;
      const lowerTxt = cleanTxt.toLowerCase();

      const matchedSub =
        subs.find(
          (s) =>
            s.role &&
            s.role.trim().length >= 4 &&
            s.role.trim().toLowerCase() === lowerTxt,
        ) ??
        subs.find(
          (s) =>
            !GENERIC_SUBAGENT_TYPES.has(s.subAgentType.trim().toLowerCase()) &&
            s.subAgentType.trim().length >= 4 &&
            s.subAgentType.trim().toLowerCase() === lowerTxt,
        ) ??
        null;

      if (!matchedSub) continue;
      el.setAttribute("data-vec-subagent-cid", matchedSub.conversationId);
      el.setAttribute(
        "data-testid",
        `paseo-finder-role-mention-${matchedSub.conversationId.slice(0, 8)}`,
      );
      el.style.cursor = "pointer";
      el.style.textDecoration = "underline";
      el.style.textDecorationStyle = "dotted";
      el.style.textUnderlineOffset = "3px";
      const displayRole = formatSubagentDisplayName(matchedSub, null, 48);
      const statusWord = formatStatusLabel(matchedSub.status, zh);
      const stepsWord = zh ? `${matchedSub.stepCount} 步` : `${matchedSub.stepCount} steps`;
      el.title = zh
        ? `L${matchedSub.depth} ${displayRole} · ${statusWord} (${stepsWord}) — 点击在右侧栏查看子会话`
        : `L${matchedSub.depth} ${displayRole} · ${statusWord} (${stepsWord}) — Click to inspect subagent in Right Sidebar`;
      decoratedCount += 1;
    }
  }

  return decoratedCount;
}

export type SubagentDrawerLayoutMode = "docked-right" | "wide-modal";

let externalOpenDrawerFn:
  | ((opts?: {
      agentId?: string | null;
      workspaceId?: string | null;
      conversationId?: string | null;
      layoutMode?: SubagentDrawerLayoutMode;
    }) => void)
  | null = null;

export function triggerSubagentsTreeDrawer(opts?: {
  agentId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  layoutMode?: SubagentDrawerLayoutMode;
}): void {
  externalOpenDrawerFn?.(opts);
}

export function extractCurrentRouteAgentId(pathname?: string | null): string | null {
  const raw = (pathname ?? "").trim();
  const m = raw.match(/\/ag\/([A-Za-z0-9-]{8,})/);
  return m ? m[1] : null;
}

export function normalizeWorkspaceKey(workspaceId?: string | null): string | null {
  const raw = (workspaceId ?? "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1).trim() || null : raw;
}

function readDrawerLayoutMode(): SubagentDrawerLayoutMode {
  try {
    const v = window.localStorage?.getItem(DRAWER_MODE_STORAGE_KEY);
    if (v === "wide-modal" || v === "docked-right") return v;
  } catch {
    // ignore
  }
  return "docked-right";
}

function writeDrawerLayoutMode(mode: SubagentDrawerLayoutMode): void {
  try {
    window.localStorage?.setItem(DRAWER_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function formatStatusLabel(status: string, isZh: boolean): string {
  if (status === "running") return isZh ? "运行中" : "Running";
  if (status === "failed") return isZh ? "失败" : "Failed";
  if (status === "canceled") return isZh ? "已取消" : "Canceled";
  return isZh ? "已完成" : "Done";
}

function statusColors(
  status: string,
  tokens: ReturnType<typeof syncPaseoThemeCssVariables>,
): { fg: string; bg: string; border: string; dot: string } {
  if (status === "running") {
    return {
      fg: tokens.statusWarning,
      bg: tokens.statusWarningTint,
      border: `${tokens.statusWarning}66`,
      dot: tokens.statusWarning,
    };
  }
  if (status === "failed") {
    return {
      fg: tokens.destructive,
      bg: `${tokens.destructive}1a`,
      border: `${tokens.destructive}66`,
      dot: tokens.destructive,
    };
  }
  if (status === "canceled") {
    return {
      fg: tokens.foregroundMuted,
      bg: tokens.surface2,
      border: tokens.border,
      dot: tokens.foregroundMuted,
    };
  }
  return {
    fg: tokens.statusSuccess,
    bg: tokens.statusSuccessTint,
    border: `${tokens.statusSuccess}55`,
    dot: tokens.statusSuccess,
  };
}

export function classifyToolCallBadgeText(
  rawText: string,
  tree: SubagentAgentTree | null,
): {
  kind: "subagent" | "timer" | "task" | "message" | null;
  subagentName?: string;
} {
  const trimmed = rawText.trim();
  if (!trimmed) return { kind: null };
  const robotPrefix = "\u{1F916}";
  const hasRobotPrefix = trimmed.startsWith(robotPrefix);
  const withoutRobot = trimmed.replace(/^\u{1F916}\s*/u, "").trim();
  const firstToken = withoutRobot.split(/[\s*:]+/)[0]?.toLowerCase() ?? "";

  if (hasRobotPrefix || KNOWN_SUBAGENT_TYPES.has(firstToken)) {
    return { kind: "subagent", subagentName: firstToken };
  }
  if (
    /^(?:deep|worker|investigator|coder|research|subagent)/i.test(firstToken) ||
    /(?:workerl\d|investigator|deepcoder|subagent)/i.test(firstToken) ||
    /\[(?:Running|Done|Failed)\s*\u00b7\s*(?:\d+\s*steps?|Starting)/i.test(withoutRobot)
  ) {
    return { kind: "subagent", subagentName: firstToken };
  }
  if (
    tree?.flatSubagents.some(
      (s) =>
        (s.subAgentType.toLowerCase() === firstToken && firstToken.length >= 2) ||
        withoutRobot.toLowerCase().includes(s.subAgentType.toLowerCase()),
    )
  ) {
    const matched = tree.flatSubagents.find(
      (s) =>
        s.subAgentType.toLowerCase() === firstToken ||
        withoutRobot.toLowerCase().includes(s.subAgentType.toLowerCase()),
    );
    return {
      kind: "subagent",
      subagentName: matched ? matched.subAgentType.toLowerCase() : firstToken,
    };
  }
  if (/^Timer\s*\(/i.test(withoutRobot) || /^schedule\b/i.test(withoutRobot)) {
    return { kind: "timer" };
  }
  if (/^Task\s*\(/i.test(withoutRobot) || /^manage_task\b/i.test(withoutRobot)) {
    return { kind: "task" };
  }
  if (/^Send message\s*->/i.test(withoutRobot) || /^send_message\b/i.test(withoutRobot)) {
    return { kind: "message" };
  }
  return { kind: null };
}

export interface SubagentLineageChainResult {
  activeSubagent: FlatSubagentNode | null;
  immediateParentSubagent: FlatSubagentNode | null;
  ancestorChain: FlatSubagentNode[];
  directChildren: FlatSubagentNode[];
}

export function buildSubagentLineageChain(
  tree: SubagentAgentTree | null | undefined,
  activeSubagentId?: string | null,
): SubagentLineageChainResult {
  const empty: SubagentLineageChainResult = {
    activeSubagent: null,
    immediateParentSubagent: null,
    ancestorChain: [],
    directChildren: [],
  };
  if (!tree || !Array.isArray(tree.flatSubagents) || tree.flatSubagents.length === 0) {
    return empty;
  }
  const cleanId = normalizeSubagentArchiveId(activeSubagentId);
  if (!cleanId) {
    return {
      ...empty,
      directChildren: tree.flatSubagents.filter((s) => s.depth === 1),
    };
  }
  const byId = new Map<string, FlatSubagentNode>();
  for (const s of tree.flatSubagents) {
    byId.set(normalizeSubagentArchiveId(s.conversationId), s);
  }
  const activeSub =
    byId.get(cleanId) ??
    tree.flatSubagents.find(
      (s) =>
        s.conversationId === cleanId ||
        s.conversationId.startsWith(cleanId) ||
        cleanId.endsWith(s.conversationId),
    ) ??
    null;
  if (!activeSub) {
    return {
      ...empty,
      directChildren: tree.flatSubagents.filter((s) => s.depth === 1),
    };
  }

  const chain: FlatSubagentNode[] = [activeSub];
  const seen = new Set<string>([normalizeSubagentArchiveId(activeSub.conversationId)]);
  let cur: FlatSubagentNode | null = activeSub;
  while (cur && cur.depth > 1 && cur.parentConversationId) {
    const pNorm = normalizeSubagentArchiveId(cur.parentConversationId);
    if (!pNorm || seen.has(pNorm) || pNorm === normalizeSubagentArchiveId(tree.rootConversationId)) {
      break;
    }
    const parentNode =
      byId.get(pNorm) ??
      tree.flatSubagents.find(
        (s) =>
          normalizeSubagentArchiveId(s.conversationId) === pNorm && s.depth < cur!.depth,
      ) ??
      null;
    if (!parentNode) break;
    chain.unshift(parentNode);
    seen.add(normalizeSubagentArchiveId(parentNode.conversationId));
    cur = parentNode;
  }

  const immediateParentSubagent = chain.length >= 2 ? chain[chain.length - 2] : null;
  const activeNorm = normalizeSubagentArchiveId(activeSub.conversationId);
  const directChildren = tree.flatSubagents.filter(
    (s) => normalizeSubagentArchiveId(s.parentConversationId) === activeNorm,
  );
  return {
    activeSubagent: activeSub,
    immediateParentSubagent,
    ancestorChain: chain,
    directChildren,
  };
}

export function resolveActiveSubagentNodeFromDom(
  tree: SubagentAgentTree | null | undefined,
  doc?: Document | null,
  win?: Window | null,
): FlatSubagentNode | null {
  if (!tree || tree.flatSubagents.length === 0) return null;
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!d) return null;

  // 1. Check active provider_subagent workspace tab in DOM
  const ctx = extractCurrentWorkspaceAndAgent(d, w);
  if (ctx.activeSubagentId) {
    const norm = normalizeSubagentArchiveId(ctx.activeSubagentId);
    const matched = tree.flatSubagents.find(
      (s) =>
        normalizeSubagentArchiveId(s.conversationId) === norm ||
        s.conversationId.startsWith(norm),
    );
    if (matched) return matched;
  }

  // 1b. Consult Paseo's authoritative useWorkspaceLayoutStore first when available:
  // if the focused tab in this workspace is `kind === "agent"`, we are definitively on L0 Main Agent.
  const focusedTarget = extractFocusedWorkspaceTabTarget(
    ctx.workspaceId ?? tree.workspaceId,
    w,
  );
  if (focusedTarget?.kind === "agent") {
    return null;
  }

  // If L0 Main Agent tab is explicitly selected (`aria-selected="true"`), we are on L0 Main Agent —
  // never fall through to kept-alive hidden `provider-subagent-panel` nodes from earlier visited tabs.
  const activeRootAgentTab = queryFirstVisible<HTMLElement>(
    d,
    '[data-testid^="workspace-tab-agent_"][aria-selected="true"]',
    w,
  );
  if (activeRootAgentTab) {
    return null;
  }

  // 2. Only inspect a VISIBLE `provider-subagent-panel` (kept-alive tabs stay hidden in the DOM)
  let subPanel = queryFirstVisible<HTMLElement>(
    d,
    '[data-testid="provider-subagent-panel"]',
    w,
  );
  if (!subPanel && typeof d.querySelector === "function") {
    const singleCand = d.querySelector<HTMLElement>('[data-testid="provider-subagent-panel"]');
    if (singleCand && !singleCand.hidden && singleCand.style?.display !== "none") {
      // Allow synthetic test mocks where querySelectorAll returns [] while querySelector is stubbed,
      // provided no ancestor is hidden (`display: none` / `[hidden]`).
      let cur: HTMLElement | null = singleCand;
      let hiddenAncestor = false;
      while (cur) {
        if (cur.hidden || cur.style?.display === "none" || cur.getAttribute?.("aria-hidden") === "true") {
          hiddenAncestor = true;
          break;
        }
        cur = cur.parentElement;
      }
      if (!hiddenAncestor) subPanel = singleCand;
    }
  }
  if (!subPanel) return null;

  if (focusedTarget?.subagentId) {
    const norm = normalizeSubagentArchiveId(focusedTarget.subagentId);
    const matched = tree.flatSubagents.find(
      (s) =>
        normalizeSubagentArchiveId(s.conversationId) === norm ||
        s.conversationId.startsWith(norm),
    );
    if (matched) return matched;
  }

  // 3. Fallback: match visible `[data-testid="provider-subagent-pane-subtitle"]` text
  const subtitleEl =
    queryFirstVisible<HTMLElement>(
      subPanel,
      '[data-testid="provider-subagent-pane-subtitle"]',
      w,
    ) ??
    queryFirstVisible<HTMLElement>(
      d,
      '[data-testid="provider-subagent-pane-subtitle"]',
      w,
    );
  const subtitleText = (subtitleEl?.textContent ?? "").trim();
  if (subtitleText) {
    const exactMatch = tree.flatSubagents.find(
      (s) =>
        subtitleText.includes(`L${s.depth} ${s.subAgentType}`) ||
        subtitleText.includes(
          `L${s.depth} ${formatSubagentDisplayName(s, null, 40)}`,
        ) ||
        subtitleText.includes(s.conversationId.slice(0, 8)),
    );
    if (exactMatch) return exactMatch;
    const typeMatches = tree.flatSubagents.filter((s) =>
      subtitleText.toLowerCase().includes(s.subAgentType.toLowerCase()),
    );
    if (typeMatches.length === 1) return typeMatches[0];
  }

  return null;
}

export function openOrFocusSubagentOrRootTabInApp(
  opts: {
    workspaceId?: string | null;
    parentAgentId: string;
    subagentId?: string | null;
  },
  doc?: Document | null,
  win?: Window | null,
): boolean {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  const w = win ?? (typeof window !== "undefined" ? window : null);
  const parentAgentId = (opts.parentAgentId ?? "").trim();
  if (!parentAgentId) return false;
  const subagentId = normalizeSubagentArchiveId(opts.subagentId) || null;

  if (!subagentId) {
    // Jumping to Root / Main Agent (L0)
    if (d) {
      const rootTab = d.querySelector<HTMLElement>(
        `[data-testid="workspace-tab-agent_${parentAgentId}"]`,
      );
      if (rootTab) {
        rootTab.click();
        return true;
      }
    }
    if (
      openWorkspaceTargetTabViaStore(
        {
          workspaceId: opts.workspaceId,
          parentAgentId,
          subagentId: null,
        },
        w,
      )
    ) {
      return true;
    }
    if (d) {
      const calloutOpenBtn = d.querySelector<HTMLElement>(
        '[data-testid="parent-agent-callout-open"]',
      );
      if (calloutOpenBtn) {
        calloutOpenBtn.setAttribute("data-vec-bypass-intercept", "1");
        try {
          calloutOpenBtn.click();
        } finally {
          calloutOpenBtn.removeAttribute("data-vec-bypass-intercept");
        }
        return true;
      }
    }
    return false;
  }

  // Jumping to a Subagent Tab (L1 / L2 / L3)
  if (d) {
    const candidateIds = [subagentId, `vec-subagent:${subagentId}`];
    for (const cid of candidateIds) {
      const exactTestId = buildProviderSubagentTabTestId(parentAgentId, cid);
      const tabEl = d.querySelector<HTMLElement>(`[data-testid="${exactTestId}"]`);
      if (tabEl) {
        tabEl.click();
        return true;
      }
    }
    const allSubTabs = Array.from(
      d.querySelectorAll<HTMLElement>('[data-testid^="workspace-tab-provider_subagent_"]'),
    );
    for (const el of allSubTabs) {
      const parsed = parseProviderSubagentTabTestId(el.getAttribute("data-testid"));
      if (
        parsed &&
        normalizeSubagentArchiveId(parsed.subagentId) === subagentId
      ) {
        el.click();
        return true;
      }
    }
  }

  if (
    openWorkspaceTargetTabViaStore(
      {
        workspaceId: opts.workspaceId,
        parentAgentId,
        subagentId,
      },
      w,
    )
  ) {
    return true;
  }

  if (d) {
    const trackCandidates = [
      `[data-testid="subagents-track-row-${subagentId}"]`,
      `[data-testid="subagents-track-row-vec-subagent:${subagentId}"]`,
    ];
    for (const sel of trackCandidates) {
      const row = d.querySelector<HTMLElement>(sel);
      if (row) {
        row.click();
        return true;
      }
    }
  }

  return false;
}

export function installDesktopSubagentsTreeEnhancer(
  client: SubagentsTreeWebClient,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const treeCacheByKey = new Map<
    string,
    {
      tree: SubagentAgentTree | null;
      fetchedAtMs: number;
      inFlight?: Promise<SubagentAgentTree | null>;
    }
  >();
  const workspaceTreesByWsId = new Map<string, SubagentAgentTree>();
  const collapsedByWorkspaceId = new Map<string, boolean>();
  let batchPrefetchInFlight: Promise<void> | null = null;
  let lastBatchPrefetchMs = 0;
  let lastScopeKey: string | null = null;
  let activeDrawerOverlayEl: HTMLElement | null = null;
  let activeDrawerRefreshFn: (() => Promise<void>) | null = null;
  let activeDrawerSelectSessionFn: ((cid: string) => void) | null = null;
  let pollIntervalId: ReturnType<typeof setInterval> | null = null;
  let rafId: number | null = null;
  try {
    const savedMapRaw = window.localStorage?.getItem(LEFT_SIDEBAR_COLLAPSED_MAP_KEY);
    if (savedMapRaw) {
      const parsedMap = JSON.parse(savedMapRaw) as Record<string, unknown>;
      if (parsedMap && typeof parsedMap === "object") {
        for (const [wsK, val] of Object.entries(parsedMap)) {
          if (typeof val === "boolean" && wsK) {
            collapsedByWorkspaceId.set(wsK, val);
          }
        }
      }
    }
  } catch {
    // ignore storage errors
  }

  const persistWorkspaceCollapsedMap = () => {
    try {
      const serialized: Record<string, boolean> = {};
      for (const [k, v] of collapsedByWorkspaceId.entries()) {
        serialized[k] = v;
      }
      window.localStorage?.setItem(LEFT_SIDEBAR_COLLAPSED_MAP_KEY, JSON.stringify(serialized));
    } catch {
      // ignore
    }
  };

  const isWorkspaceSidebarTreeCollapsed = (
    normWs: string,
    tree?: SubagentAgentTree | null,
  ): boolean => {
    if (collapsedByWorkspaceId.has(normWs)) {
      return collapsedByWorkspaceId.get(normWs)!;
    }
    // Smart default: auto-expand while subagents are running; auto-collapse once all subagents finish
    const running = tree?.subagentSummary?.running ?? workspaceTreesByWsId.get(normWs)?.subagentSummary?.running ?? 0;
    return running === 0;
  };

  const isZh = (): boolean => isChineseLocale(client.getLocale?.() ?? window.navigator?.language);

  const resolveActiveScope = (): {
    scopeKey: string | null;
    agentId: string | null;
    workspaceId: string | null;
  } => {
    const ctx = extractCurrentWorkspaceAndAgent(document, window);
    const wsId = normalizeWorkspaceKey(ctx.workspaceId);
    let agId = ctx.agentId ?? extractCurrentRouteAgentId(window.location?.pathname);
    if (wsId && agId) {
      const cachedAg = treeCacheByKey.get(`ag:${agId}`)?.tree;
      const cachedAgWs = normalizeWorkspaceKey(cachedAg?.workspaceId);
      if (cachedAgWs && cachedAgWs !== wsId) {
        agId = null;
      }
    }
    const scopeKey = wsId
      ? agId
        ? `ws:${wsId}:ag:${agId}`
        : `ws:${wsId}`
      : agId
        ? `ag:${agId}`
        : null;
    return { scopeKey, agentId: agId, workspaceId: wsId };
  };

  const cacheTreeUnderAllKeys = (
    tree: SubagentAgentTree | null,
    requestedKey?: string | null,
    scope?: { scopeKey: string | null; agentId: string | null; workspaceId: string | null },
  ) => {
    const now = Date.now();
    const validTree =
      tree && tree.subagentSummary.total > 0 && tree.flatSubagents.length > 0 ? tree : null;
    if (requestedKey) {
      treeCacheByKey.set(requestedKey, { tree: validTree, fetchedAtMs: now });
    }
    if (scope?.agentId) {
      treeCacheByKey.set(`ag:${scope.agentId}`, { tree: validTree, fetchedAtMs: now });
      treeCacheByKey.set(scope.agentId, { tree: validTree, fetchedAtMs: now });
      if (scope.workspaceId) {
        treeCacheByKey.set(`ws:${scope.workspaceId}:ag:${scope.agentId}`, {
          tree: validTree,
          fetchedAtMs: now,
        });
      }
    }
    if (scope?.workspaceId) {
      treeCacheByKey.set(`ws:${scope.workspaceId}`, { tree: validTree, fetchedAtMs: now });
    }
    if (validTree) {
      const normWs = normalizeWorkspaceKey(validTree.workspaceId);
      if (validTree.agentId) {
        treeCacheByKey.set(`ag:${validTree.agentId}`, { tree: validTree, fetchedAtMs: now });
        treeCacheByKey.set(validTree.agentId, { tree: validTree, fetchedAtMs: now });
        if (normWs) {
          treeCacheByKey.set(`ws:${normWs}:ag:${validTree.agentId}`, {
            tree: validTree,
            fetchedAtMs: now,
          });
        }
      }
      if (normWs) {
        treeCacheByKey.set(`ws:${normWs}`, { tree: validTree, fetchedAtMs: now });
        workspaceTreesByWsId.set(normWs, validTree);
      }
    }
  };

  const getCachedTreeForScope = (scope: {
    scopeKey: string | null;
    agentId: string | null;
    workspaceId: string | null;
  }): SubagentAgentTree | null => {
    const pickValid = (tr?: SubagentAgentTree | null): SubagentAgentTree | null => {
      if (!tr || tr.subagentSummary.total <= 0 || tr.flatSubagents.length === 0) {
        return null;
      }
      const trWs = normalizeWorkspaceKey(tr.workspaceId);
      if (scope.workspaceId && trWs && trWs !== scope.workspaceId) {
        return null;
      }
      return tr;
    };
    if (scope.scopeKey && treeCacheByKey.has(scope.scopeKey)) {
      return pickValid(treeCacheByKey.get(scope.scopeKey)?.tree);
    }
    if (scope.workspaceId && treeCacheByKey.has(`ws:${scope.workspaceId}`)) {
      return pickValid(treeCacheByKey.get(`ws:${scope.workspaceId}`)?.tree);
    }
    if (scope.agentId && treeCacheByKey.has(`ag:${scope.agentId}`)) {
      return pickValid(treeCacheByKey.get(`ag:${scope.agentId}`)?.tree);
    }
    if (scope.workspaceId && workspaceTreesByWsId.has(scope.workspaceId)) {
      return pickValid(workspaceTreesByWsId.get(scope.workspaceId));
    }
    return null;
  };

  const prefetchAllWorkspaceSubagentTrees = (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastBatchPrefetchMs < 8_000) {
      return batchPrefetchInFlight ?? Promise.resolve();
    }
    if (force && now - lastBatchPrefetchMs < 8_000 && lastBatchPrefetchMs > 0) {
      return batchPrefetchInFlight ?? Promise.resolve();
    }
    if (batchPrefetchInFlight) {
      return batchPrefetchInFlight;
    }
    lastBatchPrefetchMs = now;
    batchPrefetchInFlight = client
      .call(manageSubagentsRpc, {
        action: "tree",
        includeTimeline: false,
        limit: 20,
        source: "timeline-inline",
      })
      .then((res) => {
        const fetchedAt = Date.now();
        const freshWorkspaces = new Set<string>();
        for (const tr of res.trees ?? []) {
          if (tr.subagentSummary.total > 0 && tr.flatSubagents.length > 0) {
            const normWs = normalizeWorkspaceKey(tr.workspaceId);
            if (normWs) freshWorkspaces.add(normWs);
            cacheTreeUnderAllKeys(tr, normWs ? `ws:${normWs}` : `ag:${tr.agentId}`, {
              scopeKey: normWs
                ? tr.agentId
                  ? `ws:${normWs}:ag:${tr.agentId}`
                  : `ws:${normWs}`
                : `ag:${tr.agentId}`,
              agentId: tr.agentId || null,
              workspaceId: normWs,
            });
          }
        }
        // Clear stale `running > 0` flags on workspaces that aged out of the top-20 window so
        // `anySidebarWorkspaceRunning` never gets stuck true forever.
        for (const [wsKey, prevTree] of workspaceTreesByWsId.entries()) {
          if (!freshWorkspaces.has(wsKey) && prevTree.subagentSummary.running > 0) {
            workspaceTreesByWsId.set(wsKey, {
              ...prevTree,
              subagentSummary: {
                ...prevTree.subagentSummary,
                running: 0,
              },
            });
          }
        }
        const sidebarRows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-workspace-row-"]'),
        );
        for (const row of sidebarRows) {
          const tid = row.getAttribute("data-testid") ?? "";
          const rawWs = tid.replace(/^sidebar-workspace-row-/, "");
          const normWs = normalizeWorkspaceKey(rawWs);
          if (normWs && !workspaceTreesByWsId.has(normWs) && !treeCacheByKey.has(`ws:${normWs}`)) {
            treeCacheByKey.set(`ws:${normWs}`, { tree: null, fetchedAtMs: fetchedAt });
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        batchPrefetchInFlight = null;
      });
    return batchPrefetchInFlight;
  };

  const fetchScopeTree = async (
    scope: { scopeKey: string | null; agentId: string | null; workspaceId: string | null },
    force = false,
    includeTimeline = false,
  ): Promise<SubagentAgentTree | null> => {
    if (!scope.scopeKey) return null;
    const cached =
      treeCacheByKey.get(scope.scopeKey) ??
      (scope.workspaceId ? treeCacheByKey.get(`ws:${scope.workspaceId}`) : undefined) ??
      (scope.agentId ? treeCacheByKey.get(`ag:${scope.agentId}`) : undefined);
    const now = Date.now();
    const ttlMs = cached?.tree?.subagentSummary.running ? 2_500 : 10_000;
    if (
      !force &&
      !includeTimeline &&
      cached &&
      now - cached.fetchedAtMs < ttlMs &&
      cached.tree !== undefined
    ) {
      return getCachedTreeForScope(scope);
    }
    if (!force && !includeTimeline && cached?.inFlight) {
      return cached.inFlight;
    }

    const promise = client
      .call(manageSubagentsRpc, {
        action: includeTimeline ? "inspect" : "tree",
        agentId: scope.agentId ?? undefined,
        workspaceId: scope.workspaceId ?? undefined,
        includeTimeline,
        limit: 5,
        source: includeTimeline ? "drawer" : "timeline-inline",
      })
      .then((res) => {
        const matched =
          res.trees.find(
            (t) =>
              t.subagentSummary.total > 0 &&
              t.flatSubagents.length > 0 &&
              ((scope.agentId &&
                (t.agentId === scope.agentId || t.agentId.startsWith(scope.agentId))) ||
                (scope.workspaceId && normalizeWorkspaceKey(t.workspaceId) === scope.workspaceId)),
          ) ?? null;
        cacheTreeUnderAllKeys(matched, scope.scopeKey, scope);
        return matched;
      })
      .catch(() => {
        const prev = getCachedTreeForScope(scope);
        cacheTreeUnderAllKeys(prev, scope.scopeKey, scope);
        return prev;
      });

    treeCacheByKey.set(scope.scopeKey, {
      tree: cached?.tree ?? null,
      fetchedAtMs: cached?.fetchedAtMs ?? 0,
      inFlight: promise,
    });
    return promise;
  };

  const tryClickNativeSubagentTrackRow = (conversationId: string): boolean => {
    const cid = conversationId.trim();
    if (!cid) return false;
    const candidates = [
      `[data-testid="subagents-track-row-vec-subagent:${cid}"]`,
      `[data-testid="subagents-track-row-${cid}"]`,
    ];
    for (const sel of candidates) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  };

  const closeDrawer = () => {
    if (activeDrawerOverlayEl) {
      activeDrawerOverlayEl.remove();
      activeDrawerOverlayEl = null;
      activeDrawerRefreshFn = null;
      activeDrawerSelectSessionFn = null;
    }
  };

  const openDrawer = async (opts?: {
    agentId?: string | null;
    workspaceId?: string | null;
    conversationId?: string | null;
    layoutMode?: SubagentDrawerLayoutMode;
  }) => {
    // If already open and just switching conversationId within the same drawer, switch in place
    if (activeDrawerOverlayEl && opts?.conversationId && activeDrawerSelectSessionFn && !opts.layoutMode) {
      activeDrawerSelectSessionFn(opts.conversationId);
      return;
    }

    closeDrawer();
    const zh = isZh();
    const tokens = syncPaseoThemeCssVariables(document as never, window as never);
    const currentScope = resolveActiveScope();
    const targetAgentId = opts?.agentId ?? currentScope.agentId ?? undefined;
    const targetWorkspaceId =
      normalizeWorkspaceKey(opts?.workspaceId) ?? currentScope.workspaceId ?? undefined;
    let layoutMode: SubagentDrawerLayoutMode = opts?.layoutMode ?? readDrawerLayoutMode();

    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", "paseo-finder-subagents-drawer");
    overlay.setAttribute("data-layout-mode", layoutMode);

    const modal = document.createElement("div");
    modal.setAttribute("data-testid", "paseo-finder-subagents-panel");

    const applyLayoutStyles = () => {
      overlay.setAttribute("data-layout-mode", layoutMode);
      if (layoutMode === "docked-right") {
        Object.assign(overlay.style, {
          position: "fixed",
          top: "0",
          right: "0",
          bottom: "0",
          left: "auto",
          width: "min(620px, 52vw)",
          zIndex: "2147483645",
          backgroundColor: "transparent",
          backdropFilter: "none",
          display: "flex",
          alignItems: "stretch",
          justifyContent: "flex-end",
          padding: "0",
          boxSizing: "border-box",
          pointerEvents: "auto",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        });
        Object.assign(modal.style, {
          width: "100%",
          height: "100%",
          backgroundColor: tokens.surface0,
          borderLeft: `1px solid ${tokens.border}`,
          borderTop: "none",
          borderRight: "none",
          borderBottom: "none",
          borderRadius: "0",
          boxShadow: tokens.shadowLg,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: tokens.foreground,
        });
      } else {
        Object.assign(overlay.style, {
          position: "fixed",
          inset: "0",
          width: "100vw",
          zIndex: "2147483645",
          backgroundColor: "rgba(0, 0, 0, 0.48)",
          backdropFilter: "blur(3px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          boxSizing: "border-box",
          pointerEvents: "auto",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        });
        Object.assign(modal.style, {
          width: "min(1180px, 95vw)",
          height: "min(820px, 90vh)",
          backgroundColor: tokens.surface0,
          border: `1px solid ${tokens.border}`,
          borderRadius: "12px",
          boxShadow: tokens.shadowLg,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: tokens.foreground,
        });
      }
    };

    applyLayoutStyles();

    overlay.addEventListener("click", (ev) => {
      if (layoutMode === "wide-modal" && ev.target === overlay) {
        closeDrawer();
      }
    });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    activeDrawerOverlayEl = overlay;

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 16px",
      borderBottom: `1px solid ${tokens.border}`,
      backgroundColor: tokens.surface1,
      gap: "10px",
      flexShrink: "0",
    });

    const titleWrap = document.createElement("div");
    Object.assign(titleWrap.style, {
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      minWidth: "0",
    });

    const titleEl = document.createElement("div");
    titleEl.textContent = zh
      ? "子智能体与后台计时器侧边栏"
      : "Subagent Sessions & Timers Sidebar";
    Object.assign(titleEl.style, {
      fontSize: "13.5px",
      fontWeight: "600",
      color: tokens.foreground,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    const subtitleEl = document.createElement("div");
    subtitleEl.textContent = zh
      ? "正在同步关联会话树与步骤记录..."
      : "Syncing linked session tree and step timeline...";
    Object.assign(subtitleEl.style, {
      fontSize: "11.5px",
      color: tokens.foregroundMuted,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(subtitleEl);

    const headerActions = document.createElement("div");
    Object.assign(headerActions.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexShrink: "0",
    });

    const modeToggleBtn = document.createElement("button");
    modeToggleBtn.type = "button";
    modeToggleBtn.setAttribute("data-testid", "paseo-finder-subagents-layout-toggle");
    const updateModeToggleLabel = () => {
      modeToggleBtn.textContent =
        layoutMode === "docked-right"
          ? zh
            ? "展开宽屏"
            : "Expand Modal"
          : zh
            ? "停靠右侧栏"
            : "Dock Right";
    };
    updateModeToggleLabel();
    Object.assign(modeToggleBtn.style, {
      padding: "5px 9px",
      borderRadius: "6px",
      border: `1px solid ${tokens.border}`,
      backgroundColor: tokens.surface2,
      color: tokens.foreground,
      fontSize: "11.5px",
      fontWeight: "500",
      cursor: "pointer",
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.setAttribute("data-testid", "paseo-finder-subagents-refresh");
    refreshBtn.textContent = zh ? "刷新" : "Refresh";
    Object.assign(refreshBtn.style, {
      padding: "5px 9px",
      borderRadius: "6px",
      border: `1px solid ${tokens.border}`,
      backgroundColor: tokens.surface2,
      color: tokens.foreground,
      fontSize: "11.5px",
      fontWeight: "500",
      cursor: "pointer",
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("data-testid", "paseo-finder-subagents-close");
    closeBtn.textContent = zh ? "关闭" : "Close";
    Object.assign(closeBtn.style, {
      padding: "5px 9px",
      borderRadius: "6px",
      border: `1px solid ${tokens.border}`,
      backgroundColor: tokens.surface2,
      color: tokens.foreground,
      fontSize: "11.5px",
      fontWeight: "500",
      cursor: "pointer",
    });
    closeBtn.addEventListener("click", closeDrawer);

    headerActions.appendChild(modeToggleBtn);
    headerActions.appendChild(refreshBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(titleWrap);
    header.appendChild(headerActions);
    modal.appendChild(header);

    const body = document.createElement("div");
    Object.assign(body.style, {
      display: "flex",
      flex: "1",
      minHeight: "0",
      overflow: "hidden",
    });

    const leftPane = document.createElement("div");
    const rightPane = document.createElement("div");

    const syncBodyDirection = () => {
      if (layoutMode === "docked-right") {
        Object.assign(body.style, {
          flexDirection: "column",
        });
        Object.assign(leftPane.style, {
          width: "100%",
          maxHeight: "225px",
          flexShrink: "0",
          borderRight: "none",
          borderBottom: `1px solid ${tokens.border}`,
          backgroundColor: tokens.surface1,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          padding: "8px 12px",
          gap: "6px",
          boxSizing: "border-box",
        });
      } else {
        Object.assign(body.style, {
          flexDirection: "row",
        });
        Object.assign(leftPane.style, {
          width: "340px",
          maxHeight: "none",
          flexShrink: "0",
          borderRight: `1px solid ${tokens.border}`,
          borderBottom: "none",
          backgroundColor: tokens.surface1,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          padding: "10px",
          gap: "8px",
          boxSizing: "border-box",
        });
      }
      Object.assign(rightPane.style, {
        flex: "1",
        display: "flex",
        flexDirection: "column",
        minWidth: "0",
        minHeight: "0",
        overflow: "hidden",
        backgroundColor: tokens.surface0,
      });
    };

    syncBodyDirection();
    body.appendChild(leftPane);
    body.appendChild(rightPane);
    modal.appendChild(body);

    const preCached = getCachedTreeForScope({
      agentId: targetAgentId ?? null,
      workspaceId: targetWorkspaceId ?? null,
      scopeKey: targetAgentId
        ? `ag:${targetAgentId}`
        : targetWorkspaceId
          ? `ws:${targetWorkspaceId}`
          : "",
    });
    let allTrees: SubagentAgentTree[] = preCached ? [preCached] : [];
    let selectedTree: SubagentAgentTree | null = preCached ?? null;
    let selectedCid: string | null =
      opts?.conversationId ??
      preCached?.flatSubagents[0]?.conversationId ??
      preCached?.rootConversationId ??
      null;
    let timelineFilter: "all" | "messages" | "tools" | "timers" = "all";

    modeToggleBtn.addEventListener("click", () => {
      layoutMode = layoutMode === "docked-right" ? "wide-modal" : "docked-right";
      writeDrawerLayoutMode(layoutMode);
      updateModeToggleLabel();
      applyLayoutStyles();
      syncBodyDirection();
      renderPanes();
    });

    activeDrawerSelectSessionFn = (cid: string) => {
      selectedCid = cid;
      if (allTrees.length > 0) {
        const ownerTree = allTrees.find(
          (t) =>
            t.rootConversationId.startsWith(cid) ||
            t.flatSubagents.some((s) => s.conversationId.startsWith(cid)),
        );
        if (ownerTree) selectedTree = ownerTree;
      }
      renderPanes();
    };

    const updateHeaderSubtitle = () => {
      if (selectedTree) {
        const runningCnt = selectedTree.subagentSummary.running;
        subtitleEl.textContent = zh
          ? `${selectedTree.workspaceName || selectedTree.title} · 共 ${selectedTree.subagentSummary.total} 个子智能体 (${runningCnt > 0 ? `运行中 ${runningCnt}` : "全部完成"} · 累计 ${selectedTree.subagentSummary.totalSubagentSteps} 步)`
          : `${selectedTree.workspaceName || selectedTree.title} · ${selectedTree.subagentSummary.total} subagents (${runningCnt > 0 ? `${runningCnt} running` : "all completed"} · ${selectedTree.subagentSummary.totalSubagentSteps} steps)`;
      } else {
        subtitleEl.textContent = zh
          ? "当前暂无包含子智能体的会话记录"
          : "No sessions with subagents found";
      }
    };

    const loadAndRender = async () => {
      if (selectedTree) {
        updateHeaderSubtitle();
        renderPanes();
      } else {
        subtitleEl.textContent = zh
          ? "正在读取会话与子智能体执行轨迹..."
          : "Loading session and subagent timelines...";
      }

      const hasScopedTarget = Boolean(
        targetAgentId || targetWorkspaceId || opts?.conversationId,
      );
      const focusedRes = await client
        .call(manageSubagentsRpc, {
          action: "inspect",
          agentId: targetAgentId,
          workspaceId: targetWorkspaceId,
          conversationId: opts?.conversationId ?? undefined,
          includeTimeline: true,
          limit: hasScopedTarget ? 5 : 12,
          source: "drawer",
        })
        .catch(() => null);

      const mergedMap = new Map<string, SubagentAgentTree>();
      for (const tr of focusedRes?.trees ?? []) {
        if (tr.agentId && tr.subagentSummary.total > 0 && tr.flatSubagents.length > 0) {
          mergedMap.set(tr.agentId, tr);
        }
      }
      for (const tr of allTrees) {
        if (
          tr.agentId &&
          tr.subagentSummary.total > 0 &&
          tr.flatSubagents.length > 0 &&
          !mergedMap.has(tr.agentId)
        ) {
          mergedMap.set(tr.agentId, tr);
        }
      }
      allTrees = Array.from(mergedMap.values());
      for (const tr of allTrees) {
        cacheTreeUnderAllKeys(tr);
      }

      if (opts?.conversationId) {
        selectedTree =
          allTrees.find(
            (t) =>
              t.rootConversationId.startsWith(opts.conversationId!) ||
              t.flatSubagents.some((s) => s.conversationId.startsWith(opts.conversationId!)),
          ) ?? selectedTree;
      }
      if (!selectedTree && targetAgentId) {
        selectedTree =
          allTrees.find(
            (t) => t.agentId === targetAgentId || t.agentId.startsWith(targetAgentId),
          ) ?? null;
      }
      if (!selectedTree && targetWorkspaceId) {
        selectedTree =
          allTrees.find(
            (t) => normalizeWorkspaceKey(t.workspaceId) === targetWorkspaceId,
          ) ?? null;
      }
      if (!selectedTree) {
        selectedTree = allTrees[0] ?? null;
      } else {
        selectedTree =
          allTrees.find((t) => t.agentId === selectedTree!.agentId) ??
          selectedTree ??
          allTrees[0] ??
          null;
      }

      if (selectedTree && !selectedCid) {
        selectedCid =
          selectedTree.flatSubagents[0]?.conversationId ?? selectedTree.rootConversationId;
      }

      updateHeaderSubtitle();
      renderPanes();
      if (selectedTree) {
        decorateActiveAgentSubagentsDom(selectedTree);
      }
    };

    activeDrawerRefreshFn = loadAndRender;

    const buildLineageChain = (
      tree: SubagentAgentTree,
      activeNode: FlatSubagentNode | null,
    ): Array<{ cid: string; label: string; status: string; isCurrent: boolean }> => {
      const chain: Array<{ cid: string; label: string; status: string; isCurrent: boolean }> = [];
      let cursor: FlatSubagentNode | null = activeNode;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor.conversationId)) {
        visited.add(cursor.conversationId);
        chain.unshift({
          cid: cursor.conversationId,
          label: `L${cursor.depth} ${formatSubagentDisplayName(cursor, null, 28)}`,
          status: cursor.status,
          isCurrent: cursor.conversationId === activeNode?.conversationId,
        });
        const parentCid = cursor.parentConversationId;
        if (!parentCid || parentCid === tree.rootConversationId) {
          break;
        }
        cursor = tree.flatSubagents.find((s) => s.conversationId === parentCid) ?? null;
      }
      chain.unshift({
        cid: tree.rootConversationId,
        label: zh ? "主会话" : "Main Session",
        status: tree.agentStatus === "running" ? "running" : "completed",
        isCurrent: !activeNode,
      });
      return chain;
    };

    const renderPanes = () => {
      leftPane.innerHTML = "";
      rightPane.innerHTML = "";

      if (allTrees.length === 0 || !selectedTree) {
        const emptyEl = document.createElement("div");
        emptyEl.textContent = zh
          ? "当前暂无子智能体或后台计时器记录。"
          : "No subagents or background timers recorded yet.";
        Object.assign(emptyEl.style, {
          padding: "24px",
          fontSize: "13px",
          color: tokens.foregroundMuted,
        });
        rightPane.appendChild(emptyEl);
        return;
      }

      // In docked-right mode, show the active workspace's tree first and allow switching trees via a compact selector
      const treesToRender =
        layoutMode === "docked-right" ? [selectedTree] : allTrees;

      if (layoutMode === "docked-right" && allTrees.length > 1) {
        const switcherRow = document.createElement("div");
        Object.assign(switcherRow.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "2px",
        });
        const swLabel = document.createElement("span");
        swLabel.textContent = zh ? "关联主会话:" : "Session Tree:";
        Object.assign(swLabel.style, {
          fontSize: "11px",
          fontWeight: "600",
          color: tokens.foregroundMuted,
          flexShrink: "0",
        });
        const selectEl = document.createElement("select");
        Object.assign(selectEl.style, {
          flex: "1",
          minWidth: "0",
          padding: "4px 8px",
          borderRadius: "6px",
          border: `1px solid ${tokens.border}`,
          backgroundColor: tokens.surface0,
          color: tokens.foreground,
          fontSize: "11.5px",
        });
        for (const tr of allTrees) {
          const opt = document.createElement("option");
          opt.value = tr.agentId;
          opt.selected = tr.agentId === selectedTree.agentId;
          opt.textContent = `${tr.workspaceName || tr.title} (${tr.subagentSummary.total} · ${tr.subagentSummary.totalSubagentSteps} steps)`;
          selectEl.appendChild(opt);
        }
        selectEl.addEventListener("change", () => {
          const next = allTrees.find((t) => t.agentId === selectEl.value);
          if (next) {
            selectedTree = next;
            selectedCid =
              next.flatSubagents[0]?.conversationId ?? next.rootConversationId;
            renderPanes();
          }
        });
        switcherRow.appendChild(swLabel);
        switcherRow.appendChild(selectEl);
        leftPane.appendChild(switcherRow);
      }

      for (const tree of treesToRender) {
        const isCurrentTree = tree.agentId === selectedTree.agentId;
        const treeGroup = document.createElement("div");
        Object.assign(treeGroup.style, {
          border: `1px solid ${isCurrentTree ? tokens.accent : tokens.border}`,
          borderRadius: "8px",
          backgroundColor: tokens.surface0,
          overflow: "hidden",
          flexShrink: "0",
        });

        if (layoutMode === "wide-modal") {
          const groupHeader = document.createElement("div");
          Object.assign(groupHeader.style, {
            padding: "8px 11px",
            cursor: "pointer",
            backgroundColor: isCurrentTree ? tokens.surface2 : tokens.surface0,
            borderBottom: isCurrentTree ? `1px solid ${tokens.border}` : "none",
            display: "flex",
            flexDirection: "column",
            gap: "3px",
          });

          const topRow = document.createElement("div");
          Object.assign(topRow.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "6px",
          });

          const wsBadge = document.createElement("span");
          wsBadge.textContent = tree.workspaceName || tree.title;
          Object.assign(wsBadge.style, {
            fontSize: "12px",
            fontWeight: "600",
            color: tokens.foreground,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          });

          const sumCol = statusColors(
            tree.subagentSummary.running > 0
              ? "running"
              : tree.subagentSummary.failed > 0
                ? "failed"
                : "completed",
            tokens,
          );
          const countPill = document.createElement("span");
          countPill.textContent = `${tree.subagentSummary.total} · ${tree.subagentSummary.totalSubagentSteps} steps`;
          Object.assign(countPill.style, {
            fontSize: "10.5px",
            fontWeight: "600",
            padding: "1px 6px",
            borderRadius: "999px",
            backgroundColor: sumCol.bg,
            color: sumCol.fg,
            border: `1px solid ${sumCol.border}`,
            flexShrink: "0",
          });

          topRow.appendChild(wsBadge);
          topRow.appendChild(countPill);

          const subRow = document.createElement("div");
          subRow.textContent = `${tree.model} · ${tree.rootStepCount} steps`;
          Object.assign(subRow.style, {
            fontSize: "11px",
            color: tokens.foregroundMuted,
          });

          groupHeader.appendChild(topRow);
          groupHeader.appendChild(subRow);
          groupHeader.addEventListener("click", () => {
            selectedTree = tree;
            selectedCid =
              tree.flatSubagents[0]?.conversationId ?? tree.rootConversationId;
            renderPanes();
          });
          treeGroup.appendChild(groupHeader);
        }

        if (isCurrentTree) {
          const nodesList = document.createElement("div");
          Object.assign(nodesList.style, {
            display: "flex",
            flexDirection: "column",
            padding: "6px",
            gap: "4px",
          });

          // 1. Root Session row
          const isRootSelected = selectedCid === tree.rootConversationId;
          const rootRow = document.createElement("div");
          rootRow.setAttribute(
            "data-testid",
            `paseo-finder-subagent-node-${tree.rootConversationId}`,
          );
          Object.assign(rootRow.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 9px",
            borderRadius: "6px",
            cursor: "pointer",
            backgroundColor: isRootSelected ? tokens.surface2 : "transparent",
            border: isRootSelected
              ? `1px solid ${tokens.accent}`
              : "1px solid transparent",
          });

          const rootLabel = document.createElement("div");
          rootLabel.textContent = zh
            ? `主会话 (${tree.rootConversationId.slice(0, 8)})`
            : `Main Session (${tree.rootConversationId.slice(0, 8)})`;
          Object.assign(rootLabel.style, {
            fontSize: "12px",
            fontWeight: isRootSelected ? "600" : "500",
            color: tokens.foreground,
          });

          const rootMeta = document.createElement("span");
          rootMeta.textContent = zh
            ? `${tree.rootStepCount} 步`
            : `${tree.rootStepCount} steps`;
          Object.assign(rootMeta.style, {
            fontSize: "11px",
            color: tokens.foregroundMuted,
          });

          rootRow.appendChild(rootLabel);
          rootRow.appendChild(rootMeta);
          rootRow.addEventListener("click", () => {
            selectedCid = tree.rootConversationId;
            renderPanes();
          });
          nodesList.appendChild(rootRow);

          // 2. Child Subagent rows (L1, L2, L3)
          for (const sub of tree.flatSubagents) {
            const isSelected =
              selectedCid === sub.conversationId ||
              Boolean(selectedCid && sub.conversationId.startsWith(selectedCid));
            const sc = statusColors(sub.status, tokens);
            const nodeRow = document.createElement("div");
            nodeRow.setAttribute(
              "data-testid",
              `paseo-finder-subagent-node-${sub.conversationId}`,
            );
            const indentPx = Math.min(36, Math.max(1, sub.depth) * 14);
            Object.assign(nodeRow.style, {
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              padding: "6px 9px",
              marginLeft: `${indentPx}px`,
              borderRadius: "6px",
              cursor: "pointer",
              backgroundColor: isSelected ? tokens.surface2 : "transparent",
              border: isSelected
                ? `1px solid ${tokens.accent}`
                : `1px solid ${tokens.border}`,
            });

            const r1 = document.createElement("div");
            Object.assign(r1.style, {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
            });

            const leftTitleWrap = document.createElement("div");
            Object.assign(leftTitleWrap.style, {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              minWidth: "0",
            });

            const dotEl = document.createElement("span");
            Object.assign(dotEl.style, {
              width: "7px",
              height: "7px",
              borderRadius: "999px",
              backgroundColor: sc.dot,
              flexShrink: "0",
            });

            const nameSpan = document.createElement("span");
            const nodeDisplayName = formatSubagentDisplayName(sub, null, 48);
            nameSpan.textContent = `L${sub.depth} · ${nodeDisplayName}${
              sub.role && nodeDisplayName !== sub.role ? ` (${sub.role})` : ""
            }`;
            Object.assign(nameSpan.style, {
              fontSize: "12px",
              fontWeight: "600",
              color: tokens.foreground,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            });

            leftTitleWrap.appendChild(dotEl);
            leftTitleWrap.appendChild(nameSpan);

            const timersCnt = (sub.timersAndTasks ?? []).length;
            const statusBadge = document.createElement("span");
            statusBadge.textContent = `${formatStatusLabel(sub.status, zh)} · ${
              zh ? `${sub.stepCount} 步` : `${sub.stepCount} steps`
            }${timersCnt > 0 ? (zh ? ` · ${timersCnt} 任务` : ` · ${timersCnt} tasks`) : ""}`;
            Object.assign(statusBadge.style, {
              fontSize: "10.5px",
              fontWeight: "600",
              padding: "1px 6px",
              borderRadius: "999px",
              backgroundColor: sc.bg,
              color: sc.fg,
              border: `1px solid ${sc.border}`,
              flexShrink: "0",
            });

            r1.appendChild(leftTitleWrap);
            r1.appendChild(statusBadge);
            nodeRow.appendChild(r1);

            if (sub.promptPreview) {
              const promptEl = document.createElement("div");
              promptEl.textContent = sub.promptPreview;
              Object.assign(promptEl.style, {
                fontSize: "11px",
                color: tokens.foregroundMuted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              });
              nodeRow.appendChild(promptEl);
            }

            nodeRow.addEventListener("click", () => {
              selectedCid = sub.conversationId;
              renderPanes();
            });
            nodesList.appendChild(nodeRow);
          }

          treeGroup.appendChild(nodesList);
        }

        leftPane.appendChild(treeGroup);
      }

      // Right/Bottom pane: Selected Session Inspector
      const activeSub =
        selectedTree.flatSubagents.find(
          (s) =>
            s.conversationId === selectedCid ||
            Boolean(selectedCid && s.conversationId.startsWith(selectedCid)),
        ) ?? null;
      const isInspectingRoot = !activeSub;
      const currentCid = activeSub
        ? activeSub.conversationId
        : selectedTree.rootConversationId;
      const timelineItems: SubagentTimelineItem[] = activeSub
        ? activeSub.timeline ?? []
        : selectedTree.rootTimeline ?? [];
      const activeTimers: SubagentTimerOrTaskNode[] = activeSub
        ? activeSub.timersAndTasks ?? []
        : selectedTree.rootTimersAndTasks ?? [];

      const sessionHeader = document.createElement("div");
      Object.assign(sessionHeader.style, {
        padding: "12px 16px",
        borderBottom: `1px solid ${tokens.border}`,
        backgroundColor: tokens.surface1,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        flexShrink: "0",
      });

      // 1. Bidirectional Session Lineage Breadcrumb Bar
      const lineageChain = buildLineageChain(selectedTree, activeSub);
      const breadcrumbBar = document.createElement("div");
      breadcrumbBar.setAttribute("data-testid", "paseo-finder-subagent-lineage-breadcrumbs");
      Object.assign(breadcrumbBar.style, {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        flexWrap: "wrap",
      });

      lineageChain.forEach((step, idx) => {
        if (idx > 0) {
          const arrow = document.createElement("span");
          arrow.textContent = "›";
          Object.assign(arrow.style, {
            fontSize: "12px",
            color: tokens.foregroundMuted,
            padding: "0 2px",
          });
          breadcrumbBar.appendChild(arrow);
        }
        const sc = statusColors(step.status, tokens);
        const crumbBtn = document.createElement("button");
        crumbBtn.type = "button";
        crumbBtn.setAttribute(
          "data-testid",
          `paseo-finder-subagent-crumb-${step.cid.slice(0, 8)}`,
        );
        crumbBtn.textContent = step.label;
        Object.assign(crumbBtn.style, {
          padding: "2px 8px",
          borderRadius: "6px",
          fontSize: "11px",
          fontWeight: step.isCurrent ? "600" : "500",
          cursor: "pointer",
          border: `1px solid ${step.isCurrent ? tokens.accent : sc.border}`,
          backgroundColor: step.isCurrent ? tokens.surface2 : tokens.surface0,
          color: tokens.foreground,
        });
        crumbBtn.addEventListener("click", () => {
          selectedCid = step.cid;
          renderPanes();
        });
        breadcrumbBar.appendChild(crumbBtn);
      });

      // Also show direct child subagent jump chips right in the breadcrumb bar
      const directChildren = selectedTree.flatSubagents.filter(
        (s) => s.parentConversationId === currentCid,
      );
      for (const child of directChildren) {
        const arrow = document.createElement("span");
        arrow.textContent = "↳";
        Object.assign(arrow.style, {
          fontSize: "11px",
          color: tokens.foregroundMuted,
          paddingLeft: "4px",
        });
        breadcrumbBar.appendChild(arrow);

        const cCol = statusColors(child.status, tokens);
        const childChip = document.createElement("button");
        childChip.type = "button";
        childChip.setAttribute(
          "data-testid",
          `paseo-finder-subagent-jump-child-${child.conversationId.slice(0, 8)}`,
        );
        childChip.textContent = `L${child.depth} ${child.subAgentType} (${
          zh ? `${child.stepCount} 步` : `${child.stepCount} steps`
        })`;
        Object.assign(childChip.style, {
          padding: "2px 8px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: "600",
          cursor: "pointer",
          border: `1px solid ${cCol.border}`,
          backgroundColor: cCol.bg,
          color: cCol.fg,
        });
        childChip.addEventListener("click", () => {
          selectedCid = child.conversationId;
          renderPanes();
        });
        breadcrumbBar.appendChild(childChip);
      }

      sessionHeader.appendChild(breadcrumbBar);

      // 2. Title & Actions row
      const topInfoRow = document.createElement("div");
      Object.assign(topInfoRow.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        flexWrap: "wrap",
      });

      const sessionTitle = document.createElement("div");
      sessionTitle.textContent = activeSub
        ? `L${activeSub.depth} ${activeSub.subAgentType}${activeSub.role ? ` — ${activeSub.role}` : ""}`
        : zh
          ? `主会话 — ${selectedTree.title}`
          : `Main Session — ${selectedTree.title}`;
      Object.assign(sessionTitle.style, {
        fontSize: "13.5px",
        fontWeight: "600",
        color: tokens.foreground,
      });

      const actionBtnsWrap = document.createElement("div");
      Object.assign(actionBtnsWrap.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
      });

      if (activeSub) {
        const parentCid = activeSub.parentConversationId;
        const parentNode = selectedTree.flatSubagents.find(
          (s) => s.conversationId === parentCid,
        );
        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.setAttribute("data-testid", "paseo-finder-subagent-jump-parent");
        upBtn.textContent = parentNode
          ? zh
            ? `返回父级 L${parentNode.depth} ${parentNode.subAgentType}`
            : `Back to L${parentNode.depth} ${parentNode.subAgentType}`
          : zh
            ? "返回主会话"
            : "Back to Main Session";
        Object.assign(upBtn.style, {
          padding: "4px 9px",
          borderRadius: "6px",
          border: `1px solid ${tokens.border}`,
          backgroundColor: tokens.surface2,
          color: tokens.foreground,
          fontSize: "11px",
          fontWeight: "500",
          cursor: "pointer",
        });
        upBtn.addEventListener("click", () => {
          selectedCid = parentCid;
          renderPanes();
        });
        actionBtnsWrap.appendChild(upBtn);
      }

      if (activeSub?.transcriptPath) {
        const revealBtn = document.createElement("button");
        revealBtn.type = "button";
        revealBtn.textContent = zh ? "定位日志" : "Reveal Transcript";
        Object.assign(revealBtn.style, {
          padding: "4px 9px",
          borderRadius: "6px",
          border: `1px solid ${tokens.border}`,
          backgroundColor: tokens.surface2,
          color: tokens.foreground,
          fontSize: "11px",
          cursor: "pointer",
        });
        revealBtn.addEventListener("click", () => {
          void client.call(openFileTargetRpc, {
            path: activeSub.transcriptPath,
            target: "finder-reveal" as OpenerTarget,
          });
        });
        actionBtnsWrap.appendChild(revealBtn);
      }

      if (activeSub && activeSub.depth === 1) {
        const nativeTabBtn = document.createElement("button");
        nativeTabBtn.type = "button";
        nativeTabBtn.textContent = zh ? "原生子标签打开" : "Open Native Tab";
        Object.assign(nativeTabBtn.style, {
          padding: "4px 9px",
          borderRadius: "6px",
          border: `1px solid ${tokens.accent}`,
          backgroundColor: tokens.surface2,
          color: tokens.foreground,
          fontSize: "11px",
          fontWeight: "500",
          cursor: "pointer",
        });
        nativeTabBtn.addEventListener("click", () => {
          if (tryClickNativeSubagentTrackRow(activeSub.conversationId)) {
            closeDrawer();
          }
        });
        actionBtnsWrap.appendChild(nativeTabBtn);
      }

      const activeScopeNow = resolveActiveScope();
      if (
        activeScopeNow.agentId !== selectedTree.agentId &&
        activeScopeNow.workspaceId !== normalizeWorkspaceKey(selectedTree.workspaceId)
      ) {
        const jumpAgentBtn = document.createElement("button");
        jumpAgentBtn.type = "button";
        jumpAgentBtn.textContent = zh ? "跳转至该工作区" : "Jump to Workspace";
        Object.assign(jumpAgentBtn.style, {
          padding: "4px 9px",
          borderRadius: "6px",
          border: `1px solid ${tokens.border}`,
          backgroundColor: tokens.primary,
          color: tokens.primaryForeground,
          fontSize: "11px",
          fontWeight: "500",
          cursor: "pointer",
        });
        jumpAgentBtn.addEventListener("click", () => {
          const normW = normalizeWorkspaceKey(selectedTree!.workspaceId);
          if (normW && focusWorkspaceInApp(normW, null, document as never, window as never)) {
            return;
          }
          const nextUrl = normW
            ? `/h/local/workspace/${normW}`
            : `/ag/${selectedTree!.agentId}`;
          window.history.pushState({}, "", nextUrl);
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        actionBtnsWrap.appendChild(jumpAgentBtn);
      }

      topInfoRow.appendChild(sessionTitle);
      topInfoRow.appendChild(actionBtnsWrap);
      sessionHeader.appendChild(topInfoRow);

      // 3. Metadata + Filter tabs
      const metaRow = document.createElement("div");
      Object.assign(metaRow.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        flexWrap: "wrap",
      });

      const metaStats = document.createElement("div");
      const stepCnt = activeSub ? activeSub.stepCount : selectedTree.rootStepCount;
      const toolCnt = activeSub ? activeSub.toolCallCount : selectedTree.rootToolCallCount;
      metaStats.textContent = `ID: ${currentCid.slice(0, 12)} · ${
        zh ? `步数: ${stepCnt} · 工具: ${toolCnt}` : `Steps: ${stepCnt} · Tools: ${toolCnt}`
      }${activeSub?.lastToolName ? ` · ${activeSub.lastToolName}` : ""}`;
      Object.assign(metaStats.style, {
        fontSize: "11px",
        color: tokens.foregroundMuted,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      });

      const filterWrap = document.createElement("div");
      Object.assign(filterWrap.style, {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        flexWrap: "wrap",
      });

      const filters: {
        key: "all" | "messages" | "tools" | "timers";
        label: string;
      }[] = [
        {
          key: "all",
          label: zh ? `全部 (${timelineItems.length})` : `All (${timelineItems.length})`,
        },
        {
          key: "messages",
          label: zh
            ? `对话与汇报 (${timelineItems.filter((i) => i.type !== "tool_call").length})`
            : `Messages (${timelineItems.filter((i) => i.type !== "tool_call").length})`,
        },
        {
          key: "tools",
          label: zh
            ? `工具调用 (${timelineItems.filter((i) => i.type === "tool_call").length})`
            : `Tools (${timelineItems.filter((i) => i.type === "tool_call").length})`,
        },
        {
          key: "timers",
          label: zh
            ? `计时与后台任务 (${activeTimers.length})`
            : `Timers & Tasks (${activeTimers.length})`,
        },
      ];

      for (const f of filters) {
        const fBtn = document.createElement("button");
        fBtn.type = "button";
        fBtn.setAttribute("data-testid", `paseo-finder-subagent-filter-${f.key}`);
        fBtn.textContent = f.label;
        const active = timelineFilter === f.key;
        Object.assign(fBtn.style, {
          padding: "3px 8px",
          borderRadius: "6px",
          fontSize: "11px",
          fontWeight: active ? "600" : "500",
          cursor: "pointer",
          border: `1px solid ${active ? tokens.accent : tokens.border}`,
          backgroundColor: active ? tokens.surface2 : tokens.surface0,
          color: tokens.foreground,
        });
        fBtn.addEventListener("click", () => {
          timelineFilter = f.key;
          renderPanes();
        });
        filterWrap.appendChild(fBtn);
      }

      metaRow.appendChild(metaStats);
      metaRow.appendChild(filterWrap);
      sessionHeader.appendChild(metaRow);
      rightPane.appendChild(sessionHeader);

      // Timeline Scroll Container
      const timelineScroll = document.createElement("div");
      Object.assign(timelineScroll.style, {
        flex: "1",
        overflowY: "auto",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      });

      // Show Timers & Background Tasks summary card when on "timers" tab or when running timers exist
      if (timelineFilter === "timers" || activeTimers.some((t) => t.status === "running")) {
        const timersList =
          timelineFilter === "timers"
            ? activeTimers
            : activeTimers.filter((t) => t.status === "running");
        if (timersList.length > 0) {
          const timersBox = document.createElement("div");
          timersBox.setAttribute("data-testid", "paseo-finder-subagent-timers-list");
          Object.assign(timersBox.style, {
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "10px 12px",
            borderRadius: "8px",
            backgroundColor: tokens.surface1,
            border: `1px solid ${tokens.border}`,
          });

          const tHeader = document.createElement("div");
          tHeader.textContent = zh
            ? `计时器与后台任务 (${timersList.length})`
            : `Timers & Background Tasks (${timersList.length})`;
          Object.assign(tHeader.style, {
            fontSize: "11.5px",
            fontWeight: "600",
            color: tokens.foreground,
          });
          timersBox.appendChild(tHeader);

          for (const tm of timersList) {
            const tsc = statusColors(tm.status, tokens);
            const tRow = document.createElement("div");
            Object.assign(tRow.style, {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              padding: "6px 8px",
              borderRadius: "6px",
              backgroundColor: tokens.surface0,
              border: `1px solid ${tokens.border}`,
            });

            const tLeft = document.createElement("div");
            Object.assign(tLeft.style, {
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              minWidth: "0",
              flex: "1",
            });

            const tTitle = document.createElement("div");
            const kindLabel =
              tm.kind === "timer"
                ? zh
                  ? `计时器${tm.durationSeconds ? ` (${tm.durationSeconds}s)` : ""}`
                  : `Timer${tm.durationSeconds ? ` (${tm.durationSeconds}s)` : ""}`
                : zh
                  ? "后台命令任务"
                  : "Background Command";
            tTitle.textContent = `#${tm.stepIndex} · ${kindLabel} · ${tm.taskId.split("/").pop() ?? tm.taskId}`;
            Object.assign(tTitle.style, {
              fontSize: "11px",
              fontWeight: "600",
              color: tokens.foreground,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            });

            const tPrompt = document.createElement("div");
            tPrompt.textContent = tm.prompt;
            Object.assign(tPrompt.style, {
              fontSize: "11px",
              color: tokens.foregroundMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            });

            tLeft.appendChild(tTitle);
            tLeft.appendChild(tPrompt);

            const tBadge = document.createElement("span");
            tBadge.textContent = formatStatusLabel(tm.status, zh);
            Object.assign(tBadge.style, {
              fontSize: "10.5px",
              fontWeight: "600",
              padding: "1px 6px",
              borderRadius: "999px",
              backgroundColor: tsc.bg,
              color: tsc.fg,
              border: `1px solid ${tsc.border}`,
              flexShrink: "0",
            });

            tRow.appendChild(tLeft);
            tRow.appendChild(tBadge);
            timersBox.appendChild(tRow);
          }

          timelineScroll.appendChild(timersBox);
        } else if (timelineFilter === "timers") {
          const noTimers = document.createElement("div");
          noTimers.textContent = zh
            ? "该会话暂无计时器或后台任务记录。"
            : "No timers or background tasks recorded in this session.";
          Object.assign(noTimers.style, {
            fontSize: "12px",
            color: tokens.foregroundMuted,
            padding: "16px 0",
          });
          timelineScroll.appendChild(noTimers);
        }
      }

      if (timelineFilter !== "timers") {
        const filteredItems = timelineItems.filter((item) => {
          if (timelineFilter === "messages") return item.type !== "tool_call";
          if (timelineFilter === "tools") return item.type === "tool_call";
          return true;
        });

        if (filteredItems.length === 0) {
          const emptyTl = document.createElement("div");
          emptyTl.textContent = isInspectingRoot
            ? zh
              ? "点击上方任一 L1 / L2 子智能体节点可查看其完整执行轨迹。"
              : "Select any L1 / L2 subagent node above to inspect its timeline."
            : zh
              ? "该筛选条件下暂无步骤记录。"
              : "No timeline items match the current filter.";
          Object.assign(emptyTl.style, {
            fontSize: "12.5px",
            color: tokens.foregroundMuted,
            padding: "16px 0",
          });
          timelineScroll.appendChild(emptyTl);
        }

        for (const item of filteredItems) {
          if (item.type === "tool_call") {
            const tcRow = document.createElement("div");
            const isSubCall = Boolean(item.childConversationId);
            tcRow.setAttribute("data-testid", `paseo-finder-timeline-tool-${item.stepIndex}`);
            Object.assign(tcRow.style, {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              padding: "7px 11px",
              borderRadius: "7px",
              backgroundColor: tokens.surface1,
              border: `1px solid ${isSubCall ? tokens.accent : tokens.border}`,
              cursor: isSubCall ? "pointer" : "default",
            });

            const leftInfo = document.createElement("div");
            Object.assign(leftInfo.style, {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              minWidth: "0",
              flex: "1",
            });

            const stepTag = document.createElement("span");
            stepTag.textContent = `#${item.stepIndex}`;
            Object.assign(stepTag.style, {
              fontSize: "10.5px",
              color: tokens.foregroundMuted,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              flexShrink: "0",
            });

            const toolName = document.createElement("span");
            toolName.textContent = item.subAgentType
              ? `invoke_subagent (${item.subAgentType})`
              : item.name || "tool_call";
            Object.assign(toolName.style, {
              fontSize: "11.5px",
              fontWeight: "600",
              color: tokens.foreground,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              flexShrink: "0",
            });

            const sumText = document.createElement("span");
            sumText.textContent = item.summary || "";
            Object.assign(sumText.style, {
              fontSize: "11.5px",
              color: tokens.foregroundMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            });

            leftInfo.appendChild(stepTag);
            leftInfo.appendChild(toolName);
            leftInfo.appendChild(sumText);
            tcRow.appendChild(leftInfo);

            if (item.childConversationId) {
              const jumpSubBtn = document.createElement("span");
              jumpSubBtn.textContent = zh ? "跳转子会话 →" : "Open Session →";
              Object.assign(jumpSubBtn.style, {
                fontSize: "11px",
                fontWeight: "600",
                color: tokens.accent,
                flexShrink: "0",
              });
              tcRow.appendChild(jumpSubBtn);
              tcRow.addEventListener("click", () => {
                selectedCid = item.childConversationId!;
                renderPanes();
              });
            }

            timelineScroll.appendChild(tcRow);
            continue;
          }

          // User or Assistant Message card
          const isUser = item.type === "user_message";
          const msgCard = document.createElement("div");
          Object.assign(msgCard.style, {
            padding: "10px 13px",
            borderRadius: "8px",
            backgroundColor: isUser ? tokens.surface2 : tokens.surface1,
            border: `1px solid ${tokens.border}`,
            display: "flex",
            flexDirection: "column",
            gap: "5px",
          });

          const msgHeader = document.createElement("div");
          Object.assign(msgHeader.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "11px",
            fontWeight: "600",
            color: tokens.foregroundMuted,
          });
          msgHeader.textContent = isUser
            ? item.sender
              ? zh
                ? `来自 ${item.sender.slice(0, 8)} 的消息 · 步骤 #${item.stepIndex}`
                : `Message from ${item.sender.slice(0, 8)} · Step #${item.stepIndex}`
              : zh
                ? `任务指令 · 步骤 #${item.stepIndex}`
                : `Task Prompt · Step #${item.stepIndex}`
            : zh
              ? `智能体回复 · 步骤 #${item.stepIndex}`
              : `Agent Response · Step #${item.stepIndex}`;

          const msgBody = document.createElement("div");
          msgBody.textContent = item.text || "";
          Object.assign(msgBody.style, {
            fontSize: "12.5px",
            lineHeight: "1.55",
            color: tokens.foreground,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "340px",
            overflowY: "auto",
          });

          msgCard.appendChild(msgHeader);
          msgCard.appendChild(msgBody);
          timelineScroll.appendChild(msgCard);
        }
      }

      rightPane.appendChild(timelineScroll);
    };

    refreshBtn.addEventListener("click", () => {
      void loadAndRender();
    });

    await loadAndRender();
  };

  externalOpenDrawerFn = (opts) => {
    void openDrawer(opts);
  };

  // Render collapsible Subagent & Timer Tree persistently under each workspace row in Paseo's Left Sidebar
  // so clicking into or away from a workspace causes 0px layout shift ("shrinking") and 0ms delay.
  const renderSingleWorkspaceLeftSidebarTree = (
    tree: SubagentAgentTree,
    normWs: string,
    isActiveWorkspace: boolean,
    zh: boolean,
    tokens: ReturnType<typeof syncPaseoThemeCssVariables>,
  ): HTMLElement | null => {
    const candidateSelectors = [
      `[data-testid="sidebar-workspace-row-${tree.workspaceId}"]`,
      `[data-testid="sidebar-workspace-row-local:${normWs}"]`,
      `[data-testid="sidebar-workspace-row-${normWs}"]`,
      `[data-testid^="sidebar-workspace-row-"][data-testid$=":${normWs}"]`,
    ];
    let targetWsRow: HTMLElement | null = null;
    for (const sel of candidateSelectors) {
      targetWsRow = document.querySelector<HTMLElement>(sel);
      if (targetWsRow) break;
    }

    const existingForWs = document.querySelector<HTMLElement>(
      `[data-testid="paseo-finder-left-sidebar-subagents"][data-workspace-id="${normWs}"]`,
    );

    if (
      !targetWsRow ||
      !targetWsRow.parentElement ||
      tree.subagentSummary.total <= 0 ||
      tree.flatSubagents.length === 0
    ) {
      existingForWs?.remove();
      return null;
    }

    const totalTimers =
      (tree.rootTimersAndTasks?.length ?? 0) +
      tree.flatSubagents.reduce((acc, s) => acc + (s.timersAndTasks?.length ?? 0), 0);

    const activeSub = isActiveWorkspace
      ? resolveActiveSubagentNodeFromDom(tree, document, window)
      : null;
    const activeSubCid = activeSub?.conversationId ?? "";
    const allDone = tree.subagentSummary.running === 0;
    const allArchived = allDone && isAllSubagentsArchivedForTree(tree, window);
    const wsCollapsed = isWorkspaceSidebarTreeCollapsed(normWs, tree);
    const sig = `${normWs}:${tree.agentId}:${activeSubCid}:${tree.subagentSummary.total}:${tree.subagentSummary.running}:${tree.subagentSummary.totalSubagentSteps}:${totalTimers}:${allArchived}:${wsCollapsed}:${zh}`;

    let container = existingForWs;
    if (!container || container.previousElementSibling !== targetWsRow) {
      existingForWs?.remove();
      container = document.createElement("div");
      container.setAttribute("data-testid", "paseo-finder-left-sidebar-subagents");
      container.setAttribute("data-workspace-id", normWs);
      targetWsRow.insertAdjacentElement("afterend", container);
    }

    if (container.getAttribute("data-render-sig") === sig) {
      return container;
    }
    container.setAttribute("data-render-sig", sig);
    container.innerHTML = "";

    Object.assign(container.style, {
      display: "flex",
      flexDirection: "column",
      gap: "1px",
      margin: "2px 8px 4px 18px",
      paddingLeft: "8px",
      borderLeft: `1px solid ${tokens.border}`,
      fontFamily:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    const headerRow = document.createElement("div");
    headerRow.setAttribute("data-testid", "paseo-finder-left-sidebar-subagents-toggle");
    headerRow.setAttribute("data-workspace-id", normWs);
    Object.assign(headerRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "3px 6px",
      borderRadius: "5px",
      cursor: "pointer",
      userSelect: "none",
    });

    const headerLeft = document.createElement("div");
    Object.assign(headerLeft.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minWidth: "0",
    });

    const headerDot = document.createElement("span");
    Object.assign(headerDot.style, {
      width: "5px",
      height: "5px",
      borderRadius: "999px",
      backgroundColor: allDone ? tokens.statusSuccess : tokens.statusWarning,
      flexShrink: "0",
    });

    const headerStateSuffix = allArchived
      ? zh
        ? " · 已归档"
        : " · Archived"
      : allDone
        ? zh
          ? " · 已完成"
          : " · Done"
        : zh
          ? ` · ${tree.subagentSummary.running} 运行中`
          : ` · ${tree.subagentSummary.running} running`;

    const headerLabel = document.createElement("span");
    headerLabel.textContent = zh
      ? `${wsCollapsed ? "▸" : "▾"} 子会话 (${tree.subagentSummary.total}${headerStateSuffix})`
      : `${wsCollapsed ? "▸" : "▾"} Subagents (${tree.subagentSummary.total}${headerStateSuffix})`;
    Object.assign(headerLabel.style, {
      fontSize: "11px",
      fontWeight: "500",
      color: tokens.foregroundMuted,
    });

    headerLeft.appendChild(headerDot);
    headerLeft.appendChild(headerLabel);
    headerRow.appendChild(headerLeft);
    headerRow.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const nextCollapsed = !isWorkspaceSidebarTreeCollapsed(normWs, tree);
      collapsedByWorkspaceId.set(normWs, nextCollapsed);
      persistWorkspaceCollapsedMap();
      const curScope = resolveActiveScope();
      renderLeftSidebarSubagentsTree(getCachedTreeForScope(curScope), curScope);
    });
    container.appendChild(headerRow);

    if (wsCollapsed) {
      return container;
    }

    // Root L0 row inside Left Sidebar Subagents Tree:
    // Show ONLY when the user is actively viewing an L1/L2+ subagent inside this workspace so it never
    // duplicates the parent workspace row on L0 Main Agent or on inactive background workspaces.
    const showReturnToRoot = isActiveWorkspace && Boolean(activeSub);
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.setAttribute("data-testid", "paseo-finder-left-sidebar-subagent-root");
    rootBtn.setAttribute("aria-current", !showReturnToRoot ? "true" : "false");
    Object.assign(rootBtn.style, {
      display: showReturnToRoot ? "flex" : "none",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "6px",
      padding: "3px 6px",
      borderRadius: "5px",
      border: "none",
      backgroundColor: "transparent",
      color: tokens.foregroundMuted,
      fontSize: "11px",
      cursor: "pointer",
      textAlign: "left",
    });
    const rootLeft = document.createElement("span");
    rootLeft.textContent = zh ? "↩ L0 主会话" : "↩ L0 Main Agent";
    Object.assign(rootLeft.style, {
      fontSize: "11px",
      fontWeight: "500",
      color: tokens.foregroundMuted,
    });
    rootBtn.appendChild(rootLeft);
    rootBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (
        !openOrFocusSubagentOrRootTabInApp(
          {
            workspaceId: tree.workspaceId,
            parentAgentId: tree.agentId,
            subagentId: null,
          },
          document,
          window,
        )
      ) {
        void openDrawer({
          agentId: tree.agentId,
          workspaceId: tree.workspaceId,
          conversationId: tree.rootConversationId,
          layoutMode: "docked-right",
        });
      }
    });
    container.appendChild(rootBtn);

    for (const sub of tree.flatSubagents) {
      const sc = statusColors(sub.status, tokens);
      const isSubActive = isActiveWorkspace && activeSub?.conversationId === sub.conversationId;
      const parentSub =
        sub.depth >= 2
          ? tree.flatSubagents.find(
              (p) =>
                normalizeSubagentArchiveId(p.conversationId) ===
                normalizeSubagentArchiveId(sub.parentConversationId),
            )
          : null;
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.setAttribute(
        "data-testid",
        `paseo-finder-left-sidebar-subagent-${sub.conversationId.slice(0, 8)}`,
      );
      itemBtn.setAttribute("data-depth", String(sub.depth));
      itemBtn.setAttribute("aria-current", isSubActive ? "true" : "false");
      const indentPx = Math.max(0, (sub.depth - 1) * 10);
      Object.assign(itemBtn.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "6px",
        marginLeft: `${indentPx}px`,
        padding: "3px 6px",
        borderRadius: "5px",
        border: `1px solid ${isSubActive ? tokens.border : "transparent"}`,
        backgroundColor: isSubActive ? tokens.surface2 : "transparent",
        color: isSubActive ? tokens.foreground : tokens.foregroundMuted,
        fontSize: "11px",
        cursor: "pointer",
        textAlign: "left",
      });

      const leftPart = document.createElement("div");
      Object.assign(leftPart.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        minWidth: "0",
        flex: "1",
      });

      const dot = document.createElement("span");
      Object.assign(dot.style, {
        width: "5px",
        height: "5px",
        borderRadius: "999px",
        backgroundColor: sc.dot,
        flexShrink: "0",
      });

      const nameEl = document.createElement("span");
      const shortName = formatSubagentDisplayName(sub, parentSub, 24);
      const fullSubTitle = formatSubagentDisplayName(sub, null, 60);
      nameEl.textContent = `L${sub.depth} ${shortName}`;
      Object.assign(nameEl.style, {
        fontSize: "11px",
        fontWeight: isSubActive ? "600" : "500",
        color: isSubActive ? tokens.foreground : tokens.foregroundMuted,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });

      leftPart.appendChild(dot);
      leftPart.appendChild(nameEl);

      const metaEl = document.createElement("span");
      const finishedClock =
        sub.status !== "running" && sub.updatedAt
          ? formatConciseLocalFinishedTime(sub.updatedAt)
          : "";
      const statusWord = formatStatusLabel(sub.status, zh);
      metaEl.textContent = finishedClock || statusWord;
      const fullParentHint = parentSub
        ? `↖ L${parentSub.depth} ${formatSubagentDisplayName(parentSub, null, 28)} · `
        : "";
      const timeTip = sub.updatedAt ? ` · ${formatFullLocalFinishedTooltip(sub.updatedAt)}` : "";
      itemBtn.title = `L${sub.depth} ${fullSubTitle} (${fullParentHint}${statusWord} · ${sub.stepCount} steps${timeTip})`;
      Object.assign(metaEl.style, {
        fontSize: "10px",
        color: tokens.foregroundMuted,
        flexShrink: "0",
      });

      itemBtn.appendChild(leftPart);
      itemBtn.appendChild(metaEl);

      itemBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (
          !ev.shiftKey &&
          openOrFocusSubagentOrRootTabInApp(
            {
              workspaceId: tree.workspaceId,
              parentAgentId: tree.agentId,
              subagentId: sub.conversationId,
            },
            document,
            window,
          )
        ) {
          return;
        }
        void openDrawer({
          agentId: tree.agentId,
          workspaceId: tree.workspaceId,
          conversationId: sub.conversationId,
          layoutMode: "docked-right",
        });
      });

      container.appendChild(itemBtn);
    }
    return container;
  };

  const renderLeftSidebarSubagentsTree = (
    tree: SubagentAgentTree | null,
    scope: { scopeKey: string | null; agentId: string | null; workspaceId: string | null },
  ) => {
    if (tree && tree.subagentSummary.total > 0 && tree.flatSubagents.length > 0) {
      const normActiveWs = normalizeWorkspaceKey(tree.workspaceId) ?? scope.workspaceId;
      if (normActiveWs) {
        workspaceTreesByWsId.set(normActiveWs, tree);
      }
    }

    const zh = isZh();
    const tokens = syncPaseoThemeCssVariables(document as never, window as never);
    const activeNormWs = scope.workspaceId;
    const mountedContainers = new Set<HTMLElement>();

    for (const [normWs, wsTree] of workspaceTreesByWsId.entries()) {
      const mounted = renderSingleWorkspaceLeftSidebarTree(
        wsTree,
        normWs,
        normWs === activeNormWs,
        zh,
        tokens,
      );
      if (mounted) {
        mountedContainers.add(mounted);
      }
    }

    const allLeftTrees = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="paseo-finder-left-sidebar-subagents"]'),
    );
    for (const el of allLeftTrees) {
      if (!mountedContainers.has(el)) {
        el.remove();
      }
    }
  };

  const archiveFinishedSubagentsForTree = (tree: SubagentAgentTree | null) => {
    if (!tree || tree.flatSubagents.length === 0) return;
    const finishedIds = tree.flatSubagents
      .filter((s) => s.status !== "running")
      .flatMap((s) => [s.conversationId, `vec-subagent:${s.conversationId}`]);
    if (finishedIds.length === 0) return;
    markSubagentsArchivedForAgent(tree.agentId, finishedIds, window);

    // Also invoke Paseo's native useProviderSubagentStore.hideFromTrack or click the native Archive button if mounted
    const nativeArchiveBtn = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="subagents-track-archive-finished"]',
      window,
    );
    if (nativeArchiveBtn) {
      nativeArchiveBtn.click();
    } else {
      const modules = getMetroModuleList(window);
      for (const mod of modules) {
        const exp = mod?.publicModule?.exports;
        if (typeof exp?.useProviderSubagentStore?.getState === "function") {
          try {
            const st = exp.useProviderSubagentStore.getState();
            if (typeof st?.hideFromTrack === "function") {
              st.hideFromTrack("local", tree.agentId, finishedIds);
            }
          } catch {
            // ignore
          }
        }
      }
    }
    const normTreeWs = normalizeWorkspaceKey(tree.workspaceId);
    if (normTreeWs) {
      collapsedByWorkspaceId.set(normTreeWs, true);
      persistWorkspaceCollapsedMap();
    }
    decorateActiveAgentSubagentsDom(tree);
  };

  const syncOpenSubagentWorkspaceTabsDom = (tree: SubagentAgentTree | null) => {
    if (!tree || tree.flatSubagents.length === 0) return;
    const allSubTabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="workspace-tab-provider_subagent_"]'),
    );
    for (const tabEl of allSubTabs) {
      const parsed = parseProviderSubagentTabTestId(tabEl.getAttribute("data-testid"));
      if (!parsed) continue;
      if (
        tree.agentId &&
        parsed.parentAgentId !== tree.agentId &&
        !tree.agentId.startsWith(parsed.parentAgentId)
      ) {
        continue;
      }
      const cleanSubId = normalizeSubagentArchiveId(parsed.subagentId);
      const matchedSub = tree.flatSubagents.find(
        (s) =>
          normalizeSubagentArchiveId(s.conversationId) === cleanSubId ||
          s.conversationId.startsWith(cleanSubId),
      );
      if (!matchedSub) continue;
      const parentSub =
        matchedSub.depth >= 2
          ? tree.flatSubagents.find(
              (p) =>
                normalizeSubagentArchiveId(p.conversationId) ===
                normalizeSubagentArchiveId(matchedSub.parentConversationId),
            )
          : null;
      const conciseLabel = `L${matchedSub.depth} ${formatSubagentDisplayName(matchedSub, parentSub, 22)}`;
      const fullTooltip = `L${matchedSub.depth} ${formatSubagentDisplayName(matchedSub, null, 60)}${
        matchedSub.role && matchedSub.role.toLowerCase() !== matchedSub.subAgentType.toLowerCase()
          ? ` · ${matchedSub.role}`
          : ""
      }`;
      if (tabEl.title !== fullTooltip) {
        tabEl.title = fullTooltip;
      }
      if (typeof document.createTreeWalker === "function") {
        const walker = document.createTreeWalker(tabEl, 4 /* NodeFilter.SHOW_TEXT */);
        let bestNode: Node | null = null;
        let cur = walker.nextNode();
        while (cur) {
          const pEl = cur.parentElement;
          const val = (cur.nodeValue ?? "").trim();
          if (
            val.length >= 2 &&
            pEl &&
            !pEl.closest('[aria-label*="Close"], [aria-label*="关闭"], [data-testid*="close"], svg')
          ) {
            if (/^(?:Main\s*›\s*)?L\d+\s+/i.test(val)) {
              bestNode = cur;
              break;
            }
            if (!bestNode) bestNode = cur;
          }
          cur = walker.nextNode();
        }
        if (bestNode && bestNode.nodeValue !== conciseLabel) {
          bestNode.nodeValue = conciseLabel;
        }
      } else {
        const leaves = Array.from(tabEl.querySelectorAll<HTMLElement>("div, span")).filter(
          (el) =>
            el.children.length === 0 &&
            !el.closest('[aria-label*="Close"], [aria-label*="关闭"], [data-testid*="close"], svg') &&
            (el.textContent ?? "").trim().length >= 2,
        );
        const labelLeaf =
          leaves.find((el) => /^(?:Main\s*›\s*)?L\d+\s+/i.test((el.textContent ?? "").trim())) ??
          leaves[0];
        if (labelLeaf && labelLeaf.textContent !== conciseLabel) {
          labelLeaf.textContent = conciseLabel;
        }
      }
      tabEl.setAttribute("data-vec-tab-label", conciseLabel);
    }
  };

  const enhanceNativeSubagentTrackDom = (
    tree: SubagentAgentTree | null,
    zh: boolean,
    tokens: ReturnType<typeof syncPaseoThemeCssVariables>,
  ) => {
    const nativeHeader = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="subagents-track-header"]',
      window,
    );
    const nativeArchiveBtn = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="subagents-track-archive-finished"]',
      window,
    );

    if (nativeArchiveBtn && nativeArchiveBtn.getAttribute("data-vec-archive-hooked") !== "1") {
      nativeArchiveBtn.setAttribute("data-vec-archive-hooked", "1");
      nativeArchiveBtn.addEventListener("click", () => {
        const curScope = resolveActiveScope();
        const curTree = tree ?? getCachedTreeForScope(curScope);
        if (curTree) {
          const finishedIds = curTree.flatSubagents
            .filter((s) => s.status !== "running")
            .map((s) => s.conversationId);
          markSubagentsArchivedForAgent(curTree.agentId, finishedIds, window);
          const normCurWs = normalizeWorkspaceKey(curTree.workspaceId);
          if (normCurWs) {
            collapsedByWorkspaceId.set(normCurWs, true);
            persistWorkspaceCollapsedMap();
          }
          setTimeout(() => {
            decorateActiveAgentSubagentsDom(curTree);
          }, 40);
        }
      });
    }

    const nativeRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="subagents-track-row-"]'),
    );
    let anyNativeRowRunning = false;
    for (const rowEl of nativeRows) {
      const tid = rowEl.getAttribute("data-testid") ?? "";
      const rawCid = tid
        .replace(/^subagents-track-row-(?:vec-subagent:)?/i, "")
        .trim();
      const matchedSub = tree?.flatSubagents.find(
        (s) => s.conversationId === rawCid || rawCid.endsWith(s.conversationId),
      );
      const isRowDone = matchedSub
        ? matchedSub.status !== "running"
        : Boolean(tree && tree.subagentSummary.running === 0) ||
          /\[Done\b/i.test(rowEl.textContent ?? "");
      if (!isRowDone && /\[Running\b/i.test(rowEl.textContent ?? "")) {
        anyNativeRowRunning = true;
      }
      if (isRowDone && typeof document.createTreeWalker === "function") {
        const walker = document.createTreeWalker(rowEl, 4 /* NodeFilter.SHOW_TEXT */);
        let tNode = walker.nextNode();
        while (tNode) {
          const val = tNode.nodeValue ?? "";
          if (/\[Running\b/i.test(val)) {
            tNode.nodeValue = val.replace(/\[Running\b/gi, "[Done");
          }
          tNode = walker.nextNode();
        }
      }
    }

    if (!nativeHeader) return;

    // If user already archived all finished subagents for this agent, hide the stale native pill
    if (tree && isAllSubagentsArchivedForTree(tree, window)) {
      const trackContainer =
        nativeHeader.closest<HTMLElement>('[data-testid="subagents-track"]') ??
        nativeHeader;
      trackContainer.style.display = "none";
      return;
    }

    const isAllDone =
      (tree && tree.subagentSummary.total > 0 && tree.subagentSummary.running === 0) ||
      (Boolean(nativeArchiveBtn) && !anyNativeRowRunning && (!tree || tree.subagentSummary.running === 0));

    if (!isAllDone) return;

    const doneWord = zh ? "已完成" : "Done";
    const textLeaves = Array.from(nativeHeader.querySelectorAll<HTMLElement>("div, span")).filter(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0,
    );
    const pillTextEl =
      textLeaves.find((el) =>
        /^\d+\s+subagents?(?:\s*\u00b7\s*(?:Done|已完成))?$|^\d+\s*个子智能体(?:\s*\u00b7\s*(?:Done|已完成))?$/i.test(
          (el.textContent ?? "").trim(),
        ),
      ) ?? textLeaves[0];

    if (pillTextEl) {
      const rawTxt = (pillTextEl.textContent ?? "").trim();
      const strippedBase = rawTxt.replace(/\s*\u00b7\s*(?:Done|已完成)$/i, "").trim();
      const totalFromTree = tree?.subagentSummary?.total ?? 0;
      const baseTxt =
        totalFromTree > 0
          ? zh
            ? `${totalFromTree} 个子智能体`
            : `${totalFromTree} ${totalFromTree === 1 ? "subagent" : "subagents"}`
          : strippedBase;
      const targetTxt = `${baseTxt} \u00b7 ${doneWord}`;
      if (rawTxt !== targetTxt) {
        pillTextEl.textContent = targetTxt;
      }
      const parentFlex = pillTextEl.parentElement ?? nativeHeader;
      let doneDot = parentFlex.querySelector<HTMLElement>(
        '[data-testid="paseo-finder-native-pill-done-dot"]',
      );
      if (!doneDot) {
        doneDot = document.createElement("span");
        doneDot.setAttribute("data-testid", "paseo-finder-native-pill-done-dot");
        parentFlex.insertBefore(doneDot, pillTextEl);
      }
      Object.assign(doneDot.style, {
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "999px",
        backgroundColor: tokens.statusSuccess,
        marginRight: "6px",
        flexShrink: "0",
      });
    }
  };

  // Decorate inline `[data-testid="tool-call-badge"]` rows for subagents / timers
  // and render Connected Subagents Bar above composer + Left Sidebar Subagents Tree
  const decorateActiveAgentSubagentsDom = (tree: SubagentAgentTree | null) => {
    const zh = isZh();
    const tokens = syncPaseoThemeCssVariables(document as never, window as never);
    const scope = resolveActiveScope();

    patchPaseoSubagentTrackModules(window, (parentAgentId) => {
      const curScope = resolveActiveScope();
      const curTree = getCachedTreeForScope(curScope);
      if (curTree && (!parentAgentId || curTree.agentId.startsWith(parentAgentId))) {
        const normCurWs = normalizeWorkspaceKey(curTree.workspaceId);
        if (normCurWs) {
          collapsedByWorkspaceId.set(normCurWs, true);
          persistWorkspaceCollapsedMap();
        }
        decorateActiveAgentSubagentsDom(curTree);
      }
    });
    enhanceNativeSubagentTrackDom(tree, zh, tokens);
    syncOpenSubagentWorkspaceTabsDom(tree);

    // 1. Left Sidebar Subagents Tree under the active workspace row
    renderLeftSidebarSubagentsTree(tree, scope);

    const activeSub = resolveActiveSubagentNodeFromDom(tree, document, window);
    const lineageInfo = buildSubagentLineageChain(tree, activeSub?.conversationId ?? null);

    // 1b. Upgrade Paseo's bottom `[data-testid="parent-agent-callout"]` inside `[data-testid="provider-subagent-panel"]`
    // so Subagent 2 (L2+) clearly shows its immediate parent Subagent 1 (L1) and jumps L2 -> L1 -> Main Agent step by step!
    const parentCallout = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="parent-agent-callout"]',
      window,
    );
    const parentCalloutOpenBtn = queryFirstVisible<HTMLElement>(
      document,
      '[data-testid="parent-agent-callout-open"]',
      window,
    );
    if (parentCallout && parentCalloutOpenBtn && tree && activeSub) {
      const immediateParent = lineageInfo.immediateParentSubagent;
      const chainLabels = [
        zh ? "L0 主会话" : "L0 Main",
        ...lineageInfo.ancestorChain.map(
          (n) => `L${n.depth} ${formatSubagentDisplayName(n, null, 24)}`,
        ),
      ];
      const chainText = chainLabels.join(" › ");

      if (immediateParent && activeSub.depth >= 2) {
        const parentShort = formatSubagentDisplayName(immediateParent, null, 24);
        parentCalloutOpenBtn.setAttribute(
          "data-vec-parent-subagent-cid",
          immediateParent.conversationId,
        );
        parentCalloutOpenBtn.setAttribute("data-vec-parent-agent-id", tree.agentId);
        parentCalloutOpenBtn.setAttribute("data-vec-workspace-id", tree.workspaceId);
        // Paseo's native button already renders a leading return-arrow SVG icon (`↶`), so omit `↩ ` text prefix.
        const btnLabel = zh
          ? `返回 L${immediateParent.depth} ${parentShort}`
          : `Back to L${immediateParent.depth} ${parentShort}`;
        const btnTextLeaf =
          Array.from(parentCalloutOpenBtn.querySelectorAll<HTMLElement>("div, span")).find(
            (el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0,
          ) ?? parentCalloutOpenBtn;
        if (btnTextLeaf.textContent !== btnLabel) {
          btnTextLeaf.textContent = btnLabel;
        }
        parentCalloutOpenBtn.title = zh
          ? `逐级返回上一级子会话: L${immediateParent.depth} ${parentShort} (${immediateParent.conversationId.slice(0, 8)})`
          : `Jump one level up to parent subagent: L${immediateParent.depth} ${parentShort} (${immediateParent.conversationId.slice(0, 8)})`;

        // Render clean, non-duplicated lineage path (`L0 Main › L1 DeepInvestigator › L2 WorkerL0`) on the left
        const calloutLeaves = Array.from(
          parentCallout.querySelectorAll<HTMLElement>("div, span"),
        ).filter(
          (el) =>
            el.children.length === 0 &&
            !parentCalloutOpenBtn.contains(el) &&
            !el.closest('[data-testid="paseo-finder-callout-open-root"]') &&
            (el.textContent ?? "").trim().length > 0,
        );
        const titleLeaf = calloutLeaves[calloutLeaves.length - 1];
        if (titleLeaf) {
          if (titleLeaf.textContent !== chainText) {
            titleLeaf.textContent = chainText;
          }
        }

        // Mount a secondary `[Main Agent]` button right next to `parent-agent-callout-open` for direct root jump
        let rootJumpBtn = parentCallout.querySelector<HTMLButtonElement>(
          '[data-testid="paseo-finder-callout-open-root"]',
        );
        if (!rootJumpBtn && parentCalloutOpenBtn.parentElement) {
          rootJumpBtn = document.createElement("button");
          rootJumpBtn.type = "button";
          rootJumpBtn.setAttribute("data-testid", "paseo-finder-callout-open-root");
          parentCalloutOpenBtn.insertAdjacentElement("afterend", rootJumpBtn);
          rootJumpBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openOrFocusSubagentOrRootTabInApp(
              {
                workspaceId: tree.workspaceId,
                parentAgentId: tree.agentId,
                subagentId: null,
              },
              document,
              window,
            );
          });
        }
        if (rootJumpBtn) {
          rootJumpBtn.textContent = zh ? "主会话" : "Main Agent";
          rootJumpBtn.title = zh
            ? `跳过中间层级直接返回 L0 主会话 (${tree.title || tree.agentId.slice(0, 8)})`
            : `Jump directly to L0 Main Agent (${tree.title || tree.agentId.slice(0, 8)})`;
          Object.assign(rootJumpBtn.style, {
            marginLeft: "6px",
            padding: "4px 9px",
            borderRadius: "6px",
            fontSize: "11.5px",
            fontWeight: "600",
            cursor: "pointer",
            backgroundColor: tokens.surface2,
            color: tokens.foregroundMuted,
            border: `1px solid ${tokens.border}`,
            flexShrink: "0",
          });
        }
      } else {
        parentCalloutOpenBtn.removeAttribute("data-vec-parent-subagent-cid");
        parentCallout.querySelector('[data-testid="paseo-finder-callout-open-root"]')?.remove();
        const btnLabel = zh ? "返回 L0 主会话" : "Back to L0 Main Agent";
        const btnTextLeaf =
          Array.from(parentCalloutOpenBtn.querySelectorAll<HTMLElement>("div, span")).find(
            (el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0,
          ) ?? parentCalloutOpenBtn;
        if (btnTextLeaf.textContent !== btnLabel) {
          btnTextLeaf.textContent = btnLabel;
        }
      }
    }

    // 2. Penetrated Multi-Level Subagents Hierarchy Bar:
    // Mounts above `[data-testid="agent-composer"]` on Main Agent (L0) AND above `[data-testid="parent-agent-callout"]` inside Subagent 1 / Subagent 2!
    const allExistingBars = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="paseo-finder-subagents-bar"]'),
    );
    const hasSubagents = Boolean(
      scope.scopeKey &&
        tree &&
        tree.subagentSummary.total > 0 &&
        tree.flatSubagents.length > 0,
    );
    const isArchivedDone = Boolean(
      !activeSub && tree && isAllSubagentsArchivedForTree(tree, window),
    );
    const restoreSuppressedNativeTracks = () => {
      const suppressed = Array.from(
        document.querySelectorAll<HTMLElement>('[data-vec-suppressed-by-unified-bar="1"]'),
      );
      for (const el of suppressed) {
        el.removeAttribute("data-vec-suppressed-by-unified-bar");
        el.style.display = "";
      }
    };

    if (!hasSubagents || !tree || isArchivedDone) {
      for (const b of allExistingBars) b.remove();
      if (!isArchivedDone) {
        restoreSuppressedNativeTracks();
      }
    } else {
      const composer = queryFirstVisible<HTMLElement>(
        document,
        '[data-testid="agent-composer"], [data-testid="message-input-root"]',
        window,
      );
      const calloutAnchor = queryFirstVisible<HTMLElement>(
        document,
        '[data-testid="parent-agent-callout"]',
        window,
      );
      const subPanel = queryFirstVisible<HTMLElement>(
        document,
        '[data-testid="provider-subagent-panel"]',
        window,
      );
      const anchorEl = composer ?? calloutAnchor ?? null;
      const hostParent = anchorEl?.parentElement ?? subPanel ?? null;

      if (hostParent) {
        // Prevent double-surface visual echo: when the unified L1+L2 bar is mounted above the L0 composer,
        // hide Paseo's L1-only `[1 subagent]` ComposerTrackPill right above it so counts/rows never clash.
        const visibleNativeHeader = !activeSub
          ? queryFirstVisible<HTMLElement>(document, '[data-testid="subagents-track-header"]', window)
          : null;
        if (visibleNativeHeader) {
          visibleNativeHeader.setAttribute("data-vec-suppressed-by-unified-bar", "1");
          visibleNativeHeader.style.display = "none";
        }
        let bar = allExistingBars.find((b) => b.parentElement === hostParent) ?? null;
        for (const b of allExistingBars) {
          if (b !== bar) b.remove();
        }
        if (!bar || bar.parentElement !== hostParent) {
          bar = document.createElement("div");
          bar.setAttribute("data-testid", "paseo-finder-subagents-bar");
          if (anchorEl && anchorEl.parentElement === hostParent) {
            hostParent.insertBefore(bar, anchorEl);
          } else {
            hostParent.appendChild(bar);
          }
        }

        const allDone = tree.subagentSummary.running === 0;
        const activeCidKey = activeSub?.conversationId ?? "root";
        const sig = `${tree.agentId}:${activeCidKey}:${tree.subagentSummary.total}:${tree.subagentSummary.running}:${tree.subagentSummary.totalSubagentSteps}:${allDone}:${zh}`;
        if (bar.getAttribute("data-render-sig") !== sig) {
          bar.setAttribute("data-render-sig", sig);
          bar.innerHTML = "";
          Object.assign(bar.style, {
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
          });

          const compactBarSubName = (name: string, parentName?: string | null): string => {
            const trimmed = (name || "").trim();
            if (parentName && trimmed.length > parentName.length && trimmed.startsWith(parentName)) {
              const rest = trimmed.slice(parentName.length).replace(/^[-_\s]+/, "");
              if (rest.length >= 3) return rest;
            }
            return trimmed;
          };

          // Row A: Active Lineage Breadcrumb — hidden on L0 AND hidden whenever Paseo's bottom `parent-agent-callout`
          // is already showing the lineage path & Back/Main buttons right below `pillsRow` (zero 3-row pile-up!).
          const topRow = document.createElement("div");
          topRow.setAttribute("data-testid", "paseo-finder-subagents-lineage-row");
          Object.assign(topRow.style, {
            display: activeSub && !calloutAnchor ? "flex" : "none",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "6px",
            flexWrap: "wrap",
          });

          const breadcrumbWrap = document.createElement("div");
          Object.assign(breadcrumbWrap.style, {
            display: "flex",
            alignItems: "center",
            gap: "5px",
            flexWrap: "wrap",
          });

          // Root L0 pill in breadcrumb
          const isRootCurrent = !activeSub;
          const rootCrumb = document.createElement("button");
          rootCrumb.type = "button";
          rootCrumb.setAttribute("data-testid", "paseo-finder-breadcrumb-root");
          rootCrumb.setAttribute("aria-current", isRootCurrent ? "true" : "false");
          rootCrumb.textContent = isRootCurrent
            ? zh
              ? "L0 主会话 · 当前"
              : "L0 Main · Current"
            : zh
              ? "L0 主会话"
              : "L0 Main";
          Object.assign(rootCrumb.style, {
            height: "22px",
            padding: "0 8px",
            borderRadius: "999px",
            fontSize: "11px",
            fontWeight: isRootCurrent ? "600" : "500",
            cursor: "pointer",
            backgroundColor: isRootCurrent ? tokens.surface2 : tokens.surface1,
            color: isRootCurrent ? tokens.foreground : tokens.foregroundMuted,
            border: `1px solid ${isRootCurrent ? tokens.accent : tokens.border}`,
          });
          rootCrumb.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (
              !openOrFocusSubagentOrRootTabInApp(
                {
                  workspaceId: tree.workspaceId,
                  parentAgentId: tree.agentId,
                  subagentId: null,
                },
                document,
                window,
              )
            ) {
              void openDrawer({
                agentId: tree.agentId,
                workspaceId: tree.workspaceId,
                conversationId: tree.rootConversationId,
                layoutMode: "docked-right",
              });
            }
          });
          breadcrumbWrap.appendChild(rootCrumb);

          for (const anc of lineageInfo.ancestorChain) {
            const sep = document.createElement("span");
            sep.textContent = "›";
            Object.assign(sep.style, {
              fontSize: "11px",
              color: tokens.foregroundMuted,
              fontWeight: "500",
            });
            breadcrumbWrap.appendChild(sep);

            const isAncCurrent = anc.conversationId === activeSub?.conversationId;
            const ancBtn = document.createElement("button");
            ancBtn.type = "button";
            ancBtn.setAttribute(
              "data-testid",
              `paseo-finder-breadcrumb-node-${anc.conversationId.slice(0, 8)}`,
            );
            ancBtn.setAttribute("aria-current", isAncCurrent ? "true" : "false");
            ancBtn.textContent = isAncCurrent
              ? `L${anc.depth} ${anc.subAgentType} · ${zh ? "当前" : "Current"}`
              : `L${anc.depth} ${anc.subAgentType}`;
            Object.assign(ancBtn.style, {
              height: "22px",
              padding: "0 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: isAncCurrent ? "600" : "500",
              cursor: "pointer",
              backgroundColor: isAncCurrent ? tokens.surface2 : tokens.surface1,
              color: isAncCurrent ? tokens.foreground : tokens.foregroundMuted,
              border: `1px solid ${isAncCurrent ? tokens.accent : tokens.border}`,
            });
            ancBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (
                !openOrFocusSubagentOrRootTabInApp(
                  {
                    workspaceId: tree.workspaceId,
                    parentAgentId: tree.agentId,
                    subagentId: anc.conversationId,
                  },
                  document,
                  window,
                )
              ) {
                void openDrawer({
                  agentId: tree.agentId,
                  workspaceId: tree.workspaceId,
                  conversationId: anc.conversationId,
                  layoutMode: "docked-right",
                });
              }
            });
            breadcrumbWrap.appendChild(ancBtn);
          }

          // When viewing a subagent (L1 or L2+), render explicit step-up button (`↖ 返回上一级`) right in the bar
          if (activeSub) {
            const stepUpBtn = document.createElement("button");
            stepUpBtn.type = "button";
            stepUpBtn.setAttribute("data-testid", "paseo-finder-step-up-parent");
            const parentSub = lineageInfo.immediateParentSubagent;
            stepUpBtn.textContent = parentSub
              ? zh
                ? `↖ 返回上一级 · L${parentSub.depth} ${parentSub.subAgentType}`
                : `↖ Up to L${parentSub.depth} ${parentSub.subAgentType}`
              : zh
                ? "↖ 返回 L0 主会话"
                : "↖ Up to L0 Main";
            Object.assign(stepUpBtn.style, {
              marginLeft: "4px",
              height: "22px",
              padding: "0 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
              backgroundColor: tokens.surface2,
              color: tokens.foreground,
              border: `1px solid ${tokens.border}`,
            });
            stepUpBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const targetSubId = parentSub ? parentSub.conversationId : null;
              if (
                !openOrFocusSubagentOrRootTabInApp(
                  {
                    workspaceId: tree.workspaceId,
                    parentAgentId: tree.agentId,
                    subagentId: targetSubId,
                  },
                  document,
                  window,
                )
              ) {
                void openDrawer({
                  agentId: tree.agentId,
                  workspaceId: tree.workspaceId,
                  conversationId: targetSubId ?? tree.rootConversationId,
                  layoutMode: "docked-right",
                });
              }
            });
            breadcrumbWrap.appendChild(stepUpBtn);
          }

          topRow.appendChild(breadcrumbWrap);
          bar.appendChild(topRow);

          // Row B: Single-Row Compact Subagent Track (Paseo ComposerTrackPill geometry)
          const pillsRow = document.createElement("div");
          pillsRow.setAttribute("data-testid", "paseo-finder-subagents-penetrated-pills");
          Object.assign(pillsRow.style, {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexWrap: "nowrap",
            overflowX: "auto",
            scrollbarWidth: "none",
          });

          const MAX_VISIBLE_SUBAGENT_PILLS = 2;
          const visibleSubagents =
            tree.flatSubagents.length <= MAX_VISIBLE_SUBAGENT_PILLS + 1
              ? tree.flatSubagents
              : tree.flatSubagents.slice(0, MAX_VISIBLE_SUBAGENT_PILLS);
          const overflowCount = Math.max(0, tree.flatSubagents.length - visibleSubagents.length);

          for (let idx = 0; idx < tree.flatSubagents.length; idx += 1) {
            const sub = tree.flatSubagents[idx]!;
            const isOverflowHidden =
              idx >= visibleSubagents.length && activeSub?.conversationId !== sub.conversationId;
            const sc = statusColors(sub.status, tokens);
            const isSubCurrent = activeSub?.conversationId === sub.conversationId;
            const parentSub =
              sub.depth >= 2
                ? tree.flatSubagents.find(
                    (p) =>
                      normalizeSubagentArchiveId(p.conversationId) ===
                      normalizeSubagentArchiveId(sub.parentConversationId),
                  )
                : null;

            const pill = document.createElement("button");
            pill.type = "button";
            pill.setAttribute(
              "data-testid",
              `paseo-finder-subagent-pill-${sub.conversationId.slice(0, 8)}`,
            );
            pill.setAttribute("data-depth", String(sub.depth));
            pill.setAttribute("aria-current", isSubCurrent ? "true" : "false");
            if (parentSub) {
              pill.setAttribute("data-parent-cid", parentSub.conversationId);
            }
            const finishedClock =
              sub.status !== "running" && sub.updatedAt
                ? formatConciseLocalFinishedTime(sub.updatedAt)
                : "";
            const stepsPart = zh ? `${sub.stepCount} 步` : `${sub.stepCount} steps`;
            const parentBadge = parentSub
              ? ` ↖ L${parentSub.depth} ${formatSubagentDisplayName(parentSub, null, 28)}`
              : "";
            const shortLabel = formatSubagentDisplayName(sub, parentSub, 26);
            const fullSubLabel = formatSubagentDisplayName(sub, null, 60);
            const baseTip = sub.updatedAt ? formatFullLocalFinishedTooltip(sub.updatedAt) : "";
            pill.title = zh
              ? `L${sub.depth} ${fullSubLabel}${parentBadge} · ${formatStatusLabel(sub.status, zh)} (${finishedClock ? `${stepsPart} · ${finishedClock}` : stepsPart}) — 点击切换标签页 (Shift+点击打开右侧面板)${baseTip ? ` · ${baseTip}` : ""}`
              : `L${sub.depth} ${fullSubLabel}${parentBadge} · ${formatStatusLabel(sub.status, zh)} (${finishedClock ? `${stepsPart} · ${finishedClock}` : stepsPart}) — Click to switch tab (Shift+Click opens Right Sidebar)${baseTip ? ` · ${baseTip}` : ""}`;
            Object.assign(pill.style, {
              display: isOverflowHidden ? "none" : "inline-flex",
              alignItems: "center",
              gap: "6px",
              height: "24px",
              padding: "0 9px",
              borderRadius: "999px",
              fontSize: "11.5px",
              lineHeight: "15px",
              fontWeight: isSubCurrent ? "600" : "500",
              cursor: "pointer",
              backgroundColor: isSubCurrent ? tokens.surface2 : tokens.surface1,
              color: isSubCurrent ? tokens.foreground : tokens.foregroundMuted,
              border: `1px solid ${isSubCurrent ? tokens.accent : tokens.border}`,
              whiteSpace: "nowrap",
              flexShrink: "0",
            });

            const dot = document.createElement("span");
            Object.assign(dot.style, {
              width: "6px",
              height: "6px",
              borderRadius: "999px",
              backgroundColor: sc.dot,
              flexShrink: "0",
            });
            pill.appendChild(dot);

            const txt = document.createElement("span");
            const isSwarmWorkerSub =
              (sub.subAgentType ?? "").trim().toLowerCase() === "swarm worker" &&
              Boolean((sub.role ?? "").trim());
            txt.textContent = isSwarmWorkerSub
              ? `@${(sub.role ?? "").trim().slice(0, 20)}`
              : `${sub.depth >= 2 ? "↳ " : ""}L${sub.depth} ${shortLabel}`;
            pill.appendChild(txt);

            pill.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (
                !ev.shiftKey &&
                openOrFocusSubagentOrRootTabInApp(
                  {
                    workspaceId: tree.workspaceId,
                    parentAgentId: tree.agentId,
                    subagentId: sub.conversationId,
                  },
                  document,
                  window,
                )
              ) {
                return;
              }
              void openDrawer({
                agentId: tree.agentId,
                workspaceId: tree.workspaceId,
                conversationId: sub.conversationId,
                layoutMode: "docked-right",
              });
            });
            pillsRow.appendChild(pill);
          }

          if (overflowCount > 0) {
            const moreBtn = document.createElement("button");
            moreBtn.type = "button";
            moreBtn.setAttribute("data-testid", "paseo-finder-subagent-pill-more");
            moreBtn.textContent = zh ? `+${overflowCount} 更多` : `+${overflowCount} more`;
            moreBtn.title = zh
              ? `点击展开全部 ${tree.flatSubagents.length} 个子会话详情 (⌘⇧B)`
              : `Click to inspect all ${tree.flatSubagents.length} subagents (⌘⇧B)`;
            Object.assign(moreBtn.style, {
              display: "inline-flex",
              alignItems: "center",
              height: "24px",
              padding: "0 9px",
              borderRadius: "999px",
              fontSize: "11.5px",
              fontWeight: "500",
              cursor: "pointer",
              backgroundColor: tokens.surface1,
              color: tokens.foregroundMuted,
              border: `1px solid ${tokens.border}`,
              whiteSpace: "nowrap",
              flexShrink: "0",
            });
            moreBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              void openDrawer({
                agentId: tree.agentId,
                workspaceId: tree.workspaceId,
                conversationId: activeSub?.conversationId ?? undefined,
                layoutMode: "docked-right",
              });
            });
            pillsRow.appendChild(moreBtn);
          }

          const rightControls = document.createElement("div");
          Object.assign(rightControls.style, {
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            marginLeft: "auto",
            flexShrink: "0",
          });

          const hasSwarmWorkers = tree.flatSubagents.some(
            (s) => (s.subAgentType ?? "").trim().toLowerCase() === "swarm worker",
          );
          if (hasSwarmWorkers) {
            const swarmBoardBtn = document.createElement("button");
            swarmBoardBtn.type = "button";
            swarmBoardBtn.setAttribute("data-testid", "paseo-finder-open-swarm-board");
            swarmBoardBtn.textContent = zh ? "Swarm 看板" : "Swarm Board";
            swarmBoardBtn.title = zh
              ? "打开此会话的原生 Antigravity Swarm 实时看板 (Board · Members · Graph · Hive)"
              : "Open native Antigravity Swarm Board for this session";
            Object.assign(swarmBoardBtn.style, {
              display: "inline-flex",
              alignItems: "center",
              height: "24px",
              padding: "0 9px",
              borderRadius: "999px",
              fontSize: "11.5px",
              fontWeight: "600",
              cursor: "pointer",
              backgroundColor: tokens.surface2,
              color: tokens.foreground,
              border: `1px solid ${tokens.border}`,
            });
            swarmBoardBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              requestOpenSwarmWorkspacePanel({
                tab: "swarm",
                conversationId: tree.rootConversationId,
                workspaceId: tree.workspaceId,
              });
            });
            rightControls.appendChild(swarmBoardBtn);
          }

          if (allDone && !activeSub) {
            const archiveBtn = document.createElement("button");
            archiveBtn.type = "button";
            archiveBtn.setAttribute("data-testid", "paseo-finder-archive-finished-subagents");
            archiveBtn.textContent = zh ? "归档" : "Archive";
            archiveBtn.title = zh
              ? "将已完成的子会话归档收起，不再在输入框上方占用空间"
              : "Archive finished subagents and hide this bar above the composer";
            Object.assign(archiveBtn.style, {
              display: "inline-flex",
              alignItems: "center",
              height: "24px",
              padding: "0 9px",
              borderRadius: "999px",
              fontSize: "11.5px",
              fontWeight: "500",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: tokens.foregroundMuted,
              border: `1px solid ${tokens.border}`,
            });
            archiveBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              archiveFinishedSubagentsForTree(tree);
            });
            rightControls.appendChild(archiveBtn);
          }

          const openTreeBtn = document.createElement("button");
          openTreeBtn.type = "button";
          openTreeBtn.setAttribute("data-testid", "paseo-finder-open-subagents-sidebar");
          openTreeBtn.textContent = zh ? "侧边栏" : "Inspector";
          openTreeBtn.title = zh
            ? "展开右侧子会话与定时器树侧边栏 (⌘⇧B)"
            : "Open Right-Docked Subagent & Timer Sidebar (⌘⇧B)";
          Object.assign(openTreeBtn.style, {
            display: "inline-flex",
            alignItems: "center",
            height: "24px",
            padding: "0 9px",
            borderRadius: "999px",
            fontSize: "11.5px",
            fontWeight: "500",
            cursor: "pointer",
            backgroundColor: tokens.surface1,
            color: tokens.foregroundMuted,
            border: `1px solid ${tokens.border}`,
            flexShrink: "0",
          });
          openTreeBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void openDrawer({
              agentId: tree.agentId,
              workspaceId: tree.workspaceId,
              conversationId: activeSub?.conversationId ?? undefined,
              layoutMode: "docked-right",
            });
          });
          rightControls.appendChild(openTreeBtn);

          pillsRow.appendChild(rightControls);
          bar.appendChild(pillsRow);
        }
      }
    }

    // 3. Decorate inline `[data-testid="tool-call-badge"]` rows for DeepCoder, DeepInvestigator, Timers, Tasks, etc.
    const badges = document.querySelectorAll<HTMLElement>('[data-testid="tool-call-badge"]');
    let subCallOccurrenceIdx = 0;
    const contextDepth = activeSub ? activeSub.depth + 1 : 1;
    const contextSubagents = (tree?.flatSubagents ?? []).filter((s) =>
      activeSub
        ? normalizeSubagentArchiveId(s.parentConversationId) ===
          normalizeSubagentArchiveId(activeSub.conversationId)
        : s.depth === 1,
    );

    for (let i = 0; i < badges.length; i += 1) {
      const badge = badges[i];
      if (!badge) continue;
      // Exclude our own injected chip text when classifying
      const existingChip = badge.querySelector<HTMLElement>(
        '[data-testid="paseo-finder-inline-subagent-chip"]',
      );
      const rawFullText = (badge.textContent ?? "").trim();
      const chipText = (existingChip?.textContent ?? "").trim();
      const baseText =
        chipText && rawFullText.endsWith(chipText)
          ? rawFullText.slice(0, rawFullText.length - chipText.length).trim()
          : rawFullText;

      const classified = classifyToolCallBadgeText(baseText, tree);
      if (!classified.kind) {
        continue;
      }
      // When the session has no subagents, do not decorate generic timer/task/message badges
      if (!hasSubagents && classified.kind !== "subagent") {
        existingChip?.remove();
        badge.removeAttribute("data-paseo-finder-subagent-kind");
        badge.removeAttribute("data-paseo-finder-subagent-cid");
        continue;
      }

      let matchedSub: FlatSubagentNode | null = null;
      if (classified.kind === "subagent") {
        matchedSub =
          contextSubagents[subCallOccurrenceIdx] ??
          tree?.flatSubagents.find(
            (s) =>
              s.depth === contextDepth &&
              s.subAgentType.toLowerCase() === classified.subagentName,
          ) ??
          tree?.flatSubagents.find(
            (s) => s.subAgentType.toLowerCase() === classified.subagentName,
          ) ??
          tree?.flatSubagents[0] ??
          null;
        subCallOccurrenceIdx += 1;
      } else {
        matchedSub = activeSub ?? tree?.flatSubagents[0] ?? null;
      }

      badge.style.cursor = "pointer";
      badge.setAttribute("data-paseo-finder-subagent-kind", classified.kind);
      if (matchedSub) {
        badge.setAttribute("data-paseo-finder-subagent-cid", matchedSub.conversationId);
        // Deduplicate inline secondary summary text (`L1 DeepInvestigator · Role [Done · 16 steps] — Role...`)
        const secLeaves = Array.from(badge.querySelectorAll<HTMLElement>("div, span")).filter(
          (el) =>
            el.children.length === 0 &&
            !el.closest('[data-testid="paseo-finder-inline-subagent-chip"]') &&
            (el.textContent ?? "").trim().length > 0,
        );
        if (secLeaves.length >= 2) {
          const secEl = secLeaves[secLeaves.length - 1]!;
          const rawSec =
            secEl.getAttribute("data-vec-orig-sec") ?? (secEl.textContent ?? "").trim();
          if (!secEl.hasAttribute("data-vec-orig-sec")) {
            secEl.setAttribute("data-vec-orig-sec", rawSec);
          }
          const cleanedSec = cleanSubagentSecondaryText(
            rawSec,
            matchedSub.subAgentType,
            matchedSub.role,
            matchedSub.depth,
          );
          if ((secEl.textContent ?? "") !== cleanedSec) {
            secEl.textContent = cleanedSec;
          }
        }
      }

      const directNestedChildren =
        matchedSub && tree
          ? tree.flatSubagents.filter(
              (c) =>
                normalizeSubagentArchiveId(c.parentConversationId) ===
                normalizeSubagentArchiveId(matchedSub.conversationId),
            )
          : [];
      const nestedChildrenSig = directNestedChildren
        .map((c) => `${c.conversationId.slice(0, 8)}:${c.status}:${c.stepCount}`)
        .join(",");

      const chipSig = matchedSub
        ? `${classified.kind}:${matchedSub.conversationId}:${matchedSub.status}:${matchedSub.stepCount}:${matchedSub.nestedSubagentCount}:${nestedChildrenSig}:${zh}`
        : `generic:${classified.kind}:${classified.subagentName ?? ""}:${zh}`;

      if (existingChip && existingChip.getAttribute("data-sig") === chipSig) {
        continue;
      }
      existingChip?.remove();

      const chip = document.createElement("span");
      chip.setAttribute("data-testid", "paseo-finder-inline-subagent-chip");
      chip.setAttribute("data-sig", chipSig);

      if (matchedSub && classified.kind === "subagent") {
        const sc = statusColors(matchedSub.status, tokens);
        Object.assign(chip.style, {
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          flexWrap: "wrap",
          marginLeft: "6px",
          userSelect: "none",
        });

        const primaryPill = document.createElement("span");
        Object.assign(primaryPill.style, {
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          height: "20px",
          padding: "0 7px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: "500",
          backgroundColor: tokens.surface1,
          color: tokens.foregroundMuted,
          border: `1px solid ${tokens.border}`,
          cursor: "pointer",
        });
        const pDot = document.createElement("span");
        Object.assign(pDot.style, {
          width: "5px",
          height: "5px",
          borderRadius: "999px",
          backgroundColor: sc.dot,
          flexShrink: "0",
        });
        primaryPill.appendChild(pDot);
        const pTxt = document.createElement("span");
        pTxt.textContent = `${formatStatusLabel(matchedSub.status, zh)} · ${
          zh ? `${matchedSub.stepCount} 步` : `${matchedSub.stepCount} steps`
        } ↗`;
        primaryPill.appendChild(pTxt);
        chip.appendChild(primaryPill);

        // Penetrated nested child chips (`↳ L2 WorkerL0`) right on the parent's tool_call row
        for (const nestedChild of directNestedChildren) {
          const nsc = statusColors(nestedChild.status, tokens);
          const nestedShort = nestedChild.subAgentType.startsWith(matchedSub.subAgentType)
            ? nestedChild.subAgentType.slice(matchedSub.subAgentType.length).replace(/^[-_\s]+/, "") ||
              nestedChild.subAgentType
            : nestedChild.subAgentType;
          const nestedBtn = document.createElement("button");
          nestedBtn.type = "button";
          nestedBtn.setAttribute(
            "data-testid",
            `paseo-finder-inline-nested-chip-${nestedChild.conversationId.slice(0, 8)}`,
          );
          nestedBtn.setAttribute("data-nested-subagent-cid", nestedChild.conversationId);
          nestedBtn.title = `L${nestedChild.depth} ${nestedChild.subAgentType} · ${formatStatusLabel(
            nestedChild.status,
            zh,
          )} (${nestedChild.stepCount} steps)`;
          Object.assign(nestedBtn.style, {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            height: "20px",
            padding: "0 7px",
            borderRadius: "999px",
            fontSize: "11px",
            fontWeight: "500",
            backgroundColor: tokens.surface1,
            color: tokens.foregroundMuted,
            border: `1px solid ${tokens.border}`,
            cursor: "pointer",
          });
          const nDot = document.createElement("span");
          Object.assign(nDot.style, {
            width: "5px",
            height: "5px",
            borderRadius: "999px",
            backgroundColor: nsc.dot,
            flexShrink: "0",
          });
          nestedBtn.appendChild(nDot);
          const nTxt = document.createElement("span");
          nTxt.textContent = `↳ L${nestedChild.depth} ${nestedShort} ↗`;
          nestedBtn.appendChild(nTxt);
          chip.appendChild(nestedBtn);
        }
      } else {
        chip.textContent = zh ? "侧边栏 ↗" : "Inspector ↗";
        Object.assign(chip.style, {
          display: "inline-flex",
          alignItems: "center",
          marginLeft: "6px",
          height: "20px",
          padding: "0 7px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: "500",
          backgroundColor: tokens.surface1,
          color: tokens.foregroundMuted,
          border: `1px solid ${tokens.border}`,
          cursor: "pointer",
          userSelect: "none",
        });
      }

      badge.appendChild(chip);
    }

    // 4. Decorate `<a href="conversation://<cid>">` Markdown links and inline subagent `Role` mentions in assistant prose
    decorateConversationLinksAndSubagentMentionsInDom(tree, document, zh);
  };

  // Document-level capture-phase click listener so clicking:
  // 0. `[data-testid="parent-agent-callout-open"]` inside L2+ subagent jumps step-by-step (`Subagent 2 -> Subagent 1 -> Main Agent`)!
  // 1. Any penetrated nested chip (`[data-nested-subagent-cid]`) jumps directly to that L2/L3 subagent tab!
  // 2. Any inline `conversationId: <uuid>` code span or `[data-testid="tool-call-badge"]` opens the subagent tab or Right-Docked Sidebar!
  const onDocumentClickCapture = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (activeDrawerOverlayEl && activeDrawerOverlayEl.contains(target)) {
      return;
    }

    const scope = resolveActiveScope();
    const curTree = getCachedTreeForScope(scope);

    // 0. Intercept Paseo's `[data-testid="parent-agent-callout-open"]` (`↩ Open parent`) when viewing an L2+ subagent
    // so clicking it jumps from `Subagent 2 (L2)` -> `Subagent 1 (L1)` instead of skipping straight to `Main Agent (L0)`!
    const calloutOpenBtn = target.closest<HTMLElement>(
      '[data-testid="parent-agent-callout-open"]',
    );
    if (calloutOpenBtn && calloutOpenBtn.getAttribute("data-vec-bypass-intercept") !== "1") {
      const explicitParentSubCid = calloutOpenBtn.getAttribute("data-vec-parent-subagent-cid");
      const activeSub = resolveActiveSubagentNodeFromDom(curTree, document, window);
      const lineage = buildSubagentLineageChain(
        curTree,
        activeSub?.conversationId ?? null,
      );
      const targetParentSubCid =
        explicitParentSubCid || lineage.immediateParentSubagent?.conversationId || null;
      const parentAgentId =
        calloutOpenBtn.getAttribute("data-vec-parent-agent-id") ||
        curTree?.agentId ||
        scope.agentId ||
        "";
      const workspaceId =
        calloutOpenBtn.getAttribute("data-vec-workspace-id") ||
        curTree?.workspaceId ||
        scope.workspaceId ||
        null;

      if (targetParentSubCid && parentAgentId) {
        ev.preventDefault();
        ev.stopPropagation();
        if (
          !openOrFocusSubagentOrRootTabInApp(
            {
              workspaceId,
              parentAgentId,
              subagentId: targetParentSubCid,
            },
            document,
            window,
          )
        ) {
          void openDrawer({
            agentId: parentAgentId,
            workspaceId,
            conversationId: targetParentSubCid,
            layoutMode: "docked-right",
          });
        }
        return;
      }
    }

    // 0b. Check if clicking a penetrated nested child chip (`[data-nested-subagent-cid]`) inside a tool_call row
    const nestedChipBtn = target.closest<HTMLElement>("[data-nested-subagent-cid]");
    if (nestedChipBtn) {
      const nestedCid = nestedChipBtn.getAttribute("data-nested-subagent-cid");
      if (nestedCid) {
        ev.preventDefault();
        ev.stopPropagation();
        const parentAgentId = curTree?.agentId ?? scope.agentId ?? "";
        const workspaceId = curTree?.workspaceId ?? scope.workspaceId ?? null;
        if (
          !ev.shiftKey &&
          parentAgentId &&
          openOrFocusSubagentOrRootTabInApp(
            {
              workspaceId,
              parentAgentId,
              subagentId: nestedCid,
            },
            document,
            window,
          )
        ) {
          return;
        }
        void openDrawer({
          agentId: parentAgentId || null,
          workspaceId,
          conversationId: nestedCid,
          layoutMode: "docked-right",
        });
        return;
      }
    }

    // 0c. Check if clicking a `[label](conversation://<cid>)` Markdown link or decorated inline subagent `Role` mention
    const convOrRoleEl = target.closest<HTMLElement>(
      'a[href^="conversation://"], a[href*="conversation://"], [data-vec-subagent-cid], [data-vec-conversation-cid]',
    );
    if (convOrRoleEl) {
      const attrSubCid = convOrRoleEl.getAttribute("data-vec-subagent-cid")?.trim() || "";
      const attrConvCid = convOrRoleEl.getAttribute("data-vec-conversation-cid")?.trim() || "";
      const hrefVal = convOrRoleEl.getAttribute("href")?.trim() || "";
      const hrefMatch = hrefVal.match(/conversation:\/\/([A-Za-z0-9-]+)/i);
      const rawCid = attrSubCid || attrConvCid || hrefMatch?.[1] || "";

      if (rawCid) {
        ev.preventDefault();
        ev.stopPropagation();

        const matchedSub =
          curTree?.flatSubagents.find(
            (s) =>
              s.conversationId.toLowerCase() === rawCid.toLowerCase() ||
              s.conversationId.toLowerCase().startsWith(rawCid.toLowerCase()),
          ) ?? null;
        const targetCid = matchedSub?.conversationId ?? rawCid;

        if (!matchedSub) {
          const refNode = resolveSessionReference(targetCid);
          if (refNode) {
            navigateToLineageNode(refNode, document, window);
            return;
          }
        }

        const parentAgentId = curTree?.agentId ?? scope.agentId ?? "";
        const workspaceId = curTree?.workspaceId ?? scope.workspaceId ?? null;
        if (
          (ev.altKey || ev.metaKey || ev.ctrlKey) &&
          parentAgentId &&
          openOrFocusSubagentOrRootTabInApp(
            {
              workspaceId,
              parentAgentId,
              subagentId: targetCid,
            },
            document,
            window,
          )
        ) {
          return;
        }

        void openDrawer({
          agentId: parentAgentId || null,
          workspaceId,
          conversationId: targetCid,
          layoutMode: "docked-right",
        });
        return;
      }
    }

    // 1. Check if clicking an inline `conversationId: <uuid>` code span or subagent UUID token in assistant text
    const codeEl = target.closest<HTMLElement>("code");
    if (codeEl && curTree && curTree.flatSubagents.length > 0) {
      const codeText = (codeEl.textContent ?? "").trim();
      const uuidMatch = codeText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        const matchedSub = curTree.flatSubagents.find(
          (s) => s.conversationId.toLowerCase() === uuidMatch[1].toLowerCase(),
        );
        if (matchedSub) {
          ev.preventDefault();
          ev.stopPropagation();
          void openDrawer({
            agentId: curTree.agentId,
            workspaceId: curTree.workspaceId,
            conversationId: matchedSub.conversationId,
            layoutMode: "docked-right",
          });
          return;
        }
      }
    }

    // 2. Check if clicking `[data-testid="tool-call-badge"]`
    const badge = target.closest<HTMLElement>('[data-testid="tool-call-badge"]');
    if (!badge) return;
    const existingChip = badge.querySelector<HTMLElement>(
      '[data-testid="paseo-finder-inline-subagent-chip"]',
    );
    const rawFullText = (badge.textContent ?? "").trim();
    const chipText = (existingChip?.textContent ?? "").trim();
    const baseText =
      chipText && rawFullText.endsWith(chipText)
        ? rawFullText.slice(0, rawFullText.length - chipText.length).trim()
        : rawFullText;

    const classified = classifyToolCallBadgeText(baseText, curTree);
    const hasActiveSubagents = Boolean(
      curTree && curTree.subagentSummary.total > 0 && curTree.flatSubagents.length > 0,
    );
    if (!classified.kind && !badge.getAttribute("data-paseo-finder-subagent-kind")) {
      return;
    }
    if (!hasActiveSubagents && classified.kind !== "subagent") {
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();

    const boundCid = badge.getAttribute("data-paseo-finder-subagent-cid");
    const targetSub =
      (boundCid
        ? curTree?.flatSubagents.find((s) => s.conversationId === boundCid)
        : null) ??
      (classified.subagentName
        ? curTree?.flatSubagents.find(
            (s) => s.subAgentType.toLowerCase() === classified.subagentName,
          )
        : null) ??
      curTree?.flatSubagents[0] ??
      null;

    if (ev.altKey && targetSub && tryClickNativeSubagentTrackRow(targetSub.conversationId)) {
      return;
    }

    const parentAgentId = curTree?.agentId ?? scope.agentId ?? "";
    const workspaceId = curTree?.workspaceId ?? scope.workspaceId ?? null;
    if (
      !ev.shiftKey &&
      targetSub &&
      parentAgentId &&
      openOrFocusSubagentOrRootTabInApp(
        {
          workspaceId,
          parentAgentId,
          subagentId: targetSub.conversationId,
        },
        document,
        window,
      )
    ) {
      return;
    }

    void openDrawer({
      agentId: parentAgentId || null,
      workspaceId,
      conversationId: targetSub?.conversationId ?? null,
      layoutMode: "docked-right",
    });
  };

  let initialPrefetchScheduled = false;
  const syncCurrentAgentSubagents = () => {
    if (!initialPrefetchScheduled) {
      initialPrefetchScheduled = true;
      setTimeout(() => {
        void prefetchAllWorkspaceSubagentTrees(false).then(() => {
          const latestScope = resolveActiveScope();
          decorateActiveAgentSubagentsDom(getCachedTreeForScope(latestScope));
        });
      }, 800);
    }
    const scope = resolveActiveScope();
    if (!scope.scopeKey) {
      lastScopeKey = null;
      decorateActiveAgentSubagentsDom(null);
      return;
    }
    const scopeChanged = lastScopeKey !== scope.scopeKey;
    lastScopeKey = scope.scopeKey;
    const cached = getCachedTreeForScope(scope);
    decorateActiveAgentSubagentsDom(cached);
    if (scopeChanged || (!cached && Boolean(document.querySelector('[data-testid="tool-call-badge"]')))) {
      void fetchScopeTree(scope, false, false).then((tree) => {
        const latestScope = resolveActiveScope();
        if (latestScope.scopeKey === scope.scopeKey) {
          decorateActiveAgentSubagentsDom(tree);
        }
      });
    }
  };

  const observer = new MutationObserver(() => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      syncCurrentAgentSubagents();
    });
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  let idleTicksSinceBatchPrefetch = 0;
  pollIntervalId = setInterval(() => {
    const scope = resolveActiveScope();
    const anySidebarWorkspaceRunning = Array.from(workspaceTreesByWsId.values()).some(
      (t) => t.subagentSummary.running > 0,
    );
    idleTicksSinceBatchPrefetch += 1;
    if (anySidebarWorkspaceRunning || idleTicksSinceBatchPrefetch >= 12) {
      idleTicksSinceBatchPrefetch = 0;
      void prefetchAllWorkspaceSubagentTrees(anySidebarWorkspaceRunning).then(() => {
        const latestScope = resolveActiveScope();
        decorateActiveAgentSubagentsDom(getCachedTreeForScope(latestScope));
      });
    }
    if (!scope.scopeKey) return;
    const cached = getCachedTreeForScope(scope);
    const hasFetchedScope = Boolean(
      treeCacheByKey.has(scope.scopeKey) ||
        (scope.workspaceId && treeCacheByKey.has(`ws:${scope.workspaceId}`)) ||
        (scope.agentId && treeCacheByKey.has(`ag:${scope.agentId}`)),
    );
    const hasSubagentBadgeInDom =
      Boolean(
        document.querySelector(
          '[data-testid="subagents-track-header"], [data-testid^="subagents-track-row-"]',
        ),
      ) ||
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tool-call-badge"]')).some(
        (el) => /subagent/i.test(el.textContent ?? ""),
      );
    const isRunningScope = Boolean(cached?.subagentSummary.running);
    if (isRunningScope || (hasSubagentBadgeInDom && !hasFetchedScope)) {
      void fetchScopeTree(scope, isRunningScope, false).then((tree) => {
        const latestScope = resolveActiveScope();
        if (latestScope.scopeKey === scope.scopeKey) {
          decorateActiveAgentSubagentsDom(tree);
        }
      });
      if (activeDrawerOverlayEl && activeDrawerRefreshFn && isRunningScope) {
        void activeDrawerRefreshFn();
      }
    }
  }, 3_000);

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && activeDrawerOverlayEl) {
      ev.preventDefault();
      ev.stopPropagation();
      closeDrawer();
      return;
    }
    // Cmd+Shift+B (Ctrl+Shift+B) toggles the Right-Docked Subagent Sidebar
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      ev.stopPropagation();
      if (activeDrawerOverlayEl) {
        closeDrawer();
      } else {
        const scope = resolveActiveScope();
        void openDrawer({
          agentId: scope.agentId,
          workspaceId: scope.workspaceId,
          layoutMode: "docked-right",
        });
      }
    }
  };

  document.addEventListener("click", onDocumentClickCapture, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("popstate", syncCurrentAgentSubagents, false);
  setTimeout(syncCurrentAgentSubagents, 80);

  return () => {
    externalOpenDrawerFn = null;
    closeDrawer();
    observer.disconnect();
    if (pollIntervalId) clearInterval(pollIntervalId);
    if (rafId !== null) window.cancelAnimationFrame(rafId);
    document.removeEventListener("click", onDocumentClickCapture, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("popstate", syncCurrentAgentSubagents, false);
  };
}
