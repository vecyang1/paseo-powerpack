/// <reference lib="dom" />
/**
 * Multi-Model Parallel Worktree Race — Paseo Desktop/Web Host-Native Chameleon UI.
 *
 * Lets the operator select 2..N Agent Profiles (or raw provider/model contenders)
 * with click / Shift+Click, preview exact Git worktree branches (dry-run), launch
 * one prompt in parallel across isolated worktrees, monitor live contender status
 * & git diff stats side by side, jump into any contender workspace, and pick a
 * winner while archiving the losing worktrees cleanly.
 *
 * Strictly obeys Paseo Powerpack invariants:
 * - Hermes-safe (`resolveExplicitWebWindow`, zero `for (const/let)` closures)
 * - 7-theme Host-Native Chameleon (`syncPaseoThemeCssVariables`)
 * - Single SSOT brand icons (`createModelBrandIconElement`, `resolveModelBrandStatusPip`)
 * - Popover & MutationObserver isolation (`mountPluginModalPopover`, `PLUGIN_INJECTED_ATTR`)
 * - Zero emoji, single-language `en` / `zh-CN` (`unslop --strict` clean)
 */
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { compareSessionBrands } from "../shared/model-brand-icons";
import type {
  RaceContenderSpec,
  RaceProfileOption,
  manageMultiModelRaceRpc,
} from "../shared/multi-model-race-contracts";
import {
  createModelBrandIconElement,
  type ModelBrandStatusPip,
} from "./model-brand-icon-web";
import {
  resolveActivePaseoTheme,
  syncPaseoThemeCssVariables,
} from "./theme-web";

const PLUGIN_INJECTED_ATTR = "data-paseo-finder-injected";
const NEW_WORKSPACE_SUBMIT_SELECTOR =
  '[data-testid="workspace-create-submit"], [data-testid="new-workspace-launch-submit"]';

function resolveExplicitWebWindow(explicit?: Window | null): Window | null {
  if (explicit === null) return null;
  if (explicit !== undefined) return explicit;
  if (
    typeof window !== "undefined" &&
    typeof (window as unknown as { document?: unknown }).document !== "undefined"
  ) {
    return window;
  }
  return null;
}

function mountPluginModalPopover(doc: Document, el: HTMLElement): void {
  el.setAttribute(PLUGIN_INJECTED_ATTR, "true");
  el.setAttribute("popover", "manual");
  doc.body.appendChild(el);
  try {
    (el as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    // fallback when popover API unavailable
  }
}

function unmountPluginModalPopover(el: HTMLElement): void {
  try {
    (el as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
  } catch {
    // ignore
  }
  el.remove();
}

function mapRaceStatusPip(status?: string): ModelBrandStatusPip {
  if (status === "running" || status === "working") return "running";
  if (status === "failed" || status === "error") return "error";
  if (status === "idle" || status === "done") return "finished";
  return "none";
}

export type ManageMultiModelRaceFn = (
  input: RpcInput<typeof manageMultiModelRaceRpc>,
) => Promise<RpcOutput<typeof manageMultiModelRaceRpc>>;

type RaceSnapshot = RpcOutput<typeof manageMultiModelRaceRpc>;

const OVERLAY_ID = "paseo-finder-multi-race-overlay";
const STYLE_ID = "paseo-finder-multi-race-style";
const NW_TRIGGER_ID = "paseo-finder-nw-race-trigger";
const GLOBAL_BRIDGE_KEY = "__paseoFinderMultiModelRace";

interface RaceModalOptions {
  call: ManageMultiModelRaceFn;
  getLocale?: () => string;
  showToast?: (message: string, opts?: { variant?: "info" | "success" | "error" }) => void;
  openWorkspace?: (workspaceId: string) => void;
  win?: Window | null;
}

interface OpenRaceModalParams {
  initialPrompt?: string;
  initialCwd?: string;
  initialWorkspaceId?: string;
  initialTab?: "launch" | "races";
}

function isZhLocale(win: Window, getLocale?: () => string): boolean {
  try {
    const loc = getLocale?.() || win.document?.documentElement?.getAttribute("lang") || win.navigator?.language || "";
    return loc.toLowerCase().startsWith("zh");
  } catch {
    return false;
  }
}

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute(PLUGIN_INJECTED_ATTR, "true");
  style.textContent = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#${OVERLAY_ID} * { box-sizing: border-box; }
.paseo-race-dialog {
  width: min(760px, 96vw);
  max-height: min(86vh, 780px);
  display: flex;
  flex-direction: column;
  background: var(--paseo-finder-surface0, #ffffff);
  color: var(--paseo-finder-fg, #1a1a1e);
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.paseo-race-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--paseo-finder-border, #e4e4e7);
  gap: 12px;
}
.paseo-race-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.paseo-race-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.paseo-race-tabs {
  display: inline-flex;
  background: var(--paseo-finder-surface2, #f4f4f5);
  padding: 2px;
  border-radius: 7px;
  gap: 2px;
}
.paseo-race-tab {
  border: none;
  background: transparent;
  color: var(--paseo-finder-muted, #71717a);
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.paseo-race-tab[data-active="true"] {
  background: var(--paseo-finder-surface0, #ffffff);
  color: var(--paseo-finder-fg, #1a1a1e);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.paseo-race-close {
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  background: transparent;
  color: var(--paseo-finder-muted, #71717a);
  border-radius: 6px;
  font-size: 12px;
  padding: 4px 9px;
  cursor: pointer;
}
.paseo-race-close:hover {
  color: var(--paseo-finder-fg, #1a1a1e);
  background: var(--paseo-finder-surface2, #f4f4f5);
}
.paseo-race-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
}
.paseo-race-field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.paseo-race-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 200px;
}
.paseo-race-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--paseo-finder-muted, #71717a);
}
.paseo-race-input, .paseo-race-select, .paseo-race-textarea {
  width: 100%;
  background: var(--paseo-finder-surface1, #fafafa);
  color: var(--paseo-finder-fg, #1a1a1e);
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
}
.paseo-race-textarea {
  min-height: 82px;
  resize: vertical;
  line-height: 1.45;
}
.paseo-race-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 8px;
}
.paseo-race-card {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  background: var(--paseo-finder-surface1, #fafafa);
  cursor: pointer;
  text-align: left;
  color: var(--paseo-finder-fg, #1a1a1e);
  transition: border-color 120ms ease, background 120ms ease;
}
.paseo-race-card[data-selected="true"] {
  border-color: var(--paseo-finder-primary, #18181b);
  background: var(--paseo-finder-surface2, #f4f4f5);
}
.paseo-race-card-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}
.paseo-race-card-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.paseo-race-card-sub {
  font-size: 11px;
  color: var(--paseo-finder-muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.paseo-race-check {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  flex: 0 0 auto;
}
.paseo-race-card[data-selected="true"] .paseo-race-check {
  background: var(--paseo-finder-primary, #18181b);
  border-color: var(--paseo-finder-primary, #18181b);
  color: var(--paseo-finder-surface0, #ffffff);
}
.paseo-race-box {
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  background: var(--paseo-finder-surface1, #fafafa);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.paseo-race-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--paseo-finder-border, #e4e4e7);
}
.paseo-race-row:first-child { border-top: none; padding-top: 0; }
.paseo-race-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--paseo-finder-surface2, #f4f4f5);
  color: var(--paseo-finder-muted, #71717a);
}
.paseo-race-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 16px;
  border-top: 1px solid var(--paseo-finder-border, #e4e4e7);
  gap: 10px;
}
.paseo-race-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.paseo-race-btn {
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  background: var(--paseo-finder-surface1, #fafafa);
  color: var(--paseo-finder-fg, #1a1a1e);
  border-radius: 7px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.paseo-race-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.paseo-race-btn-primary {
  background: var(--paseo-finder-primary, #18181b);
  border-color: var(--paseo-finder-primary, #18181b);
  color: var(--paseo-finder-surface0, #ffffff);
}
#${NW_TRIGGER_ID} {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  margin-left: 6px;
  border-radius: 7px;
  border: 1px solid var(--paseo-finder-border, #e4e4e7);
  background: var(--paseo-finder-surface1, #fafafa);
  color: var(--paseo-finder-fg, #1a1a1e);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  line-height: 1.2;
}
#${NW_TRIGGER_ID}:hover {
  background: var(--paseo-finder-surface2, #f4f4f5);
}
`;
  doc.head.appendChild(style);
}

function appendBrandIcon(
  doc: Document,
  win: Window,
  container: HTMLElement,
  provider: string,
  model: string | null,
  status?: string,
): void {
  const theme = resolveActivePaseoTheme(doc, win);
  const comparison = compareSessionBrands(
    { provider, model: model ?? undefined },
    { provider: "__race__", model: undefined },
  );
  const statusPip = status ? mapRaceStatusPip(status) : undefined;
  const el = createModelBrandIconElement({
    doc,
    comparison,
    mode: "always",
    theme,
    sizePx: 14,
    statusPip,
    alwaysEmphasize: true,
  });
  if (el) container.appendChild(el);
}

function buildContenderSpecFromProfile(p: RaceProfileOption): RaceContenderSpec {
  return {
    profileId: p.id,
    profile: p.name,
    provider: p.provider,
    model: p.model,
    thinking: p.thinking,
    mode: p.mode,
  };
}

export async function openMultiModelRaceModal(
  opts: RaceModalOptions,
  params: OpenRaceModalParams = {},
): Promise<void> {
  const win = resolveExplicitWebWindow(opts.win);
  if (!win || !win.document?.body) return;
  const doc = win.document;

  const existing = doc.getElementById(OVERLAY_ID);
  if (existing) {
    unmountPluginModalPopover(existing);
  }

  syncPaseoThemeCssVariables(doc, win);
  injectStyles(doc);
  const zh = isZhLocale(win, opts.getLocale);

  let activeTab: "launch" | "races" = params.initialTab ?? "launch";
  let snapshot: RaceSnapshot | null = null;
  let selectedKeys = new Set<string>();
  let customSpecs: RaceContenderSpec[] = [];
  let promptText = params.initialPrompt ?? "";
  let titleText = "";
  let cwdText = params.initialCwd ?? "";
  let isolation: "worktree" | "local" = "worktree";
  let baseRefText = "";
  let branchPrefixText = "race";
  let busy = false;
  let statusBanner = "";
  let statusError = false;

  const overlay = doc.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute(PLUGIN_INJECTED_ATTR, "true");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const dialog = doc.createElement("div");
  dialog.className = "paseo-race-dialog";
  overlay.appendChild(dialog);

  const close = () => {
    win.removeEventListener("keydown", onKeyDown, true);
    unmountPluginModalPopover(overlay);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  };
  win.addEventListener("keydown", onKeyDown, true);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  const collectSelectedContenders = (): RaceContenderSpec[] => {
    const out: RaceContenderSpec[] = [];
    const profiles = snapshot?.profiles ?? [];
    profiles.forEach((p) => {
      if (selectedKeys.has(p.id)) {
        out.push(buildContenderSpecFromProfile(p));
      }
    });
    customSpecs.forEach((c) => {
      const k = `custom:${c.provider}/${c.model ?? ""}:${c.thinking ?? ""}`;
      if (selectedKeys.has(k)) out.push(c);
    });
    return out;
  };

  const render = () => {
    dialog.innerHTML = "";
    const selectedContenders = collectSelectedContenders();
    const maxC = snapshot?.config.maxContenders ?? 6;

    // Header
    const header = doc.createElement("div");
    header.className = "paseo-race-header";
    const titleWrap = doc.createElement("div");
    titleWrap.className = "paseo-race-title-wrap";
    const h = doc.createElement("h2");
    h.className = "paseo-race-title";
    h.textContent = zh ? "多模型并行 Worktree 赛马" : "Multi-Model Parallel Race";
    titleWrap.appendChild(h);

    const tabs = doc.createElement("div");
    tabs.className = "paseo-race-tabs";
    const tabDefs: Array<{ id: "launch" | "races"; label: string }> = [
      { id: "launch", label: zh ? "并行发起" : "Launch" },
      {
        id: "races",
        label: zh
          ? `进行中与记录 (${snapshot?.races.length ?? 0})`
          : `Races (${snapshot?.races.length ?? 0})`,
      },
    ];
    tabDefs.forEach((t) => {
      const tb = doc.createElement("button");
      tb.type = "button";
      tb.className = "paseo-race-tab";
      tb.setAttribute("data-active", String(activeTab === t.id));
      tb.textContent = t.label;
      tb.addEventListener("click", () => {
        activeTab = t.id;
        render();
      });
      tabs.appendChild(tb);
    });
    titleWrap.appendChild(tabs);
    header.appendChild(titleWrap);

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "paseo-race-close";
    closeBtn.textContent = zh ? "关闭" : "Close";
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = doc.createElement("div");
    body.className = "paseo-race-body";

    if (statusBanner) {
      const msg = doc.createElement("div");
      msg.className = "paseo-race-box";
      msg.style.fontSize = "12px";
      if (statusError) {
        msg.style.borderColor = "var(--paseo-finder-danger, #dc2626)";
      }
      msg.textContent = statusBanner;
      body.appendChild(msg);
    }

    if (activeTab === "launch") {
      // Prompt
      const pField = doc.createElement("div");
      pField.className = "paseo-race-field";
      const pLbl = doc.createElement("label");
      pLbl.className = "paseo-race-label";
      pLbl.textContent = zh ? "统一任务提示词（同时发给每个选中模型）" : "Shared Prompt (sent identically to each contender)";
      const ta = doc.createElement("textarea");
      ta.className = "paseo-race-textarea";
      ta.value = promptText;
      ta.placeholder = zh ? "描述要并行实现的任务，每个模型将在独立 Git Worktree 中各自实现..." : "Describe the task to run in parallel across isolated worktrees...";
      ta.addEventListener("input", () => {
        promptText = ta.value;
      });
      pField.appendChild(pLbl);
      pField.appendChild(ta);
      body.appendChild(pField);

      // Project & Isolation Row
      const row = doc.createElement("div");
      row.className = "paseo-race-field-row";

      const projField = doc.createElement("div");
      projField.className = "paseo-race-field";
      const projLbl = doc.createElement("label");
      projLbl.className = "paseo-race-label";
      projLbl.textContent = zh ? "目标项目目录" : "Project Directory";
      if ((snapshot?.projects.length ?? 0) > 0) {
        const sel = doc.createElement("select");
        sel.className = "paseo-race-select";
        const projects = snapshot?.projects ?? [];
        let matched = false;
        projects.forEach((proj) => {
          const o = doc.createElement("option");
          o.value = proj.cwd;
          o.textContent = `${proj.name} (${proj.isGit ? (proj.defaultBaseRef || "git") : "local"})`;
          if (proj.cwd === cwdText) {
            o.selected = true;
            matched = true;
          }
          sel.appendChild(o);
        });
        if (!matched && cwdText) {
          const customOpt = doc.createElement("option");
          customOpt.value = cwdText;
          customOpt.textContent = cwdText;
          customOpt.selected = true;
          sel.insertBefore(customOpt, sel.firstChild);
        }
        sel.addEventListener("change", () => {
          cwdText = sel.value;
          void refreshStatus();
        });
        projField.appendChild(projLbl);
        projField.appendChild(sel);
      } else {
        const inp = doc.createElement("input");
        inp.className = "paseo-race-input";
        inp.value = cwdText;
        inp.addEventListener("input", () => {
          cwdText = inp.value;
        });
        projField.appendChild(projLbl);
        projField.appendChild(inp);
      }
      row.appendChild(projField);

      const isoField = doc.createElement("div");
      isoField.className = "paseo-race-field";
      isoField.style.flex = "0 1 150px";
      const isoLbl = doc.createElement("label");
      isoLbl.className = "paseo-race-label";
      isoLbl.textContent = zh ? "隔离方式" : "Isolation";
      const isoSel = doc.createElement("select");
      isoSel.className = "paseo-race-select";
      const isoOpts: Array<{ v: "worktree" | "local"; l: string }> = [
        { v: "worktree", l: zh ? "独立 Worktree" : "Git Worktree" },
        { v: "local", l: zh ? "本地目录" : "Local" },
      ];
      isoOpts.forEach((io) => {
        const o = doc.createElement("option");
        o.value = io.v;
        o.textContent = io.l;
        if (isolation === io.v) o.selected = true;
        isoSel.appendChild(o);
      });
      isoSel.addEventListener("change", () => {
        isolation = isoSel.value === "local" ? "local" : "worktree";
        render();
      });
      isoField.appendChild(isoLbl);
      isoField.appendChild(isoSel);
      row.appendChild(isoField);

      const baseField = doc.createElement("div");
      baseField.className = "paseo-race-field";
      baseField.style.flex = "0 1 150px";
      const baseLbl = doc.createElement("label");
      baseLbl.className = "paseo-race-label";
      baseLbl.textContent = zh ? "基线分支" : "Base Ref";
      const baseInp = doc.createElement("input");
      baseInp.className = "paseo-race-input";
      baseInp.value = baseRefText || snapshot?.gitContext?.defaultBaseRef || "";
      baseInp.placeholder = snapshot?.gitContext?.defaultBaseRef || "origin/main";
      baseInp.disabled = isolation !== "worktree";
      baseInp.addEventListener("input", () => {
        baseRefText = baseInp.value;
      });
      baseField.appendChild(baseLbl);
      baseField.appendChild(baseInp);
      row.appendChild(baseField);

      body.appendChild(row);

      // Optional title + branch prefix
      const row2 = doc.createElement("div");
      row2.className = "paseo-race-field-row";
      const tField = doc.createElement("div");
      tField.className = "paseo-race-field";
      const tLbl = doc.createElement("label");
      tLbl.className = "paseo-race-label";
      tLbl.textContent = zh ? "短标题（可选，用于分支与工作区命名）" : "Short Title (optional)";
      const tInp = doc.createElement("input");
      tInp.className = "paseo-race-input";
      tInp.value = titleText;
      tInp.placeholder = zh ? "留空则自动取提示词首行" : "Auto-derived from prompt if blank";
      tInp.addEventListener("input", () => {
        titleText = tInp.value;
      });
      tField.appendChild(tLbl);
      tField.appendChild(tInp);
      row2.appendChild(tField);

      const prefField = doc.createElement("div");
      prefField.className = "paseo-race-field";
      prefField.style.flex = "0 1 150px";
      const prefLbl = doc.createElement("label");
      prefLbl.className = "paseo-race-label";
      prefLbl.textContent = zh ? "分支前缀" : "Branch Prefix";
      const prefInp = doc.createElement("input");
      prefInp.className = "paseo-race-input";
      prefInp.value = branchPrefixText;
      prefInp.disabled = isolation !== "worktree";
      prefInp.addEventListener("input", () => {
        branchPrefixText = prefInp.value;
      });
      prefField.appendChild(prefLbl);
      prefField.appendChild(prefInp);
      row2.appendChild(prefField);
      body.appendChild(row2);

      // Multi-Select Profiles Grid
      const gridHead = doc.createElement("div");
      gridHead.style.display = "flex";
      gridHead.style.justifyContent = "space-between";
      gridHead.style.alignItems = "center";
      const gLbl = doc.createElement("span");
      gLbl.className = "paseo-race-label";
      gLbl.textContent = zh
        ? `选择参赛模型/配置（已选 ${selectedContenders.length}/${maxC}，至少 2 个）`
        : `Select Contenders (${selectedContenders.length}/${maxC} selected, min 2)`;
      gridHead.appendChild(gLbl);
      const gitPill = doc.createElement("span");
      gitPill.className = "paseo-race-pill";
      gitPill.textContent = snapshot?.gitContext?.isGit
        ? (zh ? `Git 仓库 · ${snapshot.gitContext.defaultBaseRef ?? "HEAD"}` : `Git repo · ${snapshot.gitContext.defaultBaseRef ?? "HEAD"}`)
        : (zh ? "非 Git 目录 · 自动降级本地隔离" : "Non-git folder · Local isolation");
      gridHead.appendChild(gitPill);
      body.appendChild(gridHead);

      const grid = doc.createElement("div");
      grid.className = "paseo-race-grid";
      const profiles = snapshot?.profiles ?? [];
      profiles.forEach((prof) => {
        const isSel = selectedKeys.has(prof.id);
        const card = doc.createElement("button");
        card.type = "button";
        card.className = "paseo-race-card";
        card.setAttribute("data-selected", String(isSel));
        card.setAttribute("data-race-profile-id", prof.id);

const CHECK_SVG_MARKUP =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2.5 6.5 5 9 9.5 3.5"/></svg>';

        const chk = doc.createElement("span");
        chk.className = "paseo-race-check";
        if (isSel) chk.innerHTML = CHECK_SVG_MARKUP;
        card.appendChild(chk);

        appendBrandIcon(doc, win, card, prof.provider, prof.model);

        const meta = doc.createElement("div");
        meta.className = "paseo-race-card-meta";
        const nm = doc.createElement("span");
        nm.className = "paseo-race-card-name";
        nm.textContent = prof.name;
        const sb = doc.createElement("span");
        sb.className = "paseo-race-card-sub";
        sb.textContent = [prof.provider, prof.model, prof.thinking].filter(Boolean).join(" · ");
        meta.appendChild(nm);
        meta.appendChild(sb);
        card.appendChild(meta);

        card.addEventListener("click", () => {
          if (selectedKeys.has(prof.id)) {
            selectedKeys.delete(prof.id);
          } else if (selectedKeys.size < maxC) {
            selectedKeys.add(prof.id);
          }
          render();
        });
        grid.appendChild(card);
      });
      customSpecs.forEach((spec) => {
        const k = `custom:${spec.provider}/${spec.model ?? ""}:${spec.thinking ?? ""}`;
        const isSel = selectedKeys.has(k);
        const card = doc.createElement("button");
        card.type = "button";
        card.className = "paseo-race-card";
        card.setAttribute("data-selected", String(isSel));
const CHECK_SVG_MARKUP =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2.5 6.5 5 9 9.5 3.5"/></svg>';

        const chk = doc.createElement("span");
        chk.className = "paseo-race-check";
        if (isSel) chk.innerHTML = CHECK_SVG_MARKUP;
        card.appendChild(chk);
        appendBrandIcon(doc, win, card, spec.provider, spec.model ?? null);
        const meta = doc.createElement("div");
        meta.className = "paseo-race-card-meta";
        const nm = doc.createElement("span");
        nm.className = "paseo-race-card-name";
        nm.textContent = spec.profile;
        const sb = doc.createElement("span");
        sb.className = "paseo-race-card-sub";
        sb.textContent = [spec.provider, spec.model, spec.thinking].filter(Boolean).join(" · ");
        meta.appendChild(nm);
        meta.appendChild(sb);
        card.appendChild(meta);
        card.addEventListener("click", () => {
          if (selectedKeys.has(k)) selectedKeys.delete(k);
          else if (selectedKeys.size < maxC) selectedKeys.add(k);
          render();
        });
        grid.appendChild(card);
      });
      body.appendChild(grid);

      // Quick raw provider/model adder
      const addRow = doc.createElement("div");
      addRow.className = "paseo-race-field-row";
      const rawInp = doc.createElement("input");
      rawInp.className = "paseo-race-input";
      rawInp.style.flex = "1 1 240px";
      rawInp.placeholder = zh ? "添加自定义模型，如 codex/gpt-6-luna:high" : "Add custom spec, e.g. codex/gpt-6-luna:high";
      const addBtn = doc.createElement("button");
      addBtn.type = "button";
      addBtn.className = "paseo-race-btn";
      addBtn.textContent = zh ? "添加模型" : "Add Model";
      addBtn.addEventListener("click", () => {
        const raw = rawInp.value.trim();
        if (!raw || !raw.includes("/")) return;
        const slashIdx = raw.indexOf("/");
        const provider = raw.slice(0, slashIdx).trim();
        const rest = raw.slice(slashIdx + 1).trim();
        const colonIdx = rest.lastIndexOf(":");
        const model = (colonIdx > 0 ? rest.slice(0, colonIdx) : rest).trim();
        const thinking = colonIdx > 0 ? rest.slice(colonIdx + 1).trim() || null : null;
        if (!provider || !model) return;
        const spec: RaceContenderSpec = {
          profile: thinking ? `${provider}/${model} (${thinking})` : `${provider}/${model}`,
          provider,
          model,
          thinking,
          mode: null,
        };
        const key = `custom:${provider}/${model}:${thinking ?? ""}`;
        if (!customSpecs.some((c) => `custom:${c.provider}/${c.model ?? ""}:${c.thinking ?? ""}` === key)) {
          customSpecs.push(spec);
        }
        if (selectedKeys.size < maxC) selectedKeys.add(key);
        render();
      });
      addRow.appendChild(rawInp);
      addRow.appendChild(addBtn);
      body.appendChild(addRow);

      // Dry-Run Preview Box
      if (snapshot?.preview) {
        const pBox = doc.createElement("div");
        pBox.className = "paseo-race-box";
        const pHead = doc.createElement("div");
        pHead.style.fontSize = "12px";
        pHead.style.fontWeight = "600";
        pHead.textContent = zh
          ? `预演结果 · ${snapshot.preview.isolation} · ${snapshot.preview.contenders.length} 个隔离线程`
          : `Dry-Run Preview · ${snapshot.preview.isolation} · ${snapshot.preview.contenders.length} threads`;
        pBox.appendChild(pHead);
        snapshot.preview.contenders.forEach((c) => {
          const r = doc.createElement("div");
          r.className = "paseo-race-row";
          const left = doc.createElement("span");
          left.textContent = `${c.slotId} · ${c.profile}`;
          const right = doc.createElement("span");
          right.className = "paseo-race-pill";
          right.textContent = c.branch || c.workspaceTitle;
          r.appendChild(left);
          r.appendChild(right);
          pBox.appendChild(r);
        });
        body.appendChild(pBox);
      }
    } else {
      // Races Tab
      const races = snapshot?.races ?? [];
      if (races.length === 0) {
        const empty = doc.createElement("div");
        empty.className = "paseo-race-box";
        empty.style.fontSize = "12px";
        empty.textContent = zh
          ? "暂无多模型赛马记录。切换到「并行发起」选择 2 个以上模型即可启动独立 Worktree 并行实现。"
          : "No multi-model races recorded yet. Switch to Launch and select 2+ models to start isolated worktree runs.";
        body.appendChild(empty);
      } else {
        races.forEach((race) => {
          const box = doc.createElement("div");
          box.className = "paseo-race-box";
          const head = doc.createElement("div");
          head.style.display = "flex";
          head.style.justifyContent = "space-between";
          head.style.alignItems = "center";
          head.style.gap = "8px";
          const hLeft = doc.createElement("div");
          hLeft.style.fontSize = "12px";
          hLeft.style.fontWeight = "600";
          hLeft.textContent = `${race.title} · ${race.projectName}`;
          const hRight = doc.createElement("span");
          hRight.className = "paseo-race-pill";
          hRight.textContent = `${race.isolation} · ${race.createdBy} · ${race.raceId.slice(-6)}`;
          head.appendChild(hLeft);
          head.appendChild(hRight);
          box.appendChild(head);

          race.contenders.forEach((c) => {
            const row = doc.createElement("div");
            row.className = "paseo-race-row";
            const left = doc.createElement("div");
            left.style.display = "flex";
            left.style.alignItems = "center";
            left.style.gap = "8px";
            left.style.minWidth = "0";
            appendBrandIcon(doc, win, left, c.provider, c.model, c.status);
            const info = doc.createElement("div");
            info.style.minWidth = "0";
            const l1 = doc.createElement("div");
            l1.style.fontWeight = "500";
            const winTag = race.winnerWorkspaceId && race.winnerWorkspaceId === c.workspaceId ? (zh ? " [胜出]" : " [Winner]") : "";
            l1.textContent = `${c.profile}${winTag}`;
            const l2 = doc.createElement("div");
            l2.style.fontSize = "11px";
            l2.style.color = "var(--paseo-finder-muted, #71717a)";
            const ds = c.diffStats;
            const diffText = ds
              ? `+${ds.insertions}/-${ds.deletions} (${ds.filesChanged}f, ${ds.aheadCommits}c)`
              : "";
            l2.textContent = [c.status, c.branch, diffText, c.error].filter(Boolean).join(" · ");
            info.appendChild(l1);
            info.appendChild(l2);
            left.appendChild(info);
            row.appendChild(left);

            const btns = doc.createElement("div");
            btns.className = "paseo-race-actions";
            if (c.workspaceId && !c.archived) {
              const openBtn = doc.createElement("button");
              openBtn.type = "button";
              openBtn.className = "paseo-race-btn";
              openBtn.textContent = zh ? "打开" : "Open";
              const targetWs = c.workspaceId;
              openBtn.addEventListener("click", () => {
                close();
                opts.openWorkspace?.(targetWs);
              });
              btns.appendChild(openBtn);

              if (!race.winnerWorkspaceId) {
                const winBtn = doc.createElement("button");
                winBtn.type = "button";
                winBtn.className = "paseo-race-btn";
                winBtn.textContent = zh ? "选为胜出并归档其余" : "Pick Winner";
                const rid = race.raceId;
                winBtn.addEventListener("click", () => {
                  void runArchiveLosers(rid, targetWs);
                });
                btns.appendChild(winBtn);
              }
            }
            row.appendChild(btns);
            box.appendChild(row);
          });
          body.appendChild(box);
        });
      }
    }

    dialog.appendChild(body);

    // Footer
    const footer = doc.createElement("div");
    footer.className = "paseo-race-footer";
    const hint = doc.createElement("span");
    hint.style.fontSize = "11px";
    hint.style.color = "var(--paseo-finder-muted, #71717a)";
    hint.textContent = zh
      ? "快捷键 ⇧⌘M · 与 ~/.paseo/vec-races/races.json 台账实时同步"
      : "Shortcut ⇧⌘M · Synced with ~/.paseo/vec-races/races.json ledger";
    footer.appendChild(hint);

    const actions = doc.createElement("div");
    actions.className = "paseo-race-actions";
    if (activeTab === "launch") {
      const previewBtn = doc.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "paseo-race-btn";
      previewBtn.disabled = busy || selectedContenders.length < 2 || !promptText.trim();
      previewBtn.textContent = zh ? "预演分支" : "Preview";
      previewBtn.addEventListener("click", () => {
        void runAction("dry_run");
      });
      actions.appendChild(previewBtn);

      const launchBtn = doc.createElement("button");
      launchBtn.type = "button";
      launchBtn.className = "paseo-race-btn paseo-race-btn-primary";
      launchBtn.disabled = busy || selectedContenders.length < 2 || !promptText.trim();
      launchBtn.textContent = busy
        ? (zh ? "启动中..." : "Launching...")
        : zh
          ? `并行启动 ${selectedContenders.length} 个线程`
          : `Launch ${selectedContenders.length} Threads`;
      launchBtn.addEventListener("click", () => {
        void runAction("launch");
      });
      actions.appendChild(launchBtn);
    } else {
      const refreshBtn = doc.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "paseo-race-btn";
      refreshBtn.disabled = busy;
      refreshBtn.textContent = zh ? "刷新状态与 Diff" : "Refresh Diffs";
      refreshBtn.addEventListener("click", () => {
        void refreshStatus();
      });
      actions.appendChild(refreshBtn);
    }
    footer.appendChild(actions);
    dialog.appendChild(footer);
  };

  const refreshStatus = async () => {
    busy = true;
    render();
    try {
      const res = await opts.call({
        action: "status",
        cwd: cwdText || undefined,
        workspaceId: params.initialWorkspaceId || undefined,
      });
      snapshot = res;
      if (!cwdText && res.gitContext?.cwd) cwdText = res.gitContext.cwd;
      isolation = res.config.defaultIsolation ?? "worktree";
      branchPrefixText = res.config.defaultBranchPrefix ?? "race";
      if (selectedKeys.size === 0 && res.profiles.length >= 2) {
        // Pre-select two distinct-provider profiles when available for immediate 1-click racing
        const first = res.profiles[0];
        const second = res.profiles.find((p) => p.provider !== first.provider) || res.profiles[1];
        selectedKeys.add(first.id);
        selectedKeys.add(second.id);
      }
      statusError = !res.ok;
      statusBanner = res.error ?? "";
    } catch (err) {
      statusError = true;
      statusBanner = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      render();
    }
  };

  const runAction = async (action: "dry_run" | "launch") => {
    const contenders = collectSelectedContenders();
    if (contenders.length < 2 || !promptText.trim()) return;
    busy = true;
    statusError = false;
    statusBanner = "";
    render();
    try {
      const res = await opts.call({
        action,
        cwd: cwdText || undefined,
        prompt: promptText,
        title: titleText || undefined,
        isolation,
        baseRef: baseRefText || undefined,
        branchPrefix: branchPrefixText || undefined,
        contenders,
        createdBy: "ui",
      });
      snapshot = res;
      statusError = !res.ok;
      if (action === "launch" && res.ok && res.launchedRace) {
        const started = res.launchedRace.contenders.filter((c) => Boolean(c.agentId)).length;
        statusBanner = zh
          ? `已并行启动 ${started}/${res.launchedRace.contenders.length} 个线程（${res.launchedRace.raceId}）`
          : `Launched ${started}/${res.launchedRace.contenders.length} contenders (${res.launchedRace.raceId})`;
        activeTab = "races";
        opts.showToast?.(statusBanner, { variant: "success" });
      } else if (action === "dry_run" && res.ok) {
        statusBanner = zh ? "预演通过，确认分支后可直接并行启动。" : "Dry-run valid. Ready to launch in parallel.";
      } else {
        statusBanner = res.error || (zh ? "操作失败" : "Action failed");
      }
    } catch (err) {
      statusError = true;
      statusBanner = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      render();
    }
  };

  const runArchiveLosers = async (raceId: string, winnerWorkspaceId: string) => {
    busy = true;
    render();
    try {
      const res = await opts.call({
        action: "archive_losers",
        raceId,
        winnerWorkspaceId,
      });
      snapshot = res;
      statusError = !res.ok;
      if (res.archiveResult) {
        statusBanner = zh
          ? `已保留胜出工作区并归档 ${res.archiveResult.archivedCount} 个其余工作区`
          : `Kept winner and archived ${res.archiveResult.archivedCount} losing workspace(s)`;
        opts.showToast?.(statusBanner, { variant: "success" });
      } else {
        statusBanner = res.error || "";
      }
    } catch (err) {
      statusError = true;
      statusBanner = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      render();
    }
  };

  mountPluginModalPopover(doc, overlay);
  render();
  void refreshStatus();
}

function isOnNewWorkspacePage(win: Window, doc: Document): boolean {
  try {
    if (/\/new(?:\?|#|$)/.test(win.location?.pathname || "")) return true;
  } catch {
    // ignore
  }
  return Boolean(doc.querySelector(NEW_WORKSPACE_SUBMIT_SELECTOR));
}

function readDraftComposerPrompt(doc: Document): string {
  const ta = doc.querySelector<HTMLTextAreaElement>(
    '[data-testid="agent-composer"] textarea, textarea[data-testid*="prompt"], textarea',
  );
  return (ta?.value || "").trim();
}

export function installMultiModelRaceEnhancer(opts: RaceModalOptions): () => void {
  const win = resolveExplicitWebWindow(opts.win);
  if (!win || !win.document) return () => {};
  const doc = win.document;

  const ensureNewWorkspaceTrigger = () => {
    if (!isOnNewWorkspacePage(win, doc)) {
      const stale = doc.getElementById(NW_TRIGGER_ID);
      if (stale) stale.remove();
      return;
    }
    if (doc.getElementById(NW_TRIGGER_ID)) return;
    const submitBtn = doc.querySelector<HTMLElement>(NEW_WORKSPACE_SUBMIT_SELECTOR);
    const parent = submitBtn?.parentElement;
    if (!submitBtn || !parent) return;

    syncPaseoThemeCssVariables(doc, win);
    injectStyles(doc);
    const zh = isZhLocale(win, opts.getLocale);
    const btn = doc.createElement("button");
    btn.id = NW_TRIGGER_ID;
    btn.type = "button";
    btn.setAttribute(PLUGIN_INJECTED_ATTR, "true");
    btn.setAttribute("data-testid", "paseo-finder-multi-race-trigger");
    btn.title = zh
      ? "用当前提示词同时启动多个模型独立 Worktree 赛马 (⇧⌘M)"
      : "Launch this prompt across multiple models in parallel worktrees (⇧⌘M)";
    btn.textContent = zh ? "多模型并行" : "Multi-Model Race";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const draftPrompt = readDraftComposerPrompt(doc);
      void openMultiModelRaceModal(opts, { initialPrompt: draftPrompt });
    });
    parent.insertBefore(btn, submitBtn);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "m") {
      ev.preventDefault();
      ev.stopPropagation();
      const draftPrompt = isOnNewWorkspacePage(win, doc) ? readDraftComposerPrompt(doc) : "";
      void openMultiModelRaceModal(opts, { initialPrompt: draftPrompt });
    }
  };

  win.addEventListener("keydown", onKeyDown, true);
  ensureNewWorkspaceTrigger();
  const intervalId = win.setInterval(() => {
    if (doc.visibilityState !== "hidden") {
      ensureNewWorkspaceTrigger();
    }
  }, 1_500);

  (win as unknown as Record<string, unknown>)[GLOBAL_BRIDGE_KEY] = {
    open: (params?: OpenRaceModalParams) => openMultiModelRaceModal(opts, params),
    close: () => {
      const el = doc.getElementById(OVERLAY_ID);
      if (el) unmountPluginModalPopover(el);
    },
  };

  return () => {
    win.clearInterval(intervalId);
    win.removeEventListener("keydown", onKeyDown, true);
    doc.getElementById(NW_TRIGGER_ID)?.remove();
    const ov = doc.getElementById(OVERLAY_ID);
    if (ov) unmountPluginModalPopover(ov);
    delete (win as unknown as Record<string, unknown>)[GLOBAL_BRIDGE_KEY];
  };
}
