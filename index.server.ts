import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  OpenerTargetSchema,
  QuickJumpActionSchema,
  SidebarDropBehaviorSchema,
  WorkspaceLabelColorSchema,
  diagnosePathRpc,
  importFolderWorkspaceRpc,
  inspectFileRpc,
  listWorkspaceMediaRpc,
  manageWorkspaceLabelsRpc,
  openFileTargetRpc,
  pluginSettings,
  quickJumpWorkspaceRpc,
  renameWorkspaceOrAgentRpc,
  archiveWorkspaceRpc,
  toggleWorkspacePinRpc,
  managePinPrefixRpc,
  inspectScheduleRunsRpc,
  openScheduleRunSessionRpc,
  manageVoiceSttRpc,
  manageAgentHistoryRpc,
  manageHarnessCatalogsRpc,
  managePeerAgentsRpc,
  manageRelayHealthRpc,
  manageSessionLineageRpc,
  manageSlashSkillsRpc,
  manageSubagentsRpc,
  manageWritebackHookRpc,
  reconcilePaseoRecoveryRpc,
  forkSessionRpc,
  inspectSystemPromptRpc,
} from "./shared/contracts";
import { handleForkSession } from "./server/fork-session-handlers";
import { handleInspectSystemPrompt } from "./server/system-prompt-handlers";
import { inspectSwarmWorkflowRpc } from "./shared/swarm-workflow-contracts";
import {
  disposeSwarmBoardBridge,
  handleInspectSwarmWorkflow,
} from "./server/swarm-workflow-handlers";
import {
  handleArchiveWorkspace,
  handleToggleWorkspacePin,
  handleManagePinPrefix,
  handleDiagnosePath,
  handleImportFolderWorkspace,
  handleInspectFile,
  handleListWorkspaceMedia,
  handleManageAgentHistory,
  handleManageHarnessCatalogs,
  handleManagePeerAgents,
  handleManageRelayHealth,
  handleManageSessionLineage,
  handleManageSlashSkills,
  handleManageSubagents,
  handleManageVoiceStt,
  handleManageWorkspaceLabels,
  handleManageWritebackHook,
  handleOpenFileTarget,
  handleQuickJumpWorkspace,
  handleReconcilePaseoRecovery,
  handleRenameThread,
} from "./server/handlers";
import {
  buildSettingsPath,
  searchSettingsIndex,
  settingsResultBreadcrumb,
} from "./shared/settings-search";
import { SETTINGS_SEARCH_SEED } from "./shared/settings-search-seed";
import {
  handleInspectScheduleRuns,
  handleOpenScheduleRunSession,
} from "./server/schedule-runs-handlers";
import {
  LINK_RETITLE_CONFIG_PATH,
  LINK_RETITLE_LEDGER_PATH,
  findBackfillCandidates,
  loadLinkRetitleConfig,
  readLinkRetitleLedger,
  runLinkFirstRetitle,
  runLinkRetitleBackfill,
} from "./server/link-first-retitle";
import { handleResolveCommitOrigin } from "./server/commit-origin";
import { resolveCommitOriginRpc } from "./shared/commit-origin-contracts";
import {
  diagnoseDocPreviewRpc,
  listSiblingDocumentsRpc,
  previewDocumentRpc,
} from "./shared/doc-preview-contracts";
import {
  handleDiagnoseDocPreview,
  handleListSiblingDocuments,
  handlePreviewDocument,
} from "./server/doc-preview-handlers";
import { inspectAntigravityContextRpc } from "./shared/compaction-context-contracts";
import { handleInspectAntigravityContext } from "./server/compaction-context-handlers";
import { manageIntakeDecisionsRpc } from "./shared/intake-decisions-contracts";
import { handleManageIntakeDecisions } from "./server/intake-decisions-handlers";
import { manageQuotaQueueRpc } from "./shared/quota-queue-contracts";
import { handleManageQuotaQueue } from "./server/quota-queue-handlers";
import { withRpcTiming } from "./server/rpc-timing";

export default function contribute(rawServer: PluginServerContext) {
  // Slow RPCs are logged with their method name (server/rpc-timing.ts).
  const server = withRpcTiming(rawServer);
  const settingsHandle = server.registerSettings(pluginSettings);

  server.handle(inspectFileRpc, handleInspectFile);
  server.handle(inspectAntigravityContextRpc, (input) => handleInspectAntigravityContext(input));
  server.handle(manageIntakeDecisionsRpc, (input) => handleManageIntakeDecisions(input));
  server.handle(manageQuotaQueueRpc, (input, context) => handleManageQuotaQueue(input, context));
  server.handle(previewDocumentRpc, handlePreviewDocument);
  server.handle(listSiblingDocumentsRpc, handleListSiblingDocuments);
  server.handle(diagnoseDocPreviewRpc, handleDiagnoseDocPreview);
  server.handle(openFileTargetRpc, handleOpenFileTarget);
  server.handle(listWorkspaceMediaRpc, handleListWorkspaceMedia);
  server.handle(diagnosePathRpc, handleDiagnosePath);
  server.handle(renameWorkspaceOrAgentRpc, handleRenameThread);
  server.handle(archiveWorkspaceRpc, handleArchiveWorkspace);
  server.handle(toggleWorkspacePinRpc, handleToggleWorkspacePin);
  server.handle(managePinPrefixRpc, (input, context) =>
    handleManagePinPrefix(input, context, {
      readSettings: () => settingsHandle.read(),
    }),
  );
  server.handle(manageWorkspaceLabelsRpc, handleManageWorkspaceLabels);
  server.handle(importFolderWorkspaceRpc, (input, context) =>
    handleImportFolderWorkspace(input, context, {
      readSettings: () => settingsHandle.read(),
    }),
  );
  server.handle(quickJumpWorkspaceRpc, (input, context) =>
    handleQuickJumpWorkspace(input, context, {
      readSettings: () => settingsHandle.read(),
    }),
  );
  server.handle(inspectScheduleRunsRpc, handleInspectScheduleRuns);
  server.handle(openScheduleRunSessionRpc, handleOpenScheduleRunSession);
  server.handle(manageVoiceSttRpc, handleManageVoiceStt);
  server.handle(manageAgentHistoryRpc, handleManageAgentHistory);
  server.handle(manageSessionLineageRpc, handleManageSessionLineage);
  server.handle(manageSlashSkillsRpc, handleManageSlashSkills);
  server.handle(manageSubagentsRpc, handleManageSubagents);
  server.handle(manageWritebackHookRpc, handleManageWritebackHook);
  server.handle(reconcilePaseoRecoveryRpc, handleReconcilePaseoRecovery);
  server.handle(managePeerAgentsRpc, handleManagePeerAgents);
  server.handle(manageRelayHealthRpc, handleManageRelayHealth);
  server.handle(manageHarnessCatalogsRpc, handleManageHarnessCatalogs);
  server.handle(forkSessionRpc, handleForkSession);
  server.handle(inspectSwarmWorkflowRpc, (input, context) =>
    handleInspectSwarmWorkflow(input, context),
  );
  server.handle(resolveCommitOriginRpc, (input) => handleResolveCommitOrigin(input));
  server.handle(inspectSystemPromptRpc, handleInspectSystemPrompt);

  // Same resolver as the inline commit pill (client/commit-origin-web.ts).
  const commitOriginTool = defineAgentTool({
    name: "resolve_commit_origin",
    title: "Find the Session That Made a Commit",
    description:
      "Given git commit hashes (7-40 hex), find which Paseo session made each one. Searches the repositories Paseo sessions work in, " +
      "then the transcripts of sessions active at commit time: the session whose first mention of the hash falls 10 min before to " +
      "3 min after the commit time, earliest first, made it. Returns repo, subject, origin session (id, title, status) and the evidence. Read-only.",
    input: z.object({
      shas: z.array(z.string()).min(1).max(40).describe("Commit hashes, short or full"),
      refresh: z.boolean().optional().describe("Skip the cache and rescan repositories"),
    }),
    async execute(input) {
      const result = await handleResolveCommitOrigin({
        shas: input.shas,
        refresh: input.refresh,
        source: "agent-tool",
      });
      return { text: JSON.stringify(result, null, 2), structuredContent: result, isError: !result.ok };
    },
  });

  const revealTool = defineAgentTool({
    name: "reveal_in_finder",
    title: "Reveal File or Folder in Finder",
    description:
      "Reveal a file, image, or directory in macOS Finder (open -R) or open it in Preview/Antigravity/Cursor.",
    input: z.object({
      path: z.string().describe("Relative or absolute path to the file or directory"),
      target: OpenerTargetSchema.optional().describe(
        "Target opener: finder-reveal (default), finder-folder, system-preview, antigravity, cursor",
      ),
    }),
    async execute(input, { agent, paseo }) {
      const result = await handleOpenFileTarget(
        {
          workspaceId: agent.workspaceId ?? undefined,
          workspaceRoot: agent.cwd ?? undefined,
          path: input.path,
          target: input.target ?? "finder-reveal",
        },
        { paseo },
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const threadMetaTool = defineAgentTool({
    name: "manage_thread_metadata",
    title: "Rename Workspace / Thread or Manage Labels",
    description:
      "Rename the active Paseo workspace/thread title or inspect/assign/toggle/update workspace labels. " +
      "If the user's first message was only a link (Slack, Notion, GitHub, a doc), set the title to the real agenda once you have read it, so the sidebar names the task instead of the link.",
    input: z.object({
      title: z
        .string()
        .optional()
        .describe("Optional new workspace/thread title (pass 'clear' to reset custom title)"),
      labelAction: z
        .enum(["inspect", "toggle", "assign", "unassign", "update", "delete"])
        .optional()
        .describe("Label operation to perform"),
      labelName: z.string().optional().describe("Label name (e.g. '⭐️', 'feat', '🤔', '⚒️')"),
      newLabelName: z.string().optional().describe("New label name when labelAction is 'update'"),
      labelColor: WorkspaceLabelColorSchema.optional().describe(
        "Label color: violet, sky, emerald, orange, pink, indigo, teal, red, amber, blue",
      ),
    }),
    async execute(input, { agent, paseo }) {
      const results: Record<string, unknown> = {};
      let hasError = false;
      if (input.title !== undefined) {
        const renameRes = await handleRenameThread(
          {
            workspaceId: agent.workspaceId ?? undefined,
            agentId: agent.id,
            title: input.title,
          },
          { paseo } as never,
        );
        results.rename = renameRes;
        if (!renameRes.ok) hasError = true;
      }
      if (input.labelAction || input.labelName) {
        const labelRes = await handleManageWorkspaceLabels(
          {
            action: input.labelAction ?? (input.labelName ? "toggle" : "inspect"),
            workspaceId: agent.workspaceId ?? undefined,
            labelName: input.labelName,
            newName: input.newLabelName,
            color: input.labelColor,
          },
          { paseo } as never,
        );
        results.labels = labelRes;
        if (!labelRes.ok) hasError = true;
      }
      return {
        text: JSON.stringify(results, null, 2),
        structuredContent: results,
        isError: hasError,
      };
    },
  });

  const importFolderTool = defineAgentTool({
    name: "import_folder_workspace",
    title: "Import or Open Folder as Paseo Workspace",
    description:
      "Register and open one or more local folders as Paseo workspaces if they do not yet exist (or reuse existing active workspaces without duplication).",
    input: z.object({
      paths: z
        .array(z.string())
        .min(1)
        .describe("Absolute or ~ folder paths to register/open as Paseo workspaces"),
      mode: SidebarDropBehaviorSchema.optional().describe(
        "open-or-create (default, deduplicates existing workspaces) or always-create",
      ),
      title: z
        .string()
        .optional()
        .describe("Optional custom title when creating a new workspace"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Set true to preview whether a workspace already exists without creating one"),
    }),
    async execute(input, { paseo }) {
      const result = await handleImportFolderWorkspace(
        {
          paths: input.paths,
          mode: input.mode,
          title: input.title,
          dryRun: input.dryRun,
          source: "agent-tool",
        },
        { paseo },
        { readSettings: () => settingsHandle.read() },
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const quickJumpTool = defineAgentTool({
    name: "quick_jump_workspace",
    title: "Search or Quick-Jump to Paseo Project Workspace",
    description:
      "Search and rank Paseo project workspaces without sub-thread clutter, or resolve/open the primary workspace for a target project folder.",
    input: z.object({
      action: z
        .enum(["list", "jump"])
        .optional()
        .describe("list (rank matching project workspaces) or jump (resolve/open target project)"),
      query: z
        .string()
        .optional()
        .describe("Search query by project name, stripped date name, acronym, or path segment"),
      projectId: z.string().optional().describe("Optional explicit projectId to jump to"),
      jumpMode: QuickJumpActionSchema.optional().describe(
        "new-workspace (default), open-latest, locate-sidebar, or create-new",
      ),
      dryRun: z.boolean().optional().describe("Set true to preview resolution without creating"),
    }),
    async execute(input, { paseo }) {
      const result = await handleQuickJumpWorkspace(
        {
          action: input.action ?? (input.query || input.projectId ? "jump" : "list"),
          query: input.query,
          projectId: input.projectId,
          jumpMode: input.jumpMode,
          dryRun: input.dryRun,
          source: "agent-tool",
        },
        { paseo } as never,
        { readSettings: () => settingsHandle.read() },
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const scheduleRunsTool = defineAgentTool({
    name: "inspect_schedule_runs",
    title: "Inspect Paseo Schedule Runs & Open Run Conversation",
    description:
      "List Paseo schedule execution history (all runs across native schedules and AG standby twins), preview run conversation timelines, trigger run-now, or unarchive a completed run workspace.",
    input: z.object({
      action: z
        .enum([
          "list",
          "open-run",
          "preview-timeline",
          "run-now",
          "toggle-archive-on-finish",
          "recover-due",
          "auto-evolve",
        ])
        .optional()
        .describe(
          "list (default), open-run, preview-timeline, run-now, toggle-archive-on-finish, recover-due, or auto-evolve",
        ),
      scheduleId: z.string().optional().describe("Schedule ID (e.g. 2a8a43f9 or 85c593c3)"),
      runId: z.string().optional().describe("Specific run ID to inspect or open"),
      query: z.string().optional().describe("Filter schedules/runs by name, model, or output"),
      onlyWithRuns: z.boolean().optional().describe("Only return schedules that have recorded runs"),
      archiveOnFinish: z
        .boolean()
        .optional()
        .describe("When action is toggle-archive-on-finish, set archiveOnFinish value"),
    }),
    async execute(input, { paseo }) {
      const act = input.action ?? "list";
      if (act === "list") {
        const result = await handleInspectScheduleRuns(
          {
            scheduleId: input.scheduleId,
            query: input.query,
            onlyWithRuns: input.onlyWithRuns ?? true,
            includeWorkspaceNames: true,
            maxRunsPerSchedule: 30,
          },
          { paseo } as never,
        );
        return {
          text: JSON.stringify(result, null, 2),
          structuredContent: result,
          isError: !result.ok,
        };
      }
      const result = await handleOpenScheduleRunSession(
        {
          action: act,
          scheduleId: input.scheduleId ?? "",
          runId: input.runId,
          archiveOnFinish: input.archiveOnFinish,
          dryRun: false,
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const voiceSttTool = defineAgentTool({
    name: "manage_voice_stt",
    title: "Inspect, Test, or Configure Paseo Custom Voice / STT Models (SiliconFlow & Audio Pool)",
    description:
      "Inspect Paseo's active Speech-to-text configuration, apply SiliconFlow free/SOTA presets (FunAudioLLM/SenseVoiceSmall, Qwen/Qwen3-ASR-1.7B, TeleAI/TeleSpeechASR) or arbitrary custom STT models, or run a live transcription probe.",
    input: z.object({
      action: z
        .enum(["inspect", "apply", "test", "reset"])
        .optional()
        .describe("inspect (default), apply, test, or reset"),
      presetId: z
        .string()
        .optional()
        .describe(
          "Optional preset ID: siliconflow-sensevoice-free, siliconflow-qwen3-asr, siliconflow-telespeech-free, gemini-pool-3.5, groq-whisper-v3, local-parakeet",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Custom STT model ID (e.g. FunAudioLLM/SenseVoiceSmall, Qwen/Qwen3-ASR-1.7B, TeleAI/TeleSpeechASR, gemini-3.5-transcribe)",
        ),
      baseUrl: z
        .string()
        .optional()
        .describe("Optional OpenAI-compatible STT base URL (defaults to http://127.0.0.1:8787/v1 when local pool gateway is active)"),
      apiKey: z.string().optional().describe("Optional API key override"),
      language: z.string().optional().describe("Optional language hint (e.g. auto, zh, en)"),
      routeViaGateway: z
        .boolean()
        .optional()
        .describe("Route SiliconFlow/Gemini/Groq models via local Audio Pool Gateway :8787 (default true)"),
    }),
    async execute(input, { paseo }) {
      const result = await handleManageVoiceStt(
        {
          action: input.action ?? (input.presetId || input.model ? "apply" : "inspect"),
          presetId: input.presetId,
          model: input.model,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          language: input.language,
          routeViaGateway: input.routeViaGateway,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const agentHistoryTool = defineAgentTool({
    name: "manage_agent_history",
    title: "Inspect, Probe, or Self-Heal Paseo Antigravity Agent History & Session Patches",
    description:
      "Inspect Paseo Antigravity session.ts patches & CLI Conversation Vault health (能读), probe a workspace/agent/conversation's .db & transcript status (能试), or trigger 1-click self-healing from local/GDrive vault + antigravity-ops doctor --fix (能调).",
    input: z.object({
      action: z
        .enum(["inspect", "probe", "heal"])
        .optional()
        .describe("inspect (default), probe, or heal"),
      workspaceId: z
        .string()
        .optional()
        .describe("Optional workspace ID or title query to inspect/heal"),
      agentId: z.string().optional().describe("Optional agent ID"),
      conversationId: z.string().optional().describe("Optional Antigravity conversation UUID"),
    }),
    async execute(input, { agent, paseo }) {
      const result = await handleManageAgentHistory(
        {
          action: input.action ?? "inspect",
          workspaceId: input.workspaceId ?? agent.workspaceId ?? undefined,
          agentId: input.agentId,
          conversationId: input.conversationId,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const paseoRecoveryTool = defineAgentTool({
    name: "reconcile_paseo_recovery",
    title: "Inspect, Simulate, or Auto-Pull-Up Interrupted Paseo Agents",
    description:
      "Inspect Paseo's startup auto-pull-up state & tool replay trajectory (能读), simulate interrupted agent detection (能试), or automatically pull up interrupted/startup-failed Paseo agents via antigravity-ops paseo-recovery (能调).",
    input: z.object({
      action: z
        .enum(["status", "simulate", "heal", "reset"])
        .optional()
        .describe("status (default), simulate, heal, or reset"),
      agentId: z
        .string()
        .optional()
        .describe("Optional specific agent ID or prefix to inspect/pull up"),
      maxAgeHours: z
        .number()
        .optional()
        .describe("Transcript activity window in hours (default 12)"),
      prompt: z
        .string()
        .optional()
        .describe("Optional custom resume prompt when action is heal"),
    }),
    async execute(input, { paseo }) {
      const result = await handleReconcilePaseoRecovery(
        {
          action: input.action ?? "status",
          agentId: input.agentId,
          maxAgeHours: input.maxAgeHours,
          prompt: input.prompt,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const slashSkillsTool = defineAgentTool({
    name: "manage_slash_skills",
    title: "Customize & Reconcile Paseo Slash Commands, Skills, Rules, Subagents & MCPs",
    description:
      "Inspect, search, pin/unpin, enable/disable, dry-run test multi-skill prompt expansion, or sync Paseo Antigravity slash commands, skills, rules, subagents, MCPs, and plugins.",
    input: z.object({
      action: z
        .enum([
          "status",
          "inspect",
          "test",
          "sync",
          "pin",
          "unpin",
          "enable",
          "disable",
          "reset-pins",
        ])
        .optional()
        .describe("status/inspect (default), test (dry-run prompt), sync, pin, unpin, enable, disable, or reset-pins"),
      slug: z
        .string()
        .optional()
        .describe("Command or skill slug when action is pin, unpin, enable, or disable (e.g. 'wheel-check')"),
      samplePrompt: z
        .string()
        .optional()
        .describe("Sample prompt containing /commands or inline /skills to dry-run test"),
      category: z
        .enum(["all", "commands", "skills", "rules", "subagents", "mcps", "plugins"])
        .optional()
        .describe("Filter Customize inventory by category"),
      scope: z
        .enum(["all", "workspace", "user", "pinned", "disabled"])
        .optional()
        .describe("Filter Customize inventory by scope"),
      query: z.string().optional().describe("Search query across name, description, and source"),
    }),
    async execute(input, { agent, paseo }) {
      const result = await handleManageSlashSkills(
        {
          action: input.action ?? "status",
          slug: input.slug,
          samplePrompt: input.samplePrompt,
          category: input.category,
          scope: input.scope,
          query: input.query,
          cwd: agent.cwd ?? undefined,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const writebackHookTool = defineAgentTool({
    name: "manage_writeback_hook",
    title: "Inspect, Replay & Tune Antigravity Stop Hook & Writeback Gate",
    description:
      "Inspect, replay against a conversation transcript (comparing legacy v1 vs current v2), tune runtime parameters, or reset the Antigravity finishing-with-writeback Stop hook.",
    input: z.object({
      action: z
        .enum(["status", "simulate", "tune", "reset"])
        .optional()
        .describe("status (default), simulate (replay transcript), tune, or reset"),
      conversationId: z
        .string()
        .optional()
        .describe("Antigravity conversation UUID to replay when action is simulate"),
      enabled: z.boolean().optional().describe("Enable or disable Stop hook gate"),
      maxBlocksPerTurn: z.number().int().min(1).max(5).optional().describe("Max blocks per turn"),
      requireFullyIdle: z
        .boolean()
        .optional()
        .describe("Skip blocking when background tasks are still running (fullyIdle: false)"),
      transcriptTailFallback: z
        .boolean()
        .optional()
        .describe("Inspect transcriptPath tail when finalModelOutput is scrubbed by agy_cli"),
    }),
    async execute(input, { paseo }) {
      const result = await handleManageWritebackHook(
        {
          action: input.action ?? "status",
          conversationId: input.conversationId,
          enabled: input.enabled,
          maxBlocksPerTurn: input.maxBlocksPerTurn,
          requireFullyIdle: input.requireFullyIdle,
          transcriptTailFallback: input.transcriptTailFallback,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const sessionLineageTool = defineAgentTool({
    name: "manage_session_lineage",
    title: "Inspect or Reconcile Session Lineage & Sidebar Workspace Titles",
    description:
      "Inspect parent/initiating session, spawned child sessions, sibling sessions, Intake brief/report/Notion links, or reconcile untitled 'main' sidebar workspaces from their agent title.",
    input: z.object({
      action: z
        .enum(["inspect", "reconcile"])
        .optional()
        .describe("inspect (default) or reconcile (fix untitled 'main' workspaces and missing parent labels)"),
      workspaceId: z.string().optional().describe("Target workspace ID (defaults to active workspace)"),
      agentId: z.string().optional().describe("Target agent ID or prefix (defaults to active agent)"),
    }),
    async execute(input, { agent, paseo }) {
      const result = await handleManageSessionLineage(
        {
          action: input.action ?? "inspect",
          workspaceId: input.workspaceId ?? agent.workspaceId ?? undefined,
          agentId: input.agentId ?? agent.id,
          autoFixTitles: true,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const settingsSearchTool = defineAgentTool({
    name: "search_paseo_settings",
    title: "Find a Paseo Setting",
    description:
      "Find where a Paseo setting lives (page, group, row title, hint and settings route) by keyword, e.g. 'keep daemon running', 'log file', 'send shortcut'. Same index and ranking as the search field in Paseo Settings. Host pages need the host's server id in the route.",
    input: z.object({
      query: z.string().min(1).describe("Words from the setting's name or description"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)"),
      serverId: z
        .string()
        .optional()
        .describe("Host server id to fill into host routes (from `paseo daemon status`)"),
    }),
    async execute(input) {
      const results = searchSettingsIndex(SETTINGS_SEARCH_SEED.pages, input.query, {
        limit: input.limit ?? 8,
      }).map((result) => ({
        page: result.pageLabel,
        where: settingsResultBreadcrumb(result) || result.pageLabel,
        title: result.title,
        hint: result.hint ?? null,
        kind: result.kind,
        matchedIn: result.field === 0 ? "title" : result.field === 1 ? "page or group" : "hint",
        route:
          buildSettingsPath(result.pageKey, input.serverId ?? "{serverId}") ??
          `settings page ${result.pageKey}`,
      }));
      const payload = {
        query: input.query,
        count: results.length,
        index: `seed from Paseo ${SETTINGS_SEARCH_SEED.paseoVersion} (${SETTINGS_SEARCH_SEED.generatedAt}); pages opened in the app are also learned there`,
        results,
      };
      return {
        text: JSON.stringify(payload, null, 2),
        structuredContent: payload,
        isError: false,
      };
    },
  });

  const forkSessionTool = defineAgentTool({
    name: "fork_session",
    title: "Fork This Antigravity Session",
    description:
      "Copy this Antigravity conversation (full native context, via an agy db branch) into a new Paseo agent " +
      "titled 'Fork · <title>' and labelled vec.forked-from. The source session is never modified. " +
      "Use dryRun to preview. Antigravity agents only; other providers use Paseo's per-reply fork.",
    input: z.object({
      agentId: z.string().optional().describe("Agent to fork (defaults to the calling agent)"),
      title: z.string().optional().describe("Title for the new agent"),
      dryRun: z.boolean().optional().describe("Report what would be forked without writing"),
    }),
    async execute(input, { agent }) {
      const result = await handleForkSession(
        {
          agentId: input.agentId ?? agent.id,
          title: input.title,
          open: false,
          dryRun: Boolean(input.dryRun),
          source: "agent-tool",
        },
        {} as never,
      );
      return { text: JSON.stringify(result, null, 2), structuredContent: result, isError: !result.ok };
    },
  });

  // Link-First Retitle (server/link-first-retitle.ts). A link-only first prompt
  // gets a link-shaped sidebar title from Paseo; once the first turn completes
  // the agent has read the link, so name the workspace after the real agenda.
  // `agent.turn.after` does not block the turn (pluginHookRegistry waits: false).
  const linkRetitleDeps = (paseo: unknown) => ({
    paseo: paseo as never,
    rename: (input: { workspaceId?: string; agentId: string; title: string; source: string }) =>
      handleRenameThread(input as never, { paseo } as never),
  });
  server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    if (outcome.kind !== "completed") return;
    void runLinkFirstRetitle(
      { agentId: agent.id, workspaceId: agent.workspaceId, parentAgentId: agent.parentAgentId, agentTitle: agent.title },
      linkRetitleDeps(paseo),
    ).catch(() => {});
  });

  const linkRetitleTool = defineAgentTool({
    name: "manage_link_retitle",
    title: "Link-First Session Retitle",
    description:
      "Inspect or run the Link-First Retitle: when a session starts from a bare link, the sidebar title is replaced with the real agenda after the first answer. " +
      "Actions: status (config + source), ledger (recent renames), dry_run (propose a title for an agent without writing), apply (rename now; force skips guards), " +
      "backfill_scan (list existing workspaces whose title still names a link), backfill (retitle them in the background; results go to the ledger).",
    input: z.object({
      action: z.enum(["status", "ledger", "dry_run", "apply", "backfill_scan", "backfill"]).default("status"),
      agentId: z.string().optional().describe("Target agent id; defaults to the calling agent"),
      force: z.boolean().optional().describe("apply only: skip the once-per-agent and title guards"),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async execute(input, { agent, paseo }) {
      let result: Record<string, unknown>;
      if (input.action === "status") {
        result = { ok: true, config: loadLinkRetitleConfig(), configPath: LINK_RETITLE_CONFIG_PATH, ledgerPath: LINK_RETITLE_LEDGER_PATH };
      } else if (input.action === "ledger") {
        result = { ok: true, entries: readLinkRetitleLedger(input.limit ?? 20) };
      } else if (input.action === "backfill_scan" || input.action === "backfill") {
        const candidates = (await findBackfillCandidates(paseo as never)).slice(0, input.limit ?? 50);
        if (input.action === "backfill") {
          void runLinkRetitleBackfill(candidates, linkRetitleDeps(paseo)).catch(() => {});
        }
        result = {
          ok: true,
          started: input.action === "backfill",
          count: candidates.length,
          candidates,
          note: input.action === "backfill" ? `Running one at a time; read results with action "ledger" (${LINK_RETITLE_LEDGER_PATH}).` : undefined,
        };
      } else {
        const targetId = input.agentId ?? agent.id;
        const entry = await runLinkFirstRetitle(
          {
            agentId: targetId,
            workspaceId: targetId === agent.id ? agent.workspaceId : null,
            dryRun: input.action === "dry_run",
            force: input.action === "apply" && input.force === true,
          },
          linkRetitleDeps(paseo),
        );
        result = { ...entry };
      }
      return { text: JSON.stringify(result, null, 2), structuredContent: result, isError: result.ok === false && input.action !== "dry_run" };
    },
  });

  const peerAgentsTool = defineAgentTool({
    name: "manage_peer_agents",
    title: "Inspect, Dry-Run Resolve, or Sync Paseo Peer Agents & Cross-Model Review (v5)",
    description:
      "Inspect Paseo peer-awareness v5 block states across harnesses & configured agentProfiles (能读), dry-run resolve shorthand model names like 'gemini4, opus 5.5' into exact Paseo profiles (能试), or sync v5 blocks & heal the peer outbox (能调). status also returns sharedFiles (files two or more sessions edited in the last 30 minutes; null = unknown); verify_presence returns presenceVerify (whether the edit hooks are recording).",
    input: z.object({
      action: z
        .enum(["status", "test_resolve", "enable_all", "heal_outbox", "verify_presence"])
        .optional()
        .describe("status (default), test_resolve, enable_all, heal_outbox, or verify_presence"),
      profileQuery: z
        .string()
        .optional()
        .describe("Shorthand or profile names to dry-run resolve (e.g. 'gemini4, opus 5.5')"),
    }),
    async execute(input, { agent, paseo }) {
      const result = await handleManagePeerAgents(
        {
          action: input.action ?? "status",
          profileQuery: input.profileQuery,
          cwd: agent.cwd ?? undefined,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const inspectSystemPromptTool = defineAgentTool({
    name: "inspect_system_prompt",
    title: "Inspect Active Paseo System Starter Prompt & Instructions",
    description:
      "Inspect the active Paseo system starter prompt and daemon appendSystemPrompt configured in ~/.paseo/config.json. " +
      "Returns the full instruction content, character count, rule sections, and test clean simulation.",
    input: z.object({
      action: z.enum(["inspect", "test_clean"]).default("inspect"),
      testInput: z.string().optional(),
    }),
    async execute(input) {
      const result = await handleInspectSystemPrompt(input as never);
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: !result.ok,
      };
    },
  });

  const docPreviewTool = defineAgentTool({
    name: "finder_preview_document",
    title: "Inspect or Probe Multi-Format Document Preview",
    description:
      "Inspect available Paseo document preview rendering engines (PDF, DOCX, XLSX, PPTX, RTF, ODT, EPUB, iWork), list sibling workspace documents for multi-doc comparison, or probe rendering metadata and page count for a document.",
    input: z.object({
      action: z.enum(["status", "probe", "list_siblings", "clear_cache"]).default("status"),
      path: z.string().optional().describe("Relative or absolute document path when action is probe or list_siblings"),
    }),
    async execute(input, { agent, paseo }) {
      if (input.action === "list_siblings") {
        const res = await handleListSiblingDocuments(
          {
            workspaceId: agent.workspaceId ?? undefined,
            workspaceRoot: agent.cwd ?? undefined,
            currentPath: input.path,
            limit: 24,
          },
          { paseo },
        );
        return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
      }
      const res = await handleDiagnoseDocPreview(
        {
          action: input.action,
          workspaceId: agent.workspaceId ?? undefined,
          workspaceRoot: agent.cwd ?? undefined,
          path: input.path,
        },
        { paseo },
      );
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderInspectContextTool = defineAgentTool({
    name: "finder_inspect_context",
    title: "Inspect Context Window & Compaction State",
    description:
      "Read live context window token usage (usedTokens / maxTokens), checkpoint count, and pre->post /compact compaction telemetry for the current workspace or specified Antigravity agents.",
    input: z.object({
      agentIds: z.array(z.string()).max(40).optional(),
      workspaceId: z.string().optional(),
    }),
    async execute(input, { agent }) {
      const res = await handleInspectAntigravityContext({
        agentIds: input.agentIds,
        workspaceId: input.workspaceId ?? (input.agentIds?.length ? undefined : (agent.workspaceId ?? undefined)),
        includeCompactionHistory: true,
      });
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderIntakeDecisionsTool = defineAgentTool({
    name: "finder_manage_intake_decisions",
    title: "Inspect or Answer Pending Intake Task Decisions",
    description:
      "List blocked intake tasks with extracted 1-click options, dry-run preview in-place Paseo session resumption (`preview_answer`), " +
      "submit a human decision to resume the original Paseo agent (`answer`), or resolve an item directly (`resolve_done`).",
    input: z.object({
      action: z
        .enum(["list", "preview_answer", "answer", "resolve_done"])
        .default("list")
        .describe("Action to perform (default: list)"),
      refresh: z.boolean().optional().describe("Force fresh digest generation"),
      taskId: z.string().optional().describe("8-char short task ID or Notion UUID"),
      choice: z.number().int().min(1).max(12).optional().describe("1-based option index"),
      text: z.string().max(2000).optional().describe("Custom instruction or decision note"),
    }),
    async execute(input) {
      const res = await handleManageIntakeDecisions({
        action: input.action,
        refresh: input.refresh,
        taskId: input.taskId,
        choice: input.choice,
        text: input.text,
      });
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderHarnessCatalogsTool = defineAgentTool({
    name: "finder_manage_model_catalogs",
    title: "Inspect or Live-Sync Paseo Multi-Harness Model Catalogs & Profiles",
    description:
      "Inspect cross-harness model catalog alignment (status), synthesize live models & dynamic routes and push to Paseo without daemon restart (sync), or force-refresh all provider snapshots (refresh).",
    input: z.object({
      action: z.enum(["status", "sync", "refresh"]).optional().default("status"),
    }),
    async execute(input, { paseo }) {
      const res = await handleManageHarnessCatalogs(
        { action: input.action ?? "status" },
        { paseo } as never,
      );
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderManagePinPrefixTool = defineAgentTool({
    name: "finder_manage_pin_prefix",
    title: "Inspect or Sync [pin] Title Prefix on Pinned Workspaces",
    description:
      "Inspect pinned Paseo workspaces to see which titles carry the [pin] prefix (status/inspect) or sync missing [pin] prefixes onto pinned workspace titles (sync).",
    input: z.object({
      action: z.enum(["status", "inspect", "sync"]).optional().default("status"),
      workspaceId: z.string().optional(),
      prefix: z.string().optional(),
      dryRun: z.boolean().optional(),
    }),
    async execute(input, { paseo }) {
      const res = await handleManagePinPrefix(
        {
          action: input.action ?? "status",
          workspaceId: input.workspaceId,
          prefix: input.prefix,
          dryRun: input.dryRun,
        },
        { paseo } as never,
        { readSettings: () => settingsHandle.read() },
      );
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderManageQuotaQueueTool = defineAgentTool({
    name: "finder_manage_quota_queue",
    title: "Inspect or Drain Quota-Held Queued Messages",
    description:
      "Inspect queued Paseo messages held on 429/quota cooldown, check whether quota refreshed and the previous turn completed (check), drain one ready message serially (drain_one), or release/reset holds.",
    input: z.object({
      action: z
        .enum(["status", "check", "drain_one", "release", "clear_agent", "reset"])
        .optional()
        .default("status"),
      agentId: z.string().optional(),
      triggerRecoveryIfReady: z.boolean().optional(),
    }),
    async execute(input, { paseo }) {
      const res = await handleManageQuotaQueue(
        {
          action: input.action ?? "status",
          agentId: input.agentId,
          triggerRecoveryIfReady: input.triggerRecoveryIfReady,
          source: "agent-tool",
        },
        { paseo } as never,
      );
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  const finderSwarmWorkflowTool = defineAgentTool({
    name: "finder_inspect_swarm_workflow",
    title: "Inspect Antigravity Native Swarm Board & Run-Workflow Runs",
    description:
      "Inspect local Antigravity native Swarms (members, live status, board messages, live Swarm Board bridge URL) and `/run-workflow` multi-agent runs (phases, logs, child conversations). " +
      "action=inspect_swarm_snapshot reads the active workspace/agent swarm cleanly in <5ms; action=list_swarms lists all local swarms; action=list_workflows lists `/run-workflow` runs; action=probe verifies the official swarm_board bridge. Read-only.",
    input: z.object({
      action: z
        .enum([
          "status",
          "ensure_board_server",
          "list_swarms",
          "list_workflows",
          "inspect_swarm_snapshot",
          "probe",
        ])
        .optional()
        .default("inspect_swarm_snapshot"),
      workspaceId: z.string().optional(),
      agentId: z.string().optional(),
      conversationId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input, { agent }) {
      const res = await handleInspectSwarmWorkflow({
        ...input,
        workspaceId: input.workspaceId ?? agent.workspaceId ?? undefined,
        agentId: input.agentId ?? (input.conversationId ? undefined : agent.id),
      });
      return { text: JSON.stringify(res, null, 2), structuredContent: res, isError: !res.ok };
    },
  });

  // No `archive_workspace` agent tool here on purpose. Paseo ships a built-in
  // tool of that name, and Paseo 0.15.3 throws in registerPluginTools when a
  // plugin tool reuses a built-in name, which fails every agent create and
  // resume (2026-11-10). Agents archive through the built-in; the client
  // Delete key keeps the `finder.archive_workspace` RPC.
  // test/agent-tool-names.test.ts checks every name below against the
  // installed Paseo's built-in tool names.
  server.before("agent.session_open", ({ request }) => {
    return {
      ...request,
      tools: [
        ...(request.tools ?? []),
        revealTool,
        threadMetaTool,
        importFolderTool,
        quickJumpTool,
        scheduleRunsTool,
        voiceSttTool,
        agentHistoryTool,
        paseoRecoveryTool,
        slashSkillsTool,
        writebackHookTool,
        sessionLineageTool,
        peerAgentsTool,
        settingsSearchTool,
        forkSessionTool,
        linkRetitleTool,
        commitOriginTool,
        inspectSystemPromptTool,
        docPreviewTool,
        finderInspectContextTool,
        finderIntakeDecisionsTool,
        finderHarnessCatalogsTool,
        finderManagePinPrefixTool,
        finderManageQuotaQueueTool,
        finderSwarmWorkflowTool,
      ],
    };
  });

  return () => {
    void disposeSwarmBoardBridge();
  };
}
