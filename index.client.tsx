import { settingsRpc } from "@getpaseo/plugin";
import {
  type PluginButtonRegistration,
  type PluginClientContext,
  getPaseoClient,
} from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import {
  type OpenerTarget,
  type ProjectPickerShortcutPreset,
  type QuickJumpAction,
  type SidebarGroupingPreset,
  SUPPORTED_IMAGE_EXTENSIONS,
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
  archiveWorkspaceRpc,
  toggleWorkspacePinRpc,
  extractProjectSearchKeywords,
  importFolderWorkspaceRpc,
  listWorkspaceMediaRpc,
  manageAgentHistoryRpc,
  manageHarnessCatalogsRpc,
  manageSessionLineageRpc,
  manageSlashSkillsRpc,
  manageVoiceSttRpc,
  manageWorkspaceLabelsRpc,
  openFileTargetRpc,
  pluginSettings,
  quickJumpWorkspaceRpc,
  reconcilePaseoRecoveryRpc,
  renameWorkspaceOrAgentRpc,
} from "./shared/contracts";
import { getCatalogForLocale, pluginTranslations } from "./client/i18n";
import { ImageInspectorFilePanel } from "./client/image-panel";
import { FinderPluginSettingsScreen } from "./client/settings-screen";
import { installDesktopVoiceSttEnhancer } from "./client/voice-stt-web";
import {
  findF2InlineRenameTarget,
  focusWorkspaceInApp,
  getWebWindow,
  installDesktopRevealHelpers,
  installTimelineWireSanitizer,
  locateProjectInSidebar,
  mountInlineTitleInput,
  openNewWorkspaceInApp,
  openQuickWorkspaceSwitcherModal,
  readQuickJumpPreferences,
  resolveCurrentActiveWorkspaceId,
  showFinderNoticeToast,
  syncImagePanelAssociations,
  syncInlineRenamePreferences,
  synchronizeWorkspaceTitleDom,
  toggleCurrentSessionDone,
  triggerQuickThreadMetadataBar,
} from "./client/web";
import {
  WorkspaceFinderPanel,
  WorkspaceFinderPopover,
} from "./client/workspace-finder";
import { SwarmWorkflowWorkspacePanel } from "./client/swarm-panel";
import { installSwarmLiveCard } from "./client/swarm-live-card";
import {
  installSwarmWorkflowDesktopBridge,
  requestOpenSwarmWorkspacePanel,
  subscribeWorkspaceSwarmPresence,
  type WorkspaceSwarmPresence,
} from "./client/swarm-workflow-web";
import { inspectSwarmWorkflowRpc } from "./shared/swarm-workflow-contracts";
import {
  installDesktopScheduleRunsEnhancer,
  triggerScheduleRunsDrawer,
  triggerRunScheduleNow,
  findCadenceScheduleForWorkspace,
} from "./client/schedule-runs-web";
import { installModelQuickSwitch, openModelQuickSwitch } from "./client/model-quick-switch-web";
import {
  installProjectPickerShortcut,
  openProjectPickerFromShortcut,
  syncProjectPickerShortcutPrefs,
} from "./client/project-picker-shortcut-web";
import {
  installSidebarGroupingShortcut,
  switchSidebarGrouping,
  syncSidebarGroupingShortcutPrefs,
} from "./client/sidebar-grouping-shortcut-web";
import { installSidebarDefaultCollapse } from "./client/sidebar-default-collapse-web";
import { installSidebarChildSessions } from "./client/sidebar-child-sessions-web";
import { installSettingsSearch, openSettingsSearch } from "./client/settings-search-web";
import {
  copyCurrentSelectionOrMessageWithMode,
  installSmartClipboardCopy,
  syncSmartCopyPreferences,
} from "./client/smart-copy-web";
import {
  registerMarkdownTableEnhancer,
  syncMarkdownTablePreferences,
} from "./client/markdown-table-web";
import { installMermaidEnhancer } from "./client/markdown-mermaid-web";
import { installDesktopSessionTimeEnhancer } from "./client/session-time-web";
import { installQuoteReply } from "./client/quote-reply-web";
import { installCommitOriginPills } from "./client/commit-origin-web";
import { installSessionRefText } from "./client/session-ref-text-web";
import {
  extractCurrentRouteAgentId,
  installDesktopSubagentsTreeEnhancer,
  triggerSubagentsTreeDrawer,
} from "./client/subagents-tree-web";
import {
  installDesktopSessionLineageEnhancer,
  navigateToLineageNode,
  triggerJumpToParentSession,
  triggerReconcileSidebarWorkspaceTitles,
} from "./client/session-lineage-web";
import { ForkSessionPopover } from "./client/fork-session";
import { forkSessionRpc } from "./shared/contracts";
import {
  SUPPORTED_DOCUMENT_EXTENSIONS,
  listSiblingDocumentsRpc,
} from "./shared/doc-preview-contracts";
import { DocumentInspectorFilePanel } from "./client/doc-panel";
import {
  installDesktopDocPreviewEnhancer,
  openWorkspaceFileTabsInSidePane,
  syncDocumentPanelAssociations,
} from "./client/doc-preview-web";
import { installCompactionAndContextEnhancer } from "./client/compaction-context-web";
import {
  installIntakeDecisionsEnhancer,
  openIntakeDecisionsDrawer,
} from "./client/intake-decisions-web";
import {
  installPinTitlePrefixSync,
  reconcileAllPinnedNow,
  syncPinPrefixPrefs,
} from "./client/pin-prefix-web";
import {
  installQuotaQueueGuard,
  syncQuotaQueuePrefs,
} from "./client/quota-queue-guard-web";
import { createKeyedSerialQueue } from "./client/keyed-serial";
import { inspectAntigravityContextRpc } from "./shared/compaction-context-contracts";
import { manageIntakeDecisionsRpc } from "./shared/intake-decisions-contracts";
import { manageQuotaQueueRpc } from "./shared/quota-queue-contracts";

// One queue for every title write path (Option+D, /done, the Command Center action, F2, slash rename).
// Each rename sends a native setTitle and then a plugin RPC that sets the title again; without
// per-workspace ordering a slow RPC from an earlier rename can land after a later one and win.
const workspaceTitleWrites = createKeyedSerialQueue();

export default function contribute(client: PluginClientContext) {
  // 0. Install in-flight timeline wire sanitizer so sessions with pre-patch `status:"failed", error:null` never freeze
  installTimelineWireSanitizer(getWebWindow());

  // 1. Pre-associate image & document extensions with our file panels & materialize default inline rename prefs
  syncImagePanelAssociations("file-inspector-finder", "image-inspector", true);
  syncDocumentPanelAssociations("file-inspector-finder", "doc-inspector", true);
  syncInlineRenamePreferences({});

  // 2. Register Image & Media File Panel (adds top Finder/Preview/Copy/Metadata toolbar inside image tabs)
  client.addFilePanel({
    id: "image-inspector",
    title: pluginTranslations.message("plugin.filePanelTitle"),
    icon: "Image",
    files: {
      extensions: SUPPORTED_IMAGE_EXTENSIONS,
    },
    Component: ImageInspectorFilePanel,
  });

  // 2b. Register Multi-Document Preview Panel (PDF, DOCX, XLSX, PPTX, RTF, ODT, EPUB, iWork with Scroll & Drag + Compare)
  client.addFilePanel({
    id: "doc-inspector",
    title: pluginTranslations.message("plugin.docPanelTitle"),
    icon: "FileText",
    files: {
      extensions: SUPPORTED_DOCUMENT_EXTENSIONS,
    },
    Component: DocumentInspectorFilePanel,
  });

  // 3. Register Workspace & Explorer Sidebar Panel
  client.addWorkspacePanel({
    id: "finder-panel",
    title: pluginTranslations.message("plugin.workspacePanelTitle"),
    icon: "FolderOpen",
    locations: ["workspace", "explorer"],
    Component: WorkspaceFinderPanel,
  });

  // 3b. Register Antigravity Native Swarm Board & Run-Workflow Panel + Inline Live Swarm Card
  client.addWorkspacePanel({
    id: "swarm-panel",
    title: "Swarm",
    icon: "Network",
    locations: ["workspace", "explorer"],
    Component: SwarmWorkflowWorkspacePanel,
  });
  const uninstallSwarmLiveCard = installSwarmLiveCard(client);

  // 4. Register Plugin Settings & Live Diagnostic Screen
  client.addSettingsScreen({
    id: "finder-settings",
    title: pluginTranslations.message("plugin.settingsTitle"),
    icon: "FolderSearch",
    Component: FinderPluginSettingsScreen,
  });

  // 5. Register Command Center (⌘K) actions
  client.addCommandCenterItem({
    id: "open-antigravity-swarm-board",
    title: "Open Antigravity Swarm Board (Board · Members · Graph · Hive)",
    icon: "Network",
    keywords: ["swarm", "board", "graph", "hive", "antigravity", "agy", "multi-agent"],
    context: "workspace",
    onSelect({ openPanel }) {
      requestOpenSwarmWorkspacePanel({ tab: "swarm" });
      openPanel("swarm-panel", { location: "workspace" });
    },
  });

  client.addCommandCenterItem({
    id: "open-antigravity-workflows",
    title: "Open Antigravity Run-Workflow Inspector (Phases · Logs · Child Agents)",
    icon: "Workflow",
    keywords: ["workflow", "run-workflow", "run_workflow", "phases", "antigravity", "agy"],
    context: "workspace",
    onSelect({ openPanel }) {
      requestOpenSwarmWorkspacePanel({ tab: "workflows" });
      openPanel("swarm-panel", { location: "workspace" });
    },
  });
  client.addCommandCenterItem({
    id: "reveal-latest-image",
    title: pluginTranslations.message("commands.revealLatestImage"),
    icon: "Image",
    keywords: ["finder", "reveal", "image", "folder", "open"],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      const list = await rpc(listWorkspaceMediaRpc, {
        workspaceId: workspace.id,
        workspaceRoot: workspace.directory ?? undefined,
        onlyImages: true,
        limit: 1,
      });
      const latest = list.items[0];
      if (latest) {
        await rpc(openFileTargetRpc, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.directory ?? undefined,
          path: latest.absolutePath,
          target: "finder-reveal",
        });
      } else {
        await rpc(openFileTargetRpc, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.directory ?? undefined,
          path: ".",
          target: "finder-folder",
        });
      }
    },
  });

  client.addCommandCenterItem({
    id: "open-workspace-folder",
    title: pluginTranslations.message("commands.openWorkspaceFolder"),
    icon: "FolderOpen",
    keywords: ["finder", "workspace", "folder", "directory"],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      await rpc(openFileTargetRpc, {
        workspaceId: workspace.id,
        workspaceRoot: workspace.directory ?? undefined,
        path: ".",
        target: "finder-folder",
      });
    },
  });

  client.addCommandCenterItem({
    id: "open-finder-inspector-panel",
    title: pluginTranslations.message("commands.openInspectorPanel"),
    icon: "FolderSearch",
    keywords: ["finder", "inspector", "media", "panel"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("finder-panel", { location: "explorer" });
    },
  });

  client.addCommandCenterItem({
    id: "quick-rename-workspace",
    title: pluginTranslations.message("commands.quickRenameWorkspace"),
    icon: "Edit3",
    keywords: ["rename", "title", "thread", "workspace", "name", "f2"],
    context: "workspace",
    onSelect({ workspace, openPanel, rpc }) {
      const g = globalThis as { document?: unknown; window?: unknown };
      if (g.document && g.window) {
        const target = findF2InlineRenameTarget(
          g.document as Parameters<typeof findF2InlineRenameTarget>[0],
          g.window as Parameters<typeof findF2InlineRenameTarget>[1],
          workspace.id,
        );
        if (target) {
          setTimeout(() => {
            mountInlineTitleInput(
              g.document as Parameters<typeof mountInlineTitleInput>[0],
              g.window as Parameters<typeof mountInlineTitleInput>[1],
              target,
              async (nextTitle, meta) => {
                const targetWsId = meta?.workspaceId ?? workspace.id;
                if (nextTitle) {
                  synchronizeWorkspaceTitleDom(
                    g.document as Parameters<typeof synchronizeWorkspaceTitleDom>[0],
                    g.window as Parameters<typeof synchronizeWorkspaceTitleDom>[1],
                    targetWsId,
                    nextTitle,
                  );
                }
                if (targetWsId && !meta?.agentId) {
                  try {
                    await client.paseo.workspaces.ref(targetWsId).setTitle(nextTitle);
                  } catch {
                    // Fallback to RPC
                  }
                }
                await rpc(renameWorkspaceOrAgentRpc, {
                  workspaceId: targetWsId,
                  agentId: meta?.agentId,
                  title: nextTitle,
                  source: meta?.source ?? "f2-inline",
                });
              },
            );
          }, 40);
          return;
        }
      }
      openPanel("finder-panel", { location: "explorer" });
    },
  });

  client.addCommandCenterItem({
    id: "toggle-session-done",
    title: pluginTranslations.message("commands.toggleSessionDone"),
    icon: "CheckCircle2",
    keywords: ["done", "finish", "complete", "d", "toggle", "mark", "rename"],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      const g = globalThis as { document?: unknown; window?: unknown };
      const doc = g.document as Parameters<typeof toggleCurrentSessionDone>[1];
      const win = g.window as Parameters<typeof toggleCurrentSessionDone>[2];
      await toggleCurrentSessionDone(
        {
          workspaceId: workspace.id,
          doc,
          win,
          callbacks: {
            onFetchThreadMetadata: async (explicitWorkspaceId) => {
              const res = await rpc(manageWorkspaceLabelsRpc, {
                action: "inspect",
                workspaceId: explicitWorkspaceId ?? workspace.id,
              });
              if (!res.ok) return null;
              return {
                workspaceId: res.workspaceId,
                workspaceTitle: res.workspaceTitle,
                assignedLabels: res.assignedLabels,
                catalog: res.catalog,
              };
            },
            onRenameThread: async (newTitle, options) => {
              const targetWsId = options?.workspaceId ?? workspace.id;
              if (newTitle) {
                synchronizeWorkspaceTitleDom(doc, win, targetWsId, newTitle);
              }
              await workspaceTitleWrites.run(targetWsId, async () => {
                try {
                  await client.paseo.workspaces.ref(targetWsId).setTitle(newTitle);
                } catch {
                  // Fallback
                }
                await rpc(renameWorkspaceOrAgentRpc, {
                  workspaceId: targetWsId,
                  title: newTitle,
                  source: "mark-done-shortcut",
                });
              });
            },
          },
        },
        doc,
        win,
      );
    },
  });

  client.addCommandCenterItem({
    id: "quick-manage-labels",
    title: pluginTranslations.message("commands.quickManageLabels"),
    icon: "Tag",
    keywords: ["label", "tag", "color", "thread", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("finder-panel", { location: "explorer" });
      void triggerQuickThreadMetadataBar("labels");
    },
  });

  client.addCommandCenterItem({
    id: "change-model",
    title: pluginTranslations.message("commands.changeModel"),
    icon: "Cpu",
    keywords: ["model", "profile", "switch", "change", "provider", "llm"],
    context: "global",
    onSelect() {
      // Let the Command Center close and hand focus back to the composer first.
      setTimeout(() => openModelQuickSwitch(), 160);
    },
  });

  client.addCommandCenterItem({
    id: "choose-project",
    title: pluginTranslations.message("commands.chooseProject"),
    icon: "Folder",
    keywords: [
      "project",
      "choose project",
      "select project",
      "new workspace",
      "pick project",
      "选择项目",
      "项目",
    ],
    context: "global",
    onSelect() {
      // Let the Command Center close and hand focus back to the composer first.
      setTimeout(() => {
        const opened = openProjectPickerFromShortcut({ silentNoTrigger: true });
        if (!opened) {
          openNewWorkspaceInApp({});
          let attempts = 0;
          const poll = () => {
            attempts += 1;
            const isFinal = attempts >= 35;
            if (openProjectPickerFromShortcut({ silentNoTrigger: !isFinal })) return;
            const winLoc = (globalThis as { location?: { pathname?: string } }).location?.pathname;
            if (attempts > 8 && winLoc && winLoc !== "/new") return;
            if (!isFinal) setTimeout(poll, 60);
          };
          setTimeout(poll, 80);
        }
      }, 160);
    },
  });

  client.addCommandCenterItem({
    id: "search-settings",
    title: pluginTranslations.message("commands.searchSettings"),
    icon: "Search",
    keywords: ["settings", "preferences", "options", "config", "find", "search"],
    context: "global",
    onSelect() {
      setTimeout(() => openSettingsSearch(), 160);
    },
  });

  client.addCommandCenterItem({
    id: "copy-clean-plain-text",
    title: pluginTranslations.message("commands.copyCleanText"),
    icon: "Copy",
    keywords: [
      "copy",
      "plain",
      "clean",
      "text",
      "asterisk",
      "strip",
      "markdown",
      "beeper",
      "wechat",
      "linkedin",
      "复制",
      "纯文本",
      "星号",
    ],
    context: "workspace",
    onSelect() {
      setTimeout(() => {
        void copyCurrentSelectionOrMessageWithMode("plain", "command-center");
      }, 60);
    },
  });

  client.addCommandCenterItem({
    id: "copy-raw-markdown",
    title: pluginTranslations.message("commands.copyRawMarkdown"),
    icon: "FileText",
    keywords: ["copy", "markdown", "raw", "md", "obsidian", "notion", "复制", "源码"],
    context: "workspace",
    onSelect() {
      setTimeout(() => {
        void copyCurrentSelectionOrMessageWithMode("markdown", "command-center");
      }, 60);
    },
  });

  client.addCommandCenterItem({
    id: "import-folder-workspace",
    title: pluginTranslations.message("commands.importFolderWorkspace"),
    icon: "FolderPlus",
    keywords: ["folder", "drop", "import", "workspace", "project", "open"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("finder-panel", { location: "explorer" });
    },
  });

  const launchQuickJumpModal = (initialQuery?: string) => {
    const jumpPrefs = readQuickJumpPreferences();
    void openQuickWorkspaceSwitcherModal({
      initialQuery,
      locale: client.i18n.locale,
      defaultJumpMode: jumpPrefs.quickJumpDefaultAction,
      onListJumpProjects: async (query?: string) => {
        const res = await client.rpc(quickJumpWorkspaceRpc, {
          action: "list",
          query,
          limit: 50,
          source: "quick-switcher",
        });
        return res.candidates;
      },
      onExecuteQuickJump: async (input) => {
        const res = await client.rpc(quickJumpWorkspaceRpc, {
          action: "jump",
          projectId: input.projectId,
          query: input.query,
          jumpMode: input.jumpMode,
          source: input.source ?? "quick-switcher",
        });
        if (res.ok && res.targetWorkspaceId) {
          lastKnownWorkspaceId = res.targetWorkspaceId;
        }
        return {
          ok: res.ok,
          jumpMode: res.jumpMode,
          targetWorkspaceId: res.targetWorkspaceId,
          targetProjectId: res.targetProjectId,
          targetProjectKey: res.targetProjectKey,
          targetProjectName: res.targetProjectName,
          message: res.message,
        };
      },
    });
  };

  client.addCommandCenterItem({
    id: "quick-jump-workspace",
    title: pluginTranslations.message("commands.quickJumpWorkspace"),
    icon: "FolderSearch",
    keywords: [
      "jump",
      "switch",
      "workspace",
      "project",
      "folder",
      "go",
      "cmd+j",
      "quick",
    ],
    context: "global",
    onSelect({ openSettings }) {
      setTimeout(() => {
        launchQuickJumpModal();
      }, 30);
      void openSettings;
    },
  });

  client.addCommandCenterItem({
    id: "inspect-schedule-runs",
    title: "Schedules: Inspect Runs & Execution History (⌘⇧H)",
    icon: "Clock",
    keywords: [
      "schedule",
      "runs",
      "history",
      "cadence",
      "automation",
      "standby",
      "logs",
      "定时任务",
      "运行记录",
      "历史",
    ],
    context: "global",
    onSelect() {
      setTimeout(() => {
        triggerScheduleRunsDrawer(null);
      }, 30);
    },
  });

  client.addSlashCommand({
    name: "schedule-runs",
    description:
      "Open Paseo Schedule Runs & Execution History drawer (or inspect a specific schedule ID)",
    argumentHint: "[schedule-id]",
    context: "workspace",
    async onSubmit({ args }) {
      const sid = args.trim() || null;
      setTimeout(() => {
        triggerScheduleRunsDrawer(sid);
      }, 30);
    },
  });

  client.addSlashCommand({
    name: "run-now",
    description:
      "Trigger an immediate run for a cadence schedule (or the current workspace cadence)",
    argumentHint: "[schedule-id]",
    context: "workspace",
    async onSubmit({ args }) {
      const rawSid = args.trim();
      let targetId = rawSid;
      if (targetId) {
        const resolved = findCadenceScheduleForWorkspace(targetId, targetId);
        if (resolved) {
          targetId = resolved.id;
        }
      } else {
        const g = globalThis as { window?: { location?: { pathname?: string } } };
        const pathname = g.window?.location?.pathname ?? "";
        const m = pathname.match(/\/workspace\/([^/?#]+)/);
        const wsId = m?.[1] ? decodeURIComponent(m[1]) : null;
        const sched = findCadenceScheduleForWorkspace(wsId);
        if (sched) targetId = sched.id;
      }
      if (targetId) {
        await triggerRunScheduleNow(targetId);
      } else {
        setTimeout(() => {
          triggerScheduleRunsDrawer(null);
        }, 30);
      }
    },
  });

  client.addSlashCommand({
    name: "cadence-run",
    description:
      "Trigger an immediate run for a cadence schedule (or the current workspace cadence)",
    argumentHint: "[schedule-id]",
    context: "workspace",
    async onSubmit({ args }) {
      const rawSid = args.trim();
      let targetId = rawSid;
      if (targetId) {
        const resolved = findCadenceScheduleForWorkspace(targetId, targetId);
        if (resolved) {
          targetId = resolved.id;
        }
      } else {
        const g = globalThis as { window?: { location?: { pathname?: string } } };
        const pathname = g.window?.location?.pathname ?? "";
        const m = pathname.match(/\/workspace\/([^/?#]+)/);
        const wsId = m?.[1] ? decodeURIComponent(m[1]) : null;
        const sched = findCadenceScheduleForWorkspace(wsId);
        if (sched) targetId = sched.id;
      }
      if (targetId) {
        await triggerRunScheduleNow(targetId);
      } else {
        setTimeout(() => {
          triggerScheduleRunsDrawer(null);
        }, 30);
      }
    },
  });

  client.addCommandCenterItem({
    id: "inspect-subagents-tree",
    title: "Antigravity: Inspect Subagent Tree & Connected Sessions (⌘⇧B)",
    icon: "Cpu",
    keywords: [
      "subagent",
      "subagents",
      "boost",
      "deepcoder",
      "tree",
      "connected",
      "session",
      "timeline",
      "子智能体",
      "对话树",
    ],
    context: "global",
    onSelect() {
      const g = globalThis as { window?: { location?: { pathname?: string } } };
      const agId = extractCurrentRouteAgentId(g.window?.location?.pathname);
      setTimeout(() => {
        triggerSubagentsTreeDrawer({ agentId: agId });
      }, 30);
    },
  });

  client.addSlashCommand({
    name: "subagents-tree",
    description:
      "Open Antigravity Subagent Tree & Connected Sessions Inspector (/boost multi-level L1/L2 timelines)",
    argumentHint: "[conversation-id]",
    context: "workspace",
    async onSubmit({ args }) {
      const cid = args.trim() || null;
      const g = globalThis as { window?: { location?: { pathname?: string } } };
      const agId = extractCurrentRouteAgentId(g.window?.location?.pathname);
      setTimeout(() => {
        triggerSubagentsTreeDrawer({ agentId: agId, conversationId: cid });
      }, 30);
    },
  });

  // Fork this session: same RPC as the header Split button; the new agent opens in Paseo.
  const forkCurrentSession = async (
    ctx: { agent: { id: string; provider: string }; rpc: typeof client.rpc },
    title?: string,
  ) => {
    const res = await ctx.rpc(forkSessionRpc, {
      agentId: ctx.agent.id,
      title: title && title.trim() ? title.trim() : undefined,
      open: true,
      dryRun: false,
      source: "slash-command",
    });
    if (!res.ok) throw new Error(res.message);
  };

  client.addSlashCommand({
    name: "fork-session",
    description: "Fork this Antigravity session into a new agent with the full conversation (this one is unchanged)",
    argumentHint: "[title]",
    context: "agent",
    async onSubmit(ctx) {
      await forkCurrentSession(ctx, ctx.args);
    },
  });

  client.addCommandCenterItem({
    id: "fork-this-session",
    title: "Fork this session",
    icon: "Split",
    keywords: ["fork", "branch", "duplicate", "copy session", "分叉", "复制会话"],
    context: "agent",
    async onSelect(ctx) {
      await forkCurrentSession(ctx);
    },
  });

  client.addCommandCenterItem({
    id: "jump-to-parent-session",
    title: "Session Lineage: Jump Back to Initiating / Parent Session (⌘⇧↑)",
    icon: "CornerUpLeft",
    keywords: [
      "parent",
      "lineage",
      "origin",
      "spawn",
      "back",
      "initiating",
      "父会话",
      "发起会话",
      "返回",
    ],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      const jumped = await triggerJumpToParentSession();
      if (jumped) return;
      const res = await rpc(manageSessionLineageRpc, {
        action: "inspect",
        workspaceId: workspace.id,
        source: "command-center",
      });
      if (res.parent) {
        navigateToLineageNode(res.parent);
      }
    },
  });

  client.addCommandCenterItem({
    id: "reconcile-sidebar-workspace-titles",
    title: "Session Lineage: Reconcile Untitled 'main' Sidebar Workspaces & Parent Links",
    icon: "RefreshCw",
    keywords: [
      "reconcile",
      "main",
      "untitled",
      "sidebar",
      "title",
      "lineage",
      "intake",
      "spawn",
      "侧边栏",
      "标题",
    ],
    context: "global",
    async onSelect({ rpc }) {
      const viaEnhancer = await triggerReconcileSidebarWorkspaceTitles();
      if (viaEnhancer) return;
      await rpc(manageSessionLineageRpc, {
        action: "reconcile",
        workspaceId: lastKnownWorkspaceId,
        autoFixTitles: true,
        source: "command-center",
      });
    },
  });

  for (const cmdName of ["lineage", "parent"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description:
        "Jump to the initiating parent session or reconcile untitled 'main' sidebar workspaces (/lineage [reconcile|parent])",
      argumentHint: "[reconcile | parent]",
      context: "workspace",
      async onSubmit({ args, workspace, rpc }) {
        const arg = args.trim().toLowerCase();
        if (arg === "reconcile" || arg === "fix" || arg === "sync") {
          await rpc(manageSessionLineageRpc, {
            action: "reconcile",
            workspaceId: workspace.id,
            autoFixTitles: true,
            source: "slash-command",
          });
          await triggerReconcileSidebarWorkspaceTitles();
          return;
        }
        const res = await rpc(manageSessionLineageRpc, {
          action: "inspect",
          workspaceId: workspace.id,
          autoFixTitles: true,
          source: "slash-command",
        });
        if (res.parent) {
          navigateToLineageNode(res.parent);
        }
      },
    });
  }

  client.addCommandCenterItem({
    id: "configure-custom-voice-stt",
    title: pluginTranslations.message("commands.configureVoiceStt"),
    icon: "Activity",
    keywords: [
      "voice",
      "stt",
      "speech",
      "dictation",
      "siliconflow",
      "openwhispr",
      "sensevoice",
      "qwen",
      "telespeech",
      "whisper",
      "语音",
      "硅基流动",
    ],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("finder-settings");
    },
  });

  for (const cmdName of ["voice", "stt"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.voiceSlashDescription"),
      argumentHint: pluginTranslations.message("commands.voiceSlashHint"),
      context: "workspace",
      async onSubmit({ args, rpc }) {
        const trimmed = args.trim();
        if (!trimmed) {
          await rpc(manageVoiceSttRpc, {
            action: "inspect",
            source: "slash-command",
          });
          return;
        }
        const lower = trimmed.toLowerCase();
        if (lower === "test" || lower === "probe") {
          await rpc(manageVoiceSttRpc, {
            action: "test",
            source: "slash-command",
          });
          return;
        }
        if (lower === "reset" || lower === "default") {
          await rpc(manageVoiceSttRpc, {
            action: "reset",
            source: "slash-command",
          });
          return;
        }
        await rpc(manageVoiceSttRpc, {
          action: "apply",
          presetId: trimmed,
          model: trimmed,
          source: "slash-command",
        });
      },
    });
  }

  client.addCommandCenterItem({
    id: "heal-agent-history",
    title: "Agent History: Inspect & Auto-Heal Timeline Sync (聊天记录恢复与对账)",
    icon: "Activity",
    keywords: [
      "history",
      "timeline",
      "sync",
      "heal",
      "restore",
      "vault",
      "antigravity",
      "聊天记录",
      "恢复",
      "无法获取",
    ],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      await rpc(manageAgentHistoryRpc, {
        action: "heal",
        workspaceId: workspace.id,
        source: "command-center",
      });
      const g = globalThis as { document?: { querySelector?: (s: string) => { click?: () => void } | null } };
      g.document?.querySelector?.('[data-testid="agent-timeline-sync-retry"]')?.click?.();
    },
  });

  client.addSlashCommand({
    name: "heal-history",
    description:
      "Inspect or auto-heal Paseo Antigravity agent conversation history & session.ts patches",
    argumentHint: "[workspace-id or conversation-id]",
    context: "workspace",
    async onSubmit({ args, workspace, rpc }) {
      const q = args.trim();
      await rpc(manageAgentHistoryRpc, {
        action: "heal",
        workspaceId: q || workspace.id,
        conversationId: /^[0-9a-f-]{32,36}$/i.test(q) ? q : undefined,
        source: "slash-command",
      });
      const g = globalThis as { document?: { querySelector?: (s: string) => { click?: () => void } | null } };
      g.document?.querySelector?.('[data-testid="agent-timeline-sync-retry"]')?.click?.();
    },
  });

  client.addCommandCenterItem({
    id: "pull-up-interrupted-agents",
    title: "Startup Recovery: Inspect & Auto-Pull-Up Interrupted Agents (中断智能体自动拉起)",
    icon: "Activity",
    keywords: [
      "pull-up",
      "recovery",
      "resume",
      "startup",
      "interrupted",
      "stalled",
      "agent",
      "拉起",
      "恢复",
      "中断",
      "自动拉起",
    ],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(reconcilePaseoRecoveryRpc, {
        action: "heal",
        source: "command-center",
      });
    },
  });

  for (const cmdName of ["pull-up", "resume-interrupted"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description:
        "Inspect, simulate, or auto-pull-up interrupted/startup-failed Paseo agents",
      argumentHint: "[status | simulate | heal | reset | <agent-id>]",
      context: "workspace",
      async onSubmit({ args, rpc }) {
        const trimmed = args.trim();
        const lower = trimmed.toLowerCase();
        if (lower === "status" || lower === "simulate" || lower === "heal" || lower === "reset") {
          await rpc(reconcilePaseoRecoveryRpc, {
            action: lower,
            source: "slash-command",
          });
          return;
        }
        await rpc(reconcilePaseoRecoveryRpc, {
          action: "heal",
          agentId: trimmed || undefined,
          source: "slash-command",
        });
      },
    });
  }

  client.addCommandCenterItem({
    id: "customize-slash-skills-catalog",
    title:
      "Customize: Sync & Manage Slash Commands, Skills, Rules, Subagents & MCPs (斜杠命令与 Skill 控制面)",
    icon: "Sliders",
    keywords: [
      "customize",
      "slash",
      "skills",
      "commands",
      "rules",
      "subagents",
      "mcps",
      "plugins",
      "pin",
      "disable",
      "cursor",
      "斜杠命令",
      "技能",
    ],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(manageSlashSkillsRpc, {
        action: "sync",
        source: "command-center",
      });
    },
  });

  for (const cmdName of ["customize", "skills-ctl"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description:
        "Manage Paseo Antigravity slash commands, skills, rules, subagents & MCPs (pin, unpin, disable, enable, sync, or dry-run)",
      argumentHint: "[sync | pin <slug> | unpin <slug> | disable <slug> | enable <slug> | reset-pins | <query>]",
      context: "workspace",
      async onSubmit({ args, rpc }) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const first = (tokens[0] || "").toLowerCase();
        const rest = tokens.slice(1).join(" ");
        if (!first || first === "status") {
          await rpc(manageSlashSkillsRpc, {
            action: "status",
            source: "slash-command",
          });
          return;
        }
        if (first === "sync" || first === "reset-pins") {
          await rpc(manageSlashSkillsRpc, {
            action: first,
            source: "slash-command",
          });
          return;
        }
        if (
          (first === "pin" || first === "unpin" || first === "disable" || first === "enable") &&
          rest
        ) {
          await rpc(manageSlashSkillsRpc, {
            action: first,
            slug: rest,
            source: "slash-command",
          });
          return;
        }
        if (args.includes("/")) {
          await rpc(manageSlashSkillsRpc, {
            action: "test",
            samplePrompt: args.trim(),
            source: "slash-command",
          });
          return;
        }
        await rpc(manageSlashSkillsRpc, {
          action: "status",
          query: args.trim(),
          source: "slash-command",
        });
      },
    });
  }

  // 6. Register Composer Slash Commands (/reveal, /finder, /rename, /title, /label, /tag)
  for (const cmdName of ["reveal", "finder"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.slashDescription"),
      argumentHint: pluginTranslations.message("commands.slashHint"),
      context: "workspace",
      async onSubmit({ args, workspace, rpc }) {
        const trimmed = args.trim();
        if (!trimmed) {
          const list = await rpc(listWorkspaceMediaRpc, {
            workspaceId: workspace.id,
            workspaceRoot: workspace.directory ?? undefined,
            onlyImages: true,
            limit: 1,
          });
          const latest = list.items[0];
          await rpc(openFileTargetRpc, {
            workspaceId: workspace.id,
            workspaceRoot: workspace.directory ?? undefined,
            path: latest ? latest.absolutePath : ".",
            target: latest ? "finder-reveal" : "finder-folder",
          });
          return;
        }
        await rpc(openFileTargetRpc, {
          workspaceId: workspace.id,
          workspaceRoot: workspace.directory ?? undefined,
          path: trimmed,
          target: "finder-reveal",
        });
      },
    });
  }

  for (const cmdName of ["rename", "title"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.renameSlashDescription"),
      argumentHint: pluginTranslations.message("commands.renameSlashHint"),
      context: "workspace",
      async onSubmit({ args, workspace, rpc }) {
        const trimmed = args.trim();
        if (!trimmed) return;
        const normalized =
          trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "reset"
            ? null
            : trimmed;
        if (normalized) {
          const win = getWebWindow();
          const doc = win?.document ?? null;
          if (doc) {
            synchronizeWorkspaceTitleDom(doc, win, workspace.id, normalized);
          }
        }
        await client.paseo.workspaces.ref(workspace.id).setTitle(normalized);
        await rpc(renameWorkspaceOrAgentRpc, {
          workspaceId: workspace.id,
          title: normalized,
          source: "slash-command",
        });
      },
    });
  }

  for (const cmdName of ["done", "d"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.doneSlashDescription"),
      argumentHint: pluginTranslations.message("commands.doneSlashHint"),
      context: "workspace",
      async onSubmit({ args, workspace, rpc }) {
        const customPrefix = args.trim() ? `${args.trim()} ` : "d ";
        const g = globalThis as { document?: unknown; window?: unknown };
        const doc = g.document as Parameters<typeof toggleCurrentSessionDone>[1];
        const win = g.window as Parameters<typeof toggleCurrentSessionDone>[2];
        await toggleCurrentSessionDone(
          {
            workspaceId: workspace.id,
            prefix: customPrefix,
            doc,
            win,
            callbacks: {
              onFetchThreadMetadata: async (explicitWorkspaceId) => {
                const res = await rpc(manageWorkspaceLabelsRpc, {
                  action: "inspect",
                  workspaceId: explicitWorkspaceId ?? workspace.id,
                });
                if (!res.ok) return null;
                return {
                  workspaceId: res.workspaceId,
                  workspaceTitle: res.workspaceTitle,
                  assignedLabels: res.assignedLabels,
                  catalog: res.catalog,
                };
              },
              onRenameThread: async (newTitle, options) => {
                const targetWsId = options?.workspaceId ?? workspace.id;
                if (newTitle) {
                  synchronizeWorkspaceTitleDom(doc, win, targetWsId, newTitle);
                }
                await workspaceTitleWrites.run(targetWsId, async () => {
                  try {
                    await client.paseo.workspaces.ref(targetWsId).setTitle(newTitle);
                  } catch {
                    // Fallback
                  }
                  await rpc(renameWorkspaceOrAgentRpc, {
                    workspaceId: targetWsId,
                    title: newTitle,
                    source: "mark-done-shortcut",
                  });
                });
              },
            },
          },
          doc,
          win,
        );
      },
    });
  }

  for (const cmdName of ["copy-clean", "copy-text"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.copyCleanSlashDescription"),
      argumentHint: pluginTranslations.message("commands.copyCleanSlashHint"),
      context: "workspace",
      async onSubmit({ args }) {
        const arg = args.trim().toLowerCase();
        if (arg === "smart" || arg === "plain" || arg === "markdown") {
          syncSmartCopyPreferences({ defaultMode: arg });
        }
        await copyCurrentSelectionOrMessageWithMode(
          arg === "markdown" ? "markdown" : arg === "smart" ? "smart" : "plain",
          "slash-command",
        );
      },
    });
  }

  for (const cmdName of ["copy-md", "copy-markdown"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.copyMdSlashDescription"),
      argumentHint: pluginTranslations.message("commands.copyMdSlashHint"),
      context: "workspace",
      async onSubmit() {
        await copyCurrentSelectionOrMessageWithMode("markdown", "slash-command");
      },
    });
  }

  const validColorSet = new Set<string>(WORKSPACE_LABEL_COLORS);

  for (const cmdName of ["label", "tag"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.labelSlashDescription"),
      argumentHint: pluginTranslations.message("commands.labelSlashHint"),
      context: "workspace",
      async onSubmit({ args, workspace, rpc }) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
          void triggerQuickThreadMetadataBar("labels");
          return;
        }

        const firstLower = tokens[0].toLowerCase();
        if (firstLower === "delete" || firstLower === "rm" || firstLower === "remove") {
          const targetName = tokens.slice(1).join(" ");
          if (!targetName) return;
          await rpc(manageWorkspaceLabelsRpc, {
            action: "delete",
            workspaceId: workspace.id,
            labelName: targetName,
          });
          return;
        }

        if (firstLower === "rename" || firstLower === "update") {
          const oldName = tokens[1];
          const newName = tokens[2];
          const maybeColor = tokens[3]?.toLowerCase();
          if (!oldName || !newName) return;
          await rpc(manageWorkspaceLabelsRpc, {
            action: "update",
            workspaceId: workspace.id,
            labelName: oldName,
            newName,
            color:
              maybeColor && validColorSet.has(maybeColor)
                ? (maybeColor as WorkspaceLabelColor)
                : undefined,
          });
          return;
        }

        const lastTokenLower = tokens[tokens.length - 1].toLowerCase();
        const hasTrailingColor = tokens.length >= 2 && validColorSet.has(lastTokenLower);
        const color = hasTrailingColor ? (lastTokenLower as WorkspaceLabelColor) : undefined;
        const labelName = hasTrailingColor
          ? tokens.slice(0, -1).join(" ")
          : tokens.join(" ");

        await rpc(manageWorkspaceLabelsRpc, {
          action: "toggle",
          workspaceId: workspace.id,
          labelName,
          color,
        });
      },
    });
  }

  for (const cmdName of ["open-folder", "import-workspace"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.openFolderSlashDescription"),
      argumentHint: pluginTranslations.message("commands.openFolderSlashHint"),
      context: "workspace",
      async onSubmit({ args, rpc }) {
        const trimmed = args.trim();
        if (!trimmed) return;
        const res = await rpc(importFolderWorkspaceRpc, {
          paths: [trimmed],
          source: "slash-command",
        });
        if (res.ok && res.primaryWorkspaceId) {
          focusWorkspaceInApp(res.primaryWorkspaceId, res.primaryProjectId);
        }
      },
    });
  }

  for (const cmdName of ["jump", "go"] as const) {
    client.addSlashCommand({
      name: cmdName,
      description: pluginTranslations.message("commands.jumpSlashDescription"),
      argumentHint: pluginTranslations.message("commands.jumpSlashHint"),
      context: "workspace",
      async onSubmit({ args, rpc }) {
        const trimmed = args.trim();
        if (!trimmed) {
          launchQuickJumpModal();
          return;
        }
        const res = await rpc(quickJumpWorkspaceRpc, {
          action: "jump",
          query: trimmed,
          source: "slash-command",
        });
        if (!res.ok) {
          launchQuickJumpModal(trimmed);
          return;
        }
        if (res.jumpMode === "locate-sidebar") {
          locateProjectInSidebar({
            projectId: res.targetProjectId,
            projectKey: res.targetProjectKey,
            projectName: res.targetProjectName,
            expandIfCollapsed: true,
            highlightFlash: true,
          });
        } else if (res.targetWorkspaceId) {
          lastKnownWorkspaceId = res.targetWorkspaceId;
          focusWorkspaceInApp(
            res.targetWorkspaceId,
            res.targetProjectId,
            undefined,
            undefined,
            {
              projectKey: res.targetProjectKey,
              projectName: res.targetProjectName,
            },
          );
        }
      },
    });
  }

  // 7. Dynamically register Top-Right Workspace Header Button + Command Center (⌘K) Project Jump Items
  const headerButtons = new Map<string, PluginButtonRegistration>();
  const forkButtons = new Map<string, PluginButtonRegistration>();
  const swarmButtons = new Map<string, PluginButtonRegistration>();
  const workspaceSwarmPresence = new Map<string, WorkspaceSwarmPresence>();

  const updateSwarmHeaderButton = (workspaceId: string) => {
    const reg = swarmButtons.get(workspaceId);
    if (!reg) return;
    const info = workspaceSwarmPresence.get(workspaceId);
    const live = Boolean(info && info.activeCount > 0);
    reg.update({
      visible: Boolean(info),
      label: live ? "Swarm · Live" : "Swarm",
      title: info
        ? `${info.title} (${info.memberCount}m · ${info.postCount}p)`
        : "Open Antigravity Swarm Board",
    });
  };
  const projectCommandCleanups = new Map<string, () => void>();
  const workspaceToProjectMap = new Map<
    string,
    {
      projectId: string;
      projectKey: string | null;
      projectName: string;
    }
  >();
  const lifetime = new AbortController();
  let lastKnownWorkspaceId: string | undefined;
  let syncProjectsTimer: ReturnType<typeof setTimeout> | null = null;

  const updateWorkspaceProjectCache = (
    candidates: Array<{
      projectId: string;
      projectKey: string | null;
      projectName: string;
      primaryWorkspaceId: string | null;
      workspaceIds?: string[];
    }>,
  ) => {
    for (const cand of candidates) {
      const ids = cand.workspaceIds?.length
        ? cand.workspaceIds
        : cand.primaryWorkspaceId
          ? [cand.primaryWorkspaceId]
          : [];
      for (const wsId of ids) {
        if (wsId) {
          workspaceToProjectMap.set(wsId, {
            projectId: cand.projectId,
            projectKey: cand.projectKey,
            projectName: cand.projectName,
          });
        }
      }
    }
  };

  const clearProjectCommandItems = () => {
    for (const cleanup of projectCommandCleanups.values()) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
    projectCommandCleanups.clear();
  };

  const syncCommandCenterProjectItems = async () => {
    if (lifetime.signal.aborted) return;
    const res = await client
      .rpc(quickJumpWorkspaceRpc, {
        action: "list",
        limit: 50,
        source: "command-center",
      })
      .catch(() => null);
    if (!res || lifetime.signal.aborted) return;
    updateWorkspaceProjectCache(res.candidates);

    const jumpPrefs = readQuickJumpPreferences();
    if (!jumpPrefs.enableCommandCenterProjectItems) {
      clearProjectCommandItems();
      return;
    }

    const catalog = getCatalogForLocale(client.i18n.locale);
    const seenIds = new Set<string>();

    for (const candidate of res.candidates) {
      const safeProjectId = String(candidate.projectId ?? "")
        .replace(/[^a-z0-9.-]/gi, "-")
        .toLowerCase();
      const itemId = `jump-project-${safeProjectId}`;
      seenIds.add(itemId);
      projectCommandCleanups.get(itemId)?.();

      const cleanup = client.addCommandCenterItem({
        id: itemId,
        title: `${catalog.commands.jumpToProjectPrefix} ${candidate.projectName} (${candidate.activeWorkspaceCount})`,
        icon: "FolderOpen",
        keywords: extractProjectSearchKeywords(
          candidate.projectName,
          candidate.projectRootPath,
        ),
        context: "global",
        async onSelect({ rpc }) {
          const jumpRes = await rpc(quickJumpWorkspaceRpc, {
            action: "jump",
            projectId: candidate.projectId,
            source: "command-center",
          });
          if (!jumpRes.ok) return;
          if (jumpRes.jumpMode === "locate-sidebar") {
            locateProjectInSidebar({
              projectId: jumpRes.targetProjectId ?? candidate.projectId,
              projectKey: jumpRes.targetProjectKey ?? candidate.projectKey,
              projectName: jumpRes.targetProjectName ?? candidate.projectName,
              expandIfCollapsed: true,
              highlightFlash: true,
            });
          } else if (jumpRes.jumpMode === "new-workspace") {
            openNewWorkspaceInApp({
              projectId: jumpRes.targetProjectId ?? candidate.projectId,
              projectKey: jumpRes.targetProjectKey ?? candidate.projectKey,
              projectName: jumpRes.targetProjectName ?? candidate.projectName,
              projectDirectory: jumpRes.targetDirectory ?? candidate.projectRootPath,
            });
          } else if (jumpRes.targetWorkspaceId) {
            lastKnownWorkspaceId = jumpRes.targetWorkspaceId;
            focusWorkspaceInApp(
              jumpRes.targetWorkspaceId,
              jumpRes.targetProjectId ?? candidate.projectId,
              undefined,
              undefined,
              {
                projectKey: jumpRes.targetProjectKey ?? candidate.projectKey,
                projectName: jumpRes.targetProjectName ?? candidate.projectName,
              },
            );
          }
        },
      });

      if (typeof cleanup === "function") {
        projectCommandCleanups.set(itemId, cleanup);
      }
    }

    for (const [existingId, cleanup] of projectCommandCleanups.entries()) {
      if (!seenIds.has(existingId)) {
        try {
          cleanup();
        } catch {
          // Ignore
        }
        projectCommandCleanups.delete(existingId);
      }
    }
  };

  let syncProjectsInProgress = false;
  let syncProjectsPending = false;

  const runSyncCommandCenterProjectItems = async () => {
    if (syncProjectsInProgress) {
      syncProjectsPending = true;
      return;
    }
    syncProjectsInProgress = true;
    try {
      await syncCommandCenterProjectItems();
    } finally {
      syncProjectsInProgress = false;
      if (syncProjectsPending && !lifetime.signal.aborted) {
        syncProjectsPending = false;
        void runSyncCommandCenterProjectItems();
      }
    }
  };

  const scheduleCommandCenterProjectsSync = () => {
    if (lifetime.signal.aborted) return;
    if (syncProjectsTimer) {
      clearTimeout(syncProjectsTimer);
    }
    syncProjectsTimer = setTimeout(() => {
      void runSyncCommandCenterProjectItems();
    }, 300);
  };

  void runSyncCommandCenterProjectItems();

  const registerWorkspaceHeader = (workspace: { id: string }) => {
    if (lifetime.signal.aborted) return;
    const workspaceId = workspace.id;
    lastKnownWorkspaceId = workspaceId;
    headerButtons.get(workspaceId)?.remove();
    headerButtons.set(
      workspaceId,
      client.addHeaderButton({
        id: "finder-header-btn",
        workspaceId,
        button: {
          title: pluginTranslations.message("plugin.headerButtonTitle"),
          icon: "FolderOpen",
          behavior: {
            kind: "popover",
            Content: WorkspaceFinderPopover,
          },
        },
      }),
    );
    forkButtons.get(workspaceId)?.remove();
    forkButtons.set(
      workspaceId,
      client.addHeaderButton({
        id: "fork-session-btn",
        workspaceId,
        button: {
          title: "Fork this session",
          icon: "Split",
          behavior: { kind: "popover", Content: ForkSessionPopover },
        },
      }),
    );
    swarmButtons.get(workspaceId)?.remove();
    const existingSwarm = workspaceSwarmPresence.get(workspaceId);
    const swarmLive = Boolean(existingSwarm && existingSwarm.activeCount > 0);
    swarmButtons.set(
      workspaceId,
      client.addHeaderButton({
        id: "swarm-header-btn",
        workspaceId,
        button: {
          title: existingSwarm
            ? `${existingSwarm.title} (${existingSwarm.memberCount}m · ${existingSwarm.postCount}p)`
            : "Open Antigravity Swarm Board",
          label: swarmLive ? "Swarm · Live" : "Swarm",
          icon: "Network",
          visible: Boolean(existingSwarm),
          behavior: {
            kind: "action",
            onPress() {
              const info = workspaceSwarmPresence.get(workspaceId);
              requestOpenSwarmWorkspacePanel({
                tab: "swarm",
                conversationId: info?.swarmId,
                workspaceId,
              });
              client.openPanel("swarm-panel", { workspaceId, location: "workspace" });
            },
          },
        },
      }),
    );
  };

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries, subscription }) => {
      for (const ws of entries) registerWorkspaceHeader(ws);
      subscription.subscribe({
        snapshot: ({ entries: nextEntries }) => {
          for (const ws of nextEntries) registerWorkspaceHeader(ws);
          scheduleCommandCenterProjectsSync();
        },
        update: (msg) => {
          if (msg.type === "workspace_update" && msg.payload.kind === "upsert") {
            registerWorkspaceHeader(msg.payload.workspace);
          }
          scheduleCommandCenterProjectsSync();
        },
      });
      return undefined;
    })
    .catch(() => {});

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) {
            if (agent.workspaceId) registerWorkspaceHeader({ id: agent.workspaceId });
          }
        },
        update: (msg) => {
          if (
            msg.type === "agent_update" &&
            msg.payload.kind === "upsert" &&
            msg.payload.agent.workspaceId
          ) {
            registerWorkspaceHeader({ id: msg.payload.agent.workspaceId });
          }
        },
      });
      return undefined;
    })
    .catch(() => {});

  // 8. Extend Native Tab Context Menus In-Place + Chat File Link Menu + Option+Click + ⌘⇧R + Double-Click Inline Rename + F2 / ⌘⇧E / ⌘⇧L
  const cleanupWebHelpers = installDesktopRevealHelpers({
    isEnabled: () => true,
    getLocale: () => client.i18n.locale,
    getFallbackWorkspaceId: () => lastKnownWorkspaceId,
    onOpenTarget: async (
      path: string,
      target: OpenerTarget,
      explicitWorkspaceId?: string,
      projectNameHint?: string,
    ) => {
      const win = getWebWindow();
      const doc = win?.document ?? null;
      const activeWsId =
        explicitWorkspaceId ??
        (doc ? resolveCurrentActiveWorkspaceId(doc, win, lastKnownWorkspaceId) : undefined) ??
        lastKnownWorkspaceId;
      await client.rpc(openFileTargetRpc, {
        workspaceId: activeWsId,
        projectName: projectNameHint,
        path,
        target,
      });
    },
    onCopyPath: async (path: string) => {
      await copyText(path);
    },
    onFetchThreadMetadata: async (explicitWorkspaceId?: string) => {
      const res = await client.rpc(manageWorkspaceLabelsRpc, {
        action: "inspect",
        workspaceId: explicitWorkspaceId ?? lastKnownWorkspaceId,
      });
      if (!res.ok) return null;
      lastKnownWorkspaceId = res.workspaceId || lastKnownWorkspaceId;
      return {
        workspaceId: res.workspaceId,
        workspaceTitle: res.workspaceTitle,
        assignedLabels: res.assignedLabels,
        catalog: res.catalog,
      };
    },
    onRenameThread: async (
      newTitle: string | null,
      options?: {
        workspaceId?: string;
        agentId?: string;
        source?:
          | "inline-sidebar"
          | "inline-header"
          | "inline-tab"
          | "f2-inline"
          | "slash-command"
          | "mark-done-shortcut"
          | "ui"
          | "agent-tool";
      },
    ) => {
      const targetWsId = options?.workspaceId ?? lastKnownWorkspaceId;
      if (newTitle) {
        const win = getWebWindow();
        const doc = win?.document ?? null;
        if (doc) {
          synchronizeWorkspaceTitleDom(doc, win, targetWsId, newTitle);
        }
      }
      const writeKey = targetWsId ?? `agent:${options?.agentId ?? ""}`;
      await workspaceTitleWrites.run(writeKey, async () => {
        if (targetWsId && !options?.agentId) {
          try {
            await client.paseo.workspaces.ref(targetWsId).setTitle(newTitle);
          } catch {
            // Fallback to RPC
          }
        }
        await client.rpc(renameWorkspaceOrAgentRpc, {
          workspaceId: targetWsId,
          agentId: options?.agentId,
          title: newTitle,
          source: options?.source,
        });
      });
    },
    onToggleLabel: async (
      labelName: string,
      color?: WorkspaceLabelColor,
      explicitWorkspaceId?: string,
    ) => {
      const res = await client.rpc(manageWorkspaceLabelsRpc, {
        action: "toggle",
        workspaceId: explicitWorkspaceId ?? lastKnownWorkspaceId,
        labelName,
        color,
      });
      if (!res.ok) return null;
      return {
        workspaceId: res.workspaceId,
        workspaceTitle: res.workspaceTitle,
        assignedLabels: res.assignedLabels,
        catalog: res.catalog,
      };
    },
    onDeleteLabel: async (
      labelName: string,
      explicitWorkspaceId?: string,
    ) => {
      const res = await client.rpc(manageWorkspaceLabelsRpc, {
        action: "delete",
        workspaceId: explicitWorkspaceId ?? lastKnownWorkspaceId,
        labelName,
      });
      if (!res.ok) return null;
      return {
        workspaceId: res.workspaceId,
        workspaceTitle: res.workspaceTitle,
        assignedLabels: res.assignedLabels,
        catalog: res.catalog,
      };
    },
    onDropFolders: async (paths: string[], options: { forceNew: boolean }) => {
      const res = await client.rpc(importFolderWorkspaceRpc, {
        paths,
        ...(options.forceNew ? { mode: "always-create" as const } : {}),
        source: "sidebar-drop",
      });
      if (res.disabled) {
        return null;
      }
      if (res.ok && res.primaryWorkspaceId) {
        lastKnownWorkspaceId = res.primaryWorkspaceId;
      }
      return {
        ok: res.ok,
        primaryWorkspaceId: res.primaryWorkspaceId,
        primaryProjectId: res.primaryProjectId,
        primaryWorkspaceName: res.primaryWorkspaceName,
        createdCount: res.createdCount,
        reusedCount: res.reusedCount,
        message: res.message,
      };
    },
    onListJumpProjects: async (query?: string) => {
      const res = await client.rpc(quickJumpWorkspaceRpc, {
        action: "list",
        query,
        limit: 50,
        source: "quick-switcher",
      });
      updateWorkspaceProjectCache(res.candidates);
      return res.candidates;
    },
    onResolveWorkspaceProject: async (workspaceId: string) => {
      const cached = workspaceToProjectMap.get(workspaceId);
      if (cached) return cached;
      const res = await client
        .rpc(quickJumpWorkspaceRpc, {
          action: "list",
          limit: 100,
          source: "command-center",
        })
        .catch(() => null);
      if (res?.candidates) {
        updateWorkspaceProjectCache(res.candidates);
      }
      return workspaceToProjectMap.get(workspaceId) ?? null;
    },
    onExecuteQuickJump: async (input: {
      projectId?: string;
      query?: string;
      jumpMode?: QuickJumpAction;
      source?: "quick-switcher";
    }) => {
      const res = await client.rpc(quickJumpWorkspaceRpc, {
        action: "jump",
        projectId: input.projectId,
        query: input.query,
        jumpMode: input.jumpMode,
        source: input.source ?? "quick-switcher",
      });
      if (res.ok && res.targetWorkspaceId) {
        lastKnownWorkspaceId = res.targetWorkspaceId;
      }
      return {
        ok: res.ok,
        jumpMode: res.jumpMode,
        targetWorkspaceId: res.targetWorkspaceId,
        targetProjectId: res.targetProjectId,
        targetProjectKey: res.targetProjectKey,
        targetProjectName: res.targetProjectName,
        message: res.message,
      };
    },
    onHealAgentHistory: async (workspaceId?: string) => {
      const res = await client.rpc(manageAgentHistoryRpc, {
        action: "heal",
        workspaceId: workspaceId ?? lastKnownWorkspaceId,
        source: "timeline-banner",
      });
      return {
        ok: res.ok,
        message: res.message,
      };
    },
    onArchiveWorkspace: async (workspaceId?: string) => {
      const targetWsId = workspaceId ?? lastKnownWorkspaceId;
      if (targetWsId) {
        try {
          await client.paseo.workspaces.ref(targetWsId).archive();
          return { ok: true, workspaceId: targetWsId };
        } catch {
          try {
            const res = await client.rpc(archiveWorkspaceRpc, { workspaceId: targetWsId });
            return { ok: res.ok, workspaceId: targetWsId };
          } catch {
            return { ok: false, workspaceId: targetWsId };
          }
        }
      }
      return { ok: false };
    },
    onToggleWorkspacePin: async (workspaceId?: string, pinned?: boolean) => {
      const targetWsId = workspaceId ?? lastKnownWorkspaceId;
      try {
        const res = await client.rpc(toggleWorkspacePinRpc, {
          workspaceId: targetWsId,
          pinned,
        });
        return {
          ok: res.ok,
          workspaceId: res.workspaceId,
          pinned: res.pinned,
          message: res.message,
        };
      } catch (err) {
        return {
          ok: false,
          workspaceId: targetWsId ?? "",
          pinned: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const cleanupScheduleRunsEnhancer = installDesktopScheduleRunsEnhancer({
    call: (def, input) => client.rpc(def as never, input as never) as never,
  });

  const cleanupVoiceSttEnhancer = installDesktopVoiceSttEnhancer({
    call: (def, input) => client.rpc(def, input),
    getLocale: () => client.i18n.locale,
  });

  const cleanupModelQuickSwitch = installModelQuickSwitch();

  const cleanupProjectPickerShortcut = installProjectPickerShortcut();
  const cleanupSidebarGroupingShortcut = installSidebarGroupingShortcut();
  void client
    .rpc(settingsRpc(pluginSettings.id).read, {})
    .then((res) => {
      if (res.status === "ready" && !lifetime.signal.aborted) {
        const v = res.values as Record<string, unknown>;
        syncInlineRenamePreferences({
          enableQuickRenameAndLabelShortcuts:
            typeof v.enableQuickRenameAndLabelShortcuts === "boolean"
              ? v.enableQuickRenameAndLabelShortcuts
              : undefined,
          enableLabelNumberShortcuts:
            typeof v.enableLabelNumberShortcuts === "boolean"
              ? v.enableLabelNumberShortcuts
              : undefined,
          labelNumberShortcutMode:
            v.labelNumberShortcutMode === "modifier-only" ||
            v.labelNumberShortcutMode === "empty-input"
              ? v.labelNumberShortcutMode
              : undefined,
          labelShortcutCombo:
            v.labelShortcutCombo === "cmd_l" ||
            v.labelShortcutCombo === "cmd_shift_l" ||
            v.labelShortcutCombo === "both"
              ? v.labelShortcutCombo
              : undefined,
        });
        syncProjectPickerShortcutPrefs({
          enabled: typeof v.enableProjectPickerShortcut === "boolean" ? v.enableProjectPickerShortcut : undefined,
          preset:
            typeof v.projectPickerShortcutPreset === "string"
              ? (v.projectPickerShortcutPreset as ProjectPickerShortcutPreset)
              : undefined,
          customShortcut:
            typeof v.projectPickerCustomShortcut === "string"
              ? v.projectPickerCustomShortcut
              : undefined,
        });
        syncSidebarGroupingShortcutPrefs({
          enabled:
            typeof v.enableSidebarGroupingShortcuts === "boolean"
              ? v.enableSidebarGroupingShortcuts
              : undefined,
          preset:
            typeof v.sidebarGroupingPreset === "string"
              ? (v.sidebarGroupingPreset as SidebarGroupingPreset)
              : undefined,
          projectShortcut:
            typeof v.sidebarGroupingProjectShortcut === "string"
              ? v.sidebarGroupingProjectShortcut
              : undefined,
          statusShortcut:
            typeof v.sidebarGroupingStatusShortcut === "string"
              ? v.sidebarGroupingStatusShortcut
              : undefined,
          toggleOnRePress:
            typeof v.sidebarGroupingToggleOnRePress === "boolean"
              ? v.sidebarGroupingToggleOnRePress
              : undefined,
        });
        syncPinPrefixPrefs({
          enabled:
            typeof v.enablePinTitlePrefix === "boolean"
              ? v.enablePinTitlePrefix
              : undefined,
          prefix:
            typeof v.pinTitlePrefix === "string"
              ? v.pinTitlePrefix
              : undefined,
        });
        syncQuotaQueuePrefs({
          enabled:
            typeof v.enableQuotaQueueGuard === "boolean"
              ? v.enableQuotaQueueGuard
              : undefined,
          autoDrain:
            typeof v.quotaQueueAutoDrain === "boolean"
              ? v.quotaQueueAutoDrain
              : undefined,
        });
      }
    })
    .catch(() => {});

  const cleanupPinTitlePrefixSync = installPinTitlePrefixSync({
    win: getWebWindow() as Window | null,
    onApplyTitle: async (ctx) => {
      const win = getWebWindow();
      const doc = win?.document ?? null;
      if (doc && ctx.nextTitle) {
        synchronizeWorkspaceTitleDom(doc, win, ctx.workspaceId, ctx.nextTitle);
      }
      await workspaceTitleWrites.run(ctx.workspaceId, async () => {
        let updated = false;
        try {
          const hostApi = ctx.serverId ? getPaseoClient(ctx.serverId) : client.paseo;
          await hostApi.workspaces.ref(ctx.workspaceId).setTitle(ctx.nextTitle);
          updated = true;
        } catch {
          try {
            await client.paseo.workspaces.ref(ctx.workspaceId).setTitle(ctx.nextTitle);
            updated = true;
          } catch {
            // Fallback to RPC below
          }
        }
        if (!updated) {
          await client.rpc(renameWorkspaceOrAgentRpc, {
            workspaceId: ctx.workspaceId,
            title: ctx.nextTitle,
            source: "pin-prefix",
          });
        }
      });
    },
  });

  const cleanupSidebarDefaultCollapse = installSidebarDefaultCollapse();

  const cleanupSidebarChildSessions = installSidebarChildSessions();

  const cleanupSettingsSearch = installSettingsSearch({ getLocale: () => client.i18n.locale });

  const cleanupSmartClipboardCopy = installSmartClipboardCopy();

  const cleanupMarkdownTableEnhancer = registerMarkdownTableEnhancer();

  const cleanupMermaidEnhancer = installMermaidEnhancer({ getLocale: () => client.i18n.locale });

  const cleanupSessionTimeEnhancer = installDesktopSessionTimeEnhancer();

  const cleanupQuoteReply = installQuoteReply({ getLocale: () => client.i18n.locale });

  const cleanupCommitOriginPills = installCommitOriginPills({
    call: (def, input) => client.rpc(def as never, input as never) as never,
    getLocale: () => client.i18n.locale,
  });

  const cleanupSessionRefText = installSessionRefText({ getLocale: () => client.i18n.locale });

  const cleanupSubagentsTreeEnhancer = installDesktopSubagentsTreeEnhancer({
    call: (def, input) => client.rpc(def as never, input as never) as never,
    getLocale: () => client.i18n.locale,
  });

  const cleanupSessionLineageEnhancer = installDesktopSessionLineageEnhancer({
    call: (def, input) => client.rpc(def as never, input as never) as never,
    getLocale: () => client.i18n.locale,
  });

  const cleanupDocPreviewEnhancer = installDesktopDocPreviewEnhancer({
    getLocale: () => client.i18n.locale,
  });

  const cleanupCompactionAndContextEnhancer = installCompactionAndContextEnhancer({
    call: (def, input) => client.rpc(def, input),
    getLocale: () => client.i18n.locale,
  });

  const cleanupIntakeDecisionsEnhancer = installIntakeDecisionsEnhancer(
    getWebWindow(),
    (input) => client.rpc(manageIntakeDecisionsRpc, input),
  );

  const cleanupQuotaQueueGuard = installQuotaQueueGuard({
    win: getWebWindow() as Window | null,
    rpcCall: (input) => client.rpc(manageQuotaQueueRpc, input),
    getLocale: () => client.i18n.locale,
  });

  const unsubscribeSwarmPresence = subscribeWorkspaceSwarmPresence((presence) => {
    if (!presence.workspaceId) return;
    workspaceSwarmPresence.set(presence.workspaceId, presence);
    updateSwarmHeaderButton(presence.workspaceId);
  });

  void client
    .rpc(inspectSwarmWorkflowRpc, { action: "list_swarms", limit: 40 })
    .then((res) => {
      if (lifetime.signal.aborted) return;
      for (const sw of res.swarms) {
        if (!sw.paseoWorkspaceId) continue;
        workspaceSwarmPresence.set(sw.paseoWorkspaceId, {
          workspaceId: sw.paseoWorkspaceId,
          swarmId: sw.swarmId,
          title: sw.title,
          memberCount: sw.memberCount,
          activeCount: sw.activeCount,
          postCount: sw.postCount,
        });
        updateSwarmHeaderButton(sw.paseoWorkspaceId);
      }
    })
    .catch(() => {});

  const cleanupSwarmWorkflowBridge = installSwarmWorkflowDesktopBridge({
    onOpenSwarmPanel: (req) => {
      const win = getWebWindow();
      const targetWsId =
        req?.workspaceId ??
        (win?.document ? resolveCurrentActiveWorkspaceId(win.document, win, lastKnownWorkspaceId) : undefined) ??
        lastKnownWorkspaceId;
      if (targetWsId) {
        client.openPanel("swarm-panel", { workspaceId: targetWsId, location: "workspace" });
      }
    },
    onOpenFile: (filePath) => {
      void client.rpc(openFileTargetRpc, {
        path: filePath,
        target: "system-default",
      });
    },
  });

  client.addCommandCenterItem({
    id: "refresh-context-window-meter",
    title: "Finder: Refresh Context Window Meter",
    icon: "Gauge",
    keywords: ["context", "compact", "tokens", "meter", "window", "usage"],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      const res = await rpc(inspectAntigravityContextRpc, {
        workspaceId: workspace.id,
        includeCompactionHistory: true,
      });
      const ctl = (globalThis as { __paseoFinderCompactionContext?: { refreshNow?: (ids?: string[]) => Promise<number> } })
        .__paseoFinderCompactionContext;
      if (ctl?.refreshNow && res.items.length > 0) {
        await ctl.refreshNow(res.items.map((i) => i.agentId));
      }
    },
  });

  client.addSlashCommand({
    name: "context-window",
    description: "Refresh live ContextWindowMeter and inspect /compact compaction telemetry",
    argumentHint: "",
    context: "workspace",
    async onSubmit({ workspace, rpc }) {
      const res = await rpc(inspectAntigravityContextRpc, {
        workspaceId: workspace.id,
        includeCompactionHistory: true,
      });
      const ctl = (globalThis as { __paseoFinderCompactionContext?: { refreshNow?: (ids?: string[]) => Promise<number> } })
        .__paseoFinderCompactionContext;
      if (ctl?.refreshNow && res.items.length > 0) {
        await ctl.refreshNow(res.items.map((i) => i.agentId));
      }
    },
  });

  client.addCommandCenterItem({
    id: "preview-latest-document",
    title: "Finder: Preview Latest Workspace Document",
    icon: "FileText",
    keywords: ["pdf", "docx", "xlsx", "pptx", "document", "preview", "compare"],
    context: "workspace",
    async onSelect({ workspace, rpc }) {
      const res = await rpc(listSiblingDocumentsRpc, {
        workspaceId: workspace.id,
        workspaceRoot: workspace.directory ?? undefined,
        limit: 4,
      });
      const first = res.items[0];
      if (first) {
        openWorkspaceFileTabsInSidePane(workspace.id, [first.relativePath || first.absolutePath]);
      }
    },
  });

  client.addSlashCommand({
    name: "preview-doc",
    description: "Open one or more PDF / Office documents in Paseo's side preview pane",
    argumentHint: "<path> [second-path ...]",
    context: "workspace",
    async onSubmit({ args, workspace, rpc }) {
      const tokens = args
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (tokens.length > 0) {
        openWorkspaceFileTabsInSidePane(workspace.id, tokens);
        return;
      }
      const res = await rpc(listSiblingDocumentsRpc, {
        workspaceId: workspace.id,
        workspaceRoot: workspace.directory ?? undefined,
        limit: 2,
      });
      const paths = res.items.slice(0, 2).map((i) => i.relativePath || i.absolutePath);
      if (paths.length > 0) {
        openWorkspaceFileTabsInSidePane(workspace.id, paths);
      }
    },
  });

  client.addCommandCenterItem({
    id: "group-sidebar-by-project",
    title: pluginTranslations.message("commands.groupByProject"),
    icon: "Folder",
    keywords: ["group", "grouping", "project", "sidebar", "shortcut"],
    context: "global",
    onSelect() {
      switchSidebarGrouping("project", { trigger: "project" });
    },
  });

  client.addCommandCenterItem({
    id: "group-sidebar-by-status",
    title: pluginTranslations.message("commands.groupByStatus"),
    icon: "CircleDashed",
    keywords: ["group", "grouping", "status", "sidebar", "shortcut"],
    context: "global",
    onSelect() {
      switchSidebarGrouping("status", { trigger: "status" });
    },
  });

  client.addCommandCenterItem({
    id: "toggle-sidebar-grouping",
    title: pluginTranslations.message("commands.toggleSidebarGrouping"),
    icon: "ArrowLeftRight",
    keywords: ["group", "grouping", "toggle", "project", "status", "sidebar"],
    context: "global",
    onSelect() {
      switchSidebarGrouping("toggle", { trigger: "toggle" });
    },
  });

  client.addSlashCommand({
    name: "group",
    description: pluginTranslations.message("commands.groupSlashDescription"),
    argumentHint: pluginTranslations.message("commands.groupSlashHint"),
    context: "workspace",
    onSubmit({ args }) {
      const normalized = args.trim().toLowerCase();
      if (normalized === "project" || normalized === "p" || normalized === "proj") {
        switchSidebarGrouping("project", { trigger: "project" });
      } else if (normalized === "status" || normalized === "s" || normalized === "stat") {
        switchSidebarGrouping("status", { trigger: "status" });
      } else {
        switchSidebarGrouping("toggle", { trigger: "toggle" });
      }
    },
  });

  client.addCommandCenterItem({
    id: "open-intake-decisions",
    title: pluginTranslations.message("commands.openIntakeDecisions"),
    icon: "CheckSquare",
    keywords: ["decision", "decisions", "approve", "blocked", "intake", "queue", "resume"],
    context: "global",
    onSelect({ rpc }) {
      void openIntakeDecisionsDrawer((input) => rpc(manageIntakeDecisionsRpc, input));
    },
  });

  client.addSlashCommand({
    name: "decisions",
    description: pluginTranslations.message("commands.decisionsSlashDescription"),
    argumentHint: pluginTranslations.message("commands.decisionsSlashHint"),
    context: "workspace",
    onSubmit({ args, rpc }) {
      const taskQuery = args.trim() || undefined;
      void openIntakeDecisionsDrawer(
        (input) => rpc(manageIntakeDecisionsRpc, input),
        taskQuery,
      );
    },
  });

  client.addCommandCenterItem({
    id: "sync-harness-model-catalogs",
    title: "Models: Sync & Live-Refresh Latest Models Across All Harnesses",
    icon: "RefreshCw",
    keywords: [
      "models",
      "catalog",
      "sync",
      "hydrogen",
      "gemini",
      "claude",
      "codex",
      "cursor",
      "模型",
      "同步",
      "刷新模型",
    ],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(manageHarnessCatalogsRpc, { action: "sync" });
    },
  });

  client.addSlashCommand({
    name: "sync-models",
    description:
      "Discover and live-refresh latest models and profiles across all Paseo harnesses without restarting (/sync-models [status|sync|refresh])",
    argumentHint: "[status | sync | refresh]",
    context: "workspace",
    async onSubmit({ args, rpc }) {
      const raw = args.trim().toLowerCase();
      const action = raw === "status" ? "status" : raw === "refresh" ? "refresh" : "sync";
      await rpc(manageHarnessCatalogsRpc, { action });
    },
  });

  client.addCommandCenterItem({
    id: "sync-pin-prefixes",
    title: pluginTranslations.message("commands.syncPinPrefixes"),
    icon: "Pin",
    keywords: ["pin", "prefix", "title", "pinned", "置顶", "前缀"],
    context: "global",
    async onSelect() {
      await reconcileAllPinnedNow();
    },
  });

  client.addCommandCenterItem({
    id: "inspect-quota-queue",
    title: pluginTranslations.message("commands.inspectQuotaQueue"),
    icon: "Clock",
    keywords: ["quota", "queue", "429", "cooldown", "rate limit", "排队", "配额"],
    context: "global",
    async onSelect({ rpc }) {
      const res = await rpc(manageQuotaQueueRpc, {
        action: "status",
        source: "command-center",
      });
      const win = getWebWindow();
      if (win?.document) showFinderNoticeToast(win.document, win, res.message, !res.ok);
    },
  });

  client.addSlashCommand({
    name: "quota-queue",
    description: pluginTranslations.message("commands.quotaQueueSlashDescription"),
    argumentHint: "[status | check | drain | release | reset]",
    context: "workspace",
    async onSubmit({ args, rpc }) {
      const raw = args.trim().toLowerCase();
      const action =
        raw === "check"
          ? "check"
          : raw === "drain"
            ? "drain_one"
            : raw === "release"
              ? "release"
              : raw === "reset"
                ? "reset"
                : "status";
      const res = await rpc(manageQuotaQueueRpc, {
        action,
        triggerRecoveryIfReady: action === "check" || action === "drain_one",
        source: "slash-command",
      });
      const win = getWebWindow();
      if (win?.document) showFinderNoticeToast(win.document, win, res.message, !res.ok);
    },
  });

  client.addSlashCommand({
    name: "swarm-board",
    description: "Open the live Antigravity Native Swarm Board (Overview · Board · Members · Graph · Hive)",
    argumentHint: "[conversationId]",
    context: "workspace",
    onSubmit({ args, openPanel }) {
      const cid = args.trim() || undefined;
      requestOpenSwarmWorkspacePanel({ tab: "swarm", conversationId: cid });
      openPanel("swarm-panel", { location: "workspace" });
    },
  });

  client.addSlashCommand({
    name: "workflows",
    description: "Open the Antigravity Run-Workflow Inspector (Phases · Logs · Child Agents)",
    argumentHint: "[conversationId]",
    context: "workspace",
    onSubmit({ args, openPanel }) {
      const cid = args.trim() || undefined;
      requestOpenSwarmWorkspacePanel({ tab: "workflows", conversationId: cid });
      openPanel("swarm-panel", { location: "workspace" });
    },
  });

  return () => {
    lifetime.abort();
    if (syncProjectsTimer) {
      clearTimeout(syncProjectsTimer);
    }
    clearProjectCommandItems();
    cleanupWebHelpers();
    cleanupScheduleRunsEnhancer();
    cleanupVoiceSttEnhancer();
    cleanupModelQuickSwitch();
    cleanupProjectPickerShortcut();
    cleanupSidebarGroupingShortcut();
    cleanupSidebarDefaultCollapse();
    cleanupSidebarChildSessions();
    cleanupSettingsSearch();
    cleanupSmartClipboardCopy();
    cleanupMarkdownTableEnhancer();
    cleanupMermaidEnhancer();
    cleanupSessionTimeEnhancer();
    cleanupQuoteReply();
    cleanupCommitOriginPills();
    cleanupSessionRefText();
    cleanupSubagentsTreeEnhancer();
    cleanupSessionLineageEnhancer();
    cleanupDocPreviewEnhancer();
    cleanupCompactionAndContextEnhancer();
    cleanupIntakeDecisionsEnhancer();
    cleanupQuotaQueueGuard();
    cleanupSwarmWorkflowBridge();
    unsubscribeSwarmPresence();
    uninstallSwarmLiveCard();
    cleanupPinTitlePrefixSync();
    for (const btn of headerButtons.values()) btn.remove();
    headerButtons.clear();
    for (const btn of forkButtons.values()) btn.remove();
    forkButtons.clear();
    for (const btn of swarmButtons.values()) btn.remove();
    swarmButtons.clear();
  };
}
