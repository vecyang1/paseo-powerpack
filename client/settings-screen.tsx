import {
  type PluginSurfaceProps,
  useRpc,
  useSettings,
  useTranslation,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type CustomizeCategory,
  type CustomizeScope,
  type InlineRenameCaretPosition,
  type LabelShortcutCombo,
  type OpenerTarget,
  type PeerPresenceSummary,
  type PeerPresenceVerify,
  type PeerSharedFile,
  type ProjectPickerShortcutPreset,
  type QuickJumpAction,
  type SidebarGroupingPreset,
  VOICE_STT_PRESETS,
  diagnosePathRpc,
  importFolderWorkspaceRpc,
  inspectScheduleRunsRpc,
  manageAgentHistoryRpc,
  managePeerAgentsRpc,
  managePinPrefixRpc,
  manageQuotaQueueRpc,
  manageSlashSkillsRpc,
  manageVoiceSttRpc,
  manageWorkspaceLabelsRpc,
  manageWritebackHookRpc,
  openFileTargetRpc,
  openScheduleRunSessionRpc,
  pluginSettings,
  quickJumpWorkspaceRpc,
  reconcilePaseoRecoveryRpc,
  renameWorkspaceOrAgentRpc,
  inspectSystemPromptRpc,
} from "../shared/contracts";
import { isChineseLocale, pluginTranslations } from "./i18n";
import {
  formatPeerSessionRow,
  formatPresenceSummary,
  formatPresenceVerdict,
} from "../shared/peer-presence-format";
import { DocPreviewSettingsSection } from "./doc-settings-section";
import { IntakeDecisionsSettingsSection } from "./intake-decisions-settings-section";
import { MermaidSettingsSection } from "./mermaid-settings-section";
import { ModelCatalogSettingsSection } from "./model-catalog-settings-section";
import { RelaySettingsSection } from "./relay-settings-section";
import { SwarmWorkflowSettingsSection } from "./swarm-workflow-settings-section";
import {
  type ScheduleRunsDomHealthSnapshot,
  type ScheduleRunsDomSelfTestResult,
  getScheduleRunsDomHealthSnapshot,
  navigateToPaseoWorkspace,
  resetScheduleRunsDomCircuitBreaker,
  runScheduleRunsDomIdempotencySelfTest,
  syncScheduleRunsPreferences,
  triggerScheduleRunsDrawer,
} from "./schedule-runs-web";
import { syncVoiceCustomModelPreferences } from "./voice-stt-web";
import { syncQuotaQueuePrefs } from "./quota-queue-guard-web";
import {
  PIN_PREFIX_EVENT,
  type PinPrefixStatusSnapshot,
  getPinPrefixStatus,
  inspectPinnedWorkspacesNow,
  reconcileAllPinnedNow,
  syncPinPrefixPrefs,
} from "./pin-prefix-web";
import { DEFAULT_PIN_PREFIX, normalizePinPrefix } from "../shared/pin-prefix";
import {
  DICTATION_GUARD_EVENT,
  type DictationGuardStatus,
  getDictationGuardStatus,
  normalizeDictationSendBehavior,
  runDictationGuardSelfTest,
  syncDictationSendBehavior,
} from "./dictation-guard-web";
import {
  MODEL_QUICK_SWITCH_EVENT,
  type ModelQuickSwitchStatus,
  getModelQuickSwitchStatus,
  runModelQuickSwitchSelfTest,
  syncModelQuickSwitchPrefs,
} from "./model-quick-switch-web";
import {
  PROJECT_PICKER_SHORTCUT_EVENT,
  type ProjectPickerShortcutStatus,
  captureKeyboardEventAsShortcut,
  getProjectPickerShortcutStatus,
  isMacPlatform,
  parseProjectPickerShortcutChord,
  runProjectPickerShortcutSelfTest,
  syncProjectPickerShortcutPrefs,
} from "./project-picker-shortcut-web";
import {
  SIDEBAR_GROUPING_SHORTCUT_EVENT,
  type SidebarGroupingShortcutStatus,
  getSidebarGroupingShortcutStatus,
  runSidebarGroupingShortcutSelfTest,
  switchSidebarGrouping,
  syncSidebarGroupingShortcutPrefs,
} from "./sidebar-grouping-shortcut-web";
import {
  SIDEBAR_DEFAULT_COLLAPSE_EVENT,
  type SidebarDefaultCollapseStatus,
  collapseEmptySidebarProjectsNow,
  getSidebarDefaultCollapseStatus,
  runSidebarDefaultCollapseSelfTest,
  syncSidebarDefaultCollapsePrefs,
} from "./sidebar-default-collapse-web";
import {
  DEFAULT_SUBSESSION_MODEL_ICON_MODE,
  normalizeSubsessionModelIconMode,
} from "../shared/model-brand-icons";
import {
  SIDEBAR_CHILD_SESSIONS_EVENT,
  type SidebarChildSessionsCheck,
  type SidebarChildSessionsStatus,
  describeSkipReason,
  getSidebarChildSessionsStatus,
  runSidebarChildSessionsSelfTest,
  syncSidebarChildSessionsPrefs,
} from "./sidebar-child-sessions-web";
import {
  SETTINGS_SEARCH_EVENT,
  type SettingsSearchStatus,
  getSettingsSearchStatus,
  rebuildSettingsIndex,
  resetLearnedSettingsPages,
  runSettingsSearchSelfTest,
  syncSettingsSearchPrefs,
} from "./settings-search-web";
import {
  DEFAULT_SMART_COPY_SAMPLE,
  SMART_COPY_EVENT,
  type SmartCopyMode,
  type SmartCopySelfTestResult,
  type SmartCopyStatus,
  getSmartCopyStatus,
  runSmartCopySelfTest,
  syncSmartCopyPreferences,
} from "./smart-copy-web";
import {
  QUOTE_REPLY_EVENT,
  type QuoteReplySelfTestResult,
  type QuoteReplyStatus,
  clearQuoteTray,
  getQuoteReplyStatus,
  resetQuoteReplyPreferences,
  runQuoteReplySelfTest,
  syncQuoteReplyPreferences,
} from "./quote-reply-web";
import {
  DEFAULT_MARKDOWN_TABLE_SAMPLE,
  MARKDOWN_TABLE_EVENT,
  type MarkdownTableSelfTestResult,
  type MarkdownTableStatus,
  getMarkdownTableStatus,
  repairRenderedDomTables,
  runMarkdownTableSelfTest,
  syncMarkdownTablePreferences,
} from "./markdown-table-web";
import {
  SESSION_TIME_EVENT,
  type SessionTimeClockFormat,
  type SessionTimeHealthSnapshot,
  type SessionTimeSelfTestResult,
  getSessionTimeHealthSnapshot,
  runSessionTimeSelfTest,
  syncSessionTimePreferences,
} from "./session-time-web";
import {
  applyInlineInputCaret,
  computeDoneToggledTitle,
  findF2InlineRenameTarget,
  focusWorkspaceInApp,
  locateProjectInSidebar,
  mountInlineTitleInput,
  navigateSidebarThreadRelative,
  openQuickWorkspaceSwitcherModal,
  resolveCurrentActiveWorkspaceId,
  resolveSidebarArchiveTarget,
  revealWorkspaceInSidebar,
  syncImagePanelAssociations,
  syncInlineRenamePreferences,
  syncQuickJumpPreferences,
  syncSidebarDropPreferences,
  toggleActiveWorkspacePin,
  toggleCurrentSessionDone,
  triggerQuickThreadMetadataBar,
} from "./web";

export function FinderPluginSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useTranslation(pluginTranslations);
  const settings = useSettings(pluginSettings);
  const toast = useToast();
  const diagnosePath = useRpc(diagnosePathRpc);
  const openTarget = useRpc(openFileTargetRpc);
  const importFolder = useRpc(importFolderWorkspaceRpc);
  const manageLabels = useRpc(manageWorkspaceLabelsRpc);
  const renameThread = useRpc(renameWorkspaceOrAgentRpc);
  const quickJump = useRpc(quickJumpWorkspaceRpc);
  const inspectScheduleRuns = useRpc(inspectScheduleRunsRpc);
  const openScheduleRunSession = useRpc(openScheduleRunSessionRpc);
  const manageVoiceStt = useRpc(manageVoiceSttRpc);
  const manageAgentHistory = useRpc(manageAgentHistoryRpc);
  const managePinPrefix = useRpc(managePinPrefixRpc);
  const manageQuotaQueue = useRpc(manageQuotaQueueRpc);
  const manageSlashSkills = useRpc(manageSlashSkillsRpc);
  const manageWritebackHook = useRpc(manageWritebackHookRpc);
  const reconcilePaseoRecovery = useRpc(reconcilePaseoRecoveryRpc);
  const managePeerAgents = useRpc(managePeerAgentsRpc);
  const inspectSystemPrompt = useRpc(inspectSystemPromptRpc);
  const [systemPromptSnap, setSystemPromptSnap] = useState<
    Awaited<ReturnType<typeof inspectSystemPrompt>> | null
  >(null);
  const [testCleanInput, setTestCleanInput] = useState("");
  const [testCleanResult, setTestCleanResult] = useState<string | null>(null);

  useEffect(() => {
    void inspectSystemPrompt({ action: "inspect" }).then(setSystemPromptSnap).catch(() => {});
  }, []);
  const isZh = isChineseLocale(
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );

  const [testInput, setTestInput] = useState(
    "reports/mobile_ui_series/00_mobile_ui_5screen_panoramic_showcase.png",
  );
  const [folderTestInput, setFolderTestInput] = useState(".");
  const [renameDiagInput, setRenameDiagInput] = useState("");
  const [markDoneTestResult, setMarkDoneTestResult] = useState<string | null>(null);
  const [deleteArchiveTestResult, setDeleteArchiveTestResult] = useState<string | null>(null);
  const [labelsBarTestResult, setLabelsBarTestResult] = useState<string | null>(null);
  const [threadNavTestResult, setThreadNavTestResult] = useState<string | null>(null);
  const [pinWorkspaceTestResult, setPinWorkspaceTestResult] = useState<string | null>(null);
  const [pinPrefixStatus, setPinPrefixStatus] = useState<PinPrefixStatusSnapshot | null>(null);
  const [pinPrefixInput, setPinPrefixInput] = useState(DEFAULT_PIN_PREFIX);
  const lastSyncedPinPrefixRef = useRef<string | null>(null);
  const [pinPrefixInspectLines, setPinPrefixInspectLines] = useState<string[] | null>(null);
  const [pinPrefixActionMsg, setPinPrefixActionMsg] = useState<string | null>(null);
  useEffect(() => {
    setPinPrefixStatus(getPinPrefixStatus());
    if (typeof window === "undefined") return;
    const onPinEvent = () => setPinPrefixStatus(getPinPrefixStatus());
    window.addEventListener(PIN_PREFIX_EVENT, onPinEvent);
    return () => window.removeEventListener(PIN_PREFIX_EVENT, onPinEvent);
  }, []);
  const [quickJumpQueryInput, setQuickJumpQueryInput] = useState("");
  const [scheduleRunsQueryInput, setScheduleRunsQueryInput] = useState("");
  const [scheduleRunsDiagData, setScheduleRunsDiagData] = useState<
    Awaited<ReturnType<typeof inspectScheduleRuns>> | null
  >(null);
  const [scheduleDomHealth, setScheduleDomHealth] =
    useState<ScheduleRunsDomHealthSnapshot>(() =>
      getScheduleRunsDomHealthSnapshot(),
    );
  const [scheduleDomSelfTest, setScheduleDomSelfTest] =
    useState<ScheduleRunsDomSelfTestResult | null>(null);
  const [voiceModelInput, setVoiceModelInput] = useState("FunAudioLLM/SenseVoiceSmall");
  const [voiceBaseUrlInput, setVoiceBaseUrlInput] = useState("http://127.0.0.1:8787/v1");
  const [voiceSnapData, setVoiceSnapData] = useState<
    Awaited<ReturnType<typeof manageVoiceStt>> | null
  >(null);
  const [dictationGuardStatus, setDictationGuardStatus] = useState<DictationGuardStatus | null>(
    null,
  );

  useEffect(() => {
    setDictationGuardStatus(getDictationGuardStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setDictationGuardStatus(getDictationGuardStatus());
    window.addEventListener(DICTATION_GUARD_EVENT, onReceipt);
    return () => window.removeEventListener(DICTATION_GUARD_EVENT, onReceipt);
  }, []);
  const [modelSwitchStatus, setModelSwitchStatus] = useState<ModelQuickSwitchStatus | null>(null);
  useEffect(() => {
    setModelSwitchStatus(getModelQuickSwitchStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setModelSwitchStatus(getModelQuickSwitchStatus());
    window.addEventListener(MODEL_QUICK_SWITCH_EVENT, onReceipt);
    return () => window.removeEventListener(MODEL_QUICK_SWITCH_EVENT, onReceipt);
  }, []);
  const [projectPickerStatus, setProjectPickerStatus] =
    useState<ProjectPickerShortcutStatus | null>(null);
  const [customProjectShortcutInput, setCustomProjectShortcutInput] = useState("Alt+P");
  const lastSyncedCustomShortcutRef = useRef<string | null>(null);
  const [recordingProjectShortcut, setRecordingProjectShortcut] = useState(false);
  const [projectShortcutError, setProjectShortcutError] = useState<string | null>(null);
  useEffect(() => {
    setProjectPickerStatus(getProjectPickerShortcutStatus());
    if (typeof window === "undefined") return;
    const onEvent = () => setProjectPickerStatus(getProjectPickerShortcutStatus());
    window.addEventListener(PROJECT_PICKER_SHORTCUT_EVENT, onEvent);
    return () => window.removeEventListener(PROJECT_PICKER_SHORTCUT_EVENT, onEvent);
  }, []);
  useEffect(() => {
    if (!recordingProjectShortcut || typeof window === "undefined") return;
    type PaseoDesktopBridge = {
      menu?: { setCapturingShortcut?: (capturing: boolean) => Promise<void> | void };
    };
    const setMenuCapturing = (capturing: boolean) => {
      try {
        const desktop = (window as unknown as { paseoDesktop?: PaseoDesktopBridge }).paseoDesktop;
        void desktop?.menu?.setCapturingShortcut?.(capturing);
      } catch {
        // Ignore on web / non-Electron hosts
      }
    };
    setMenuCapturing(true);
    const onCapture = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      const captured = captureKeyboardEventAsShortcut(ev, isMacPlatform());
      if (!captured.ok) {
        if (captured.reason === "modifier-only" || captured.reason === "composing") return;
        if (captured.reason === "cancelled") {
          setRecordingProjectShortcut(false);
          setProjectShortcutError(null);
          return;
        }
        setProjectShortcutError(t("settings.projectPickerInvalidShortcut"));
        return;
      }
      setRecordingProjectShortcut(false);
      setProjectShortcutError(null);
      lastSyncedCustomShortcutRef.current = captured.spec;
      setCustomProjectShortcutInput(captured.spec);
      syncProjectPickerShortcutPrefs({
        preset: "custom",
        customShortcut: captured.spec,
      });
      setProjectPickerStatus(getProjectPickerShortcutStatus());
      if (settings.status === "ready") {
        void settings.save(
          {
            ...settings.values,
            projectPickerShortcutPreset: "custom",
            projectPickerCustomShortcut: captured.spec,
          },
          settings.revision,
        );
      }
    };
    window.addEventListener("keydown", onCapture, true);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      setMenuCapturing(false);
    };
  }, [recordingProjectShortcut, settings, t]);
  const [sidebarGroupingStatus, setSidebarGroupingStatus] =
    useState<SidebarGroupingShortcutStatus | null>(null);
  const [customGroupingProjectInput, setCustomGroupingProjectInput] = useState("Cmd+Ctrl+P");
  const [customGroupingStatusInput, setCustomGroupingStatusInput] = useState("Cmd+Ctrl+S");
  const lastSyncedGroupingProjectRef = useRef<string | null>(null);
  const lastSyncedGroupingStatusRef = useRef<string | null>(null);
  const [recordingGroupingTarget, setRecordingGroupingTarget] = useState<"project" | "status" | null>(
    null,
  );
  const [groupingProjectShortcutError, setGroupingProjectShortcutError] = useState<string | null>(
    null,
  );
  const [groupingStatusShortcutError, setGroupingStatusShortcutError] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
    if (typeof window === "undefined") return;
    const onEvent = () => setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
    window.addEventListener(SIDEBAR_GROUPING_SHORTCUT_EVENT, onEvent);
    return () => window.removeEventListener(SIDEBAR_GROUPING_SHORTCUT_EVENT, onEvent);
  }, []);
  useEffect(() => {
    if (!recordingGroupingTarget || typeof window === "undefined") return;
    type PaseoDesktopBridge = {
      menu?: { setCapturingShortcut?: (capturing: boolean) => Promise<void> | void };
    };
    const setMenuCapturing = (capturing: boolean) => {
      try {
        const desktop = (window as unknown as { paseoDesktop?: PaseoDesktopBridge }).paseoDesktop;
        void desktop?.menu?.setCapturingShortcut?.(capturing);
      } catch {
        // Ignore on web / non-Electron hosts
      }
    };
    setMenuCapturing(true);
    try {
      document?.documentElement?.setAttribute("data-paseo-recording-shortcut", "true");
    } catch {
      // Ignore
    }
    const onCapture = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      const captured = captureKeyboardEventAsShortcut(ev, isMacPlatform());
      if (!captured.ok) {
        if (captured.reason === "modifier-only" || captured.reason === "composing") return;
        if (captured.reason === "cancelled") {
          setRecordingGroupingTarget(null);
          setGroupingProjectShortcutError(null);
          setGroupingStatusShortcutError(null);
          return;
        }
        if (recordingGroupingTarget === "project") {
          setGroupingProjectShortcutError(t("settings.sidebarGroupingInvalidShortcut"));
        } else {
          setGroupingStatusShortcutError(t("settings.sidebarGroupingInvalidShortcut"));
        }
        return;
      }
      const target = recordingGroupingTarget;
      setRecordingGroupingTarget(null);
      setGroupingProjectShortcutError(null);
      setGroupingStatusShortcutError(null);
      if (target === "project") {
        lastSyncedGroupingProjectRef.current = captured.spec;
        setCustomGroupingProjectInput(captured.spec);
        syncSidebarGroupingShortcutPrefs({
          preset: "custom",
          projectShortcut: captured.spec,
        });
        setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
        if (settings.status === "ready") {
          void settings.save(
            {
              ...settings.values,
              sidebarGroupingPreset: "custom",
              sidebarGroupingProjectShortcut: captured.spec,
            },
            settings.revision,
          );
        }
      } else {
        lastSyncedGroupingStatusRef.current = captured.spec;
        setCustomGroupingStatusInput(captured.spec);
        syncSidebarGroupingShortcutPrefs({
          preset: "custom",
          statusShortcut: captured.spec,
        });
        setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
        if (settings.status === "ready") {
          void settings.save(
            {
              ...settings.values,
              sidebarGroupingPreset: "custom",
              sidebarGroupingStatusShortcut: captured.spec,
            },
            settings.revision,
          );
        }
      }
    };
    window.addEventListener("keydown", onCapture, true);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      setMenuCapturing(false);
      try {
        document?.documentElement?.removeAttribute("data-paseo-recording-shortcut");
      } catch {
        // Ignore
      }
    };
  }, [recordingGroupingTarget, settings, t]);
  const [sidebarChildStatus, setSidebarChildStatus] = useState<SidebarChildSessionsStatus | null>(null);
  const [sidebarChildChecks, setSidebarChildChecks] = useState<SidebarChildSessionsCheck[] | null>(null);
  useEffect(() => {
    setSidebarChildStatus(getSidebarChildSessionsStatus());
    if (typeof window === "undefined") return;
    const onChange = () => setSidebarChildStatus(getSidebarChildSessionsStatus());
    window.addEventListener(SIDEBAR_CHILD_SESSIONS_EVENT, onChange);
    return () => window.removeEventListener(SIDEBAR_CHILD_SESSIONS_EVENT, onChange);
  }, []);
  const [sidebarCollapseStatus, setSidebarCollapseStatus] =
    useState<SidebarDefaultCollapseStatus | null>(null);
  useEffect(() => {
    setSidebarCollapseStatus(getSidebarDefaultCollapseStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setSidebarCollapseStatus(getSidebarDefaultCollapseStatus());
    window.addEventListener(SIDEBAR_DEFAULT_COLLAPSE_EVENT, onReceipt);
    return () => window.removeEventListener(SIDEBAR_DEFAULT_COLLAPSE_EVENT, onReceipt);
  }, []);
  const [settingsSearchStatus, setSettingsSearchStatus] =
    useState<SettingsSearchStatus | null>(null);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("restart daemon");
  useEffect(() => {
    setSettingsSearchStatus(getSettingsSearchStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setSettingsSearchStatus(getSettingsSearchStatus());
    window.addEventListener(SETTINGS_SEARCH_EVENT, onReceipt);
    return () => window.removeEventListener(SETTINGS_SEARCH_EVENT, onReceipt);
  }, []);
  const [smartCopyStatus, setSmartCopyStatus] = useState<SmartCopyStatus | null>(null);
  const [smartCopySampleInput, setSmartCopySampleInput] = useState(
    DEFAULT_SMART_COPY_SAMPLE.slice(0, 220),
  );
  const [smartCopySelfTest, setSmartCopySelfTest] = useState<SmartCopySelfTestResult | null>(null);
  useEffect(() => {
    setSmartCopyStatus(getSmartCopyStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setSmartCopyStatus(getSmartCopyStatus());
    window.addEventListener(SMART_COPY_EVENT, onReceipt);
    return () => window.removeEventListener(SMART_COPY_EVENT, onReceipt);
  }, []);
  const [quoteReplyStatus, setQuoteReplyStatus] = useState<QuoteReplyStatus | null>(null);
  const [quoteReplySelfTest, setQuoteReplySelfTest] = useState<QuoteReplySelfTestResult | null>(null);
  useEffect(() => {
    setQuoteReplyStatus(getQuoteReplyStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setQuoteReplyStatus(getQuoteReplyStatus());
    window.addEventListener(QUOTE_REPLY_EVENT, onReceipt);
    return () => window.removeEventListener(QUOTE_REPLY_EVENT, onReceipt);
  }, []);
  const [markdownTableStatus, setMarkdownTableStatus] = useState<MarkdownTableStatus | null>(null);
  const [markdownTableSampleInput, setMarkdownTableSampleInput] = useState(
    DEFAULT_MARKDOWN_TABLE_SAMPLE,
  );
  const [markdownTableSelfTest, setMarkdownTableSelfTest] =
    useState<MarkdownTableSelfTestResult | null>(null);
  useEffect(() => {
    setMarkdownTableStatus(getMarkdownTableStatus());
    if (typeof window === "undefined") return;
    const onReceipt = () => setMarkdownTableStatus(getMarkdownTableStatus());
    window.addEventListener(MARKDOWN_TABLE_EVENT, onReceipt);
    return () => window.removeEventListener(MARKDOWN_TABLE_EVENT, onReceipt);
  }, []);
  const [sessionTimeHealth, setSessionTimeHealth] =
    useState<SessionTimeHealthSnapshot | null>(() => getSessionTimeHealthSnapshot());
  const [sessionTimeSelfTest, setSessionTimeSelfTest] =
    useState<SessionTimeSelfTestResult | null>(null);
  useEffect(() => {
    setSessionTimeHealth(getSessionTimeHealthSnapshot());
    if (typeof window === "undefined") return;
    const onReceipt = () => setSessionTimeHealth(getSessionTimeHealthSnapshot());
    window.addEventListener(SESSION_TIME_EVENT, onReceipt);
    return () => window.removeEventListener(SESSION_TIME_EVENT, onReceipt);
  }, []);
  const [agentHistoryQueryInput, setAgentHistoryQueryInput] = useState("");
  const [agentHistorySnapData, setAgentHistorySnapData] = useState<
    Awaited<ReturnType<typeof manageAgentHistory>> | null
  >(null);
  const [recoveryAgentInput, setRecoveryAgentInput] = useState("");
  const [recoverySnapData, setRecoverySnapData] = useState<
    Awaited<ReturnType<typeof reconcilePaseoRecovery>> | null
  >(null);
  const [quotaQueueSnapData, setQuotaQueueSnapData] = useState<
    Awaited<ReturnType<typeof manageQuotaQueue>> | null
  >(null);
  const [customizeSearchInput, setCustomizeSearchInput] = useState("");
  const [customizeCategory, setCustomizeCategory] = useState<CustomizeCategory>("all");
  const [customizeScope, setCustomizeScope] = useState<CustomizeScope>("all");
  const [customizeDryRunInput, setCustomizeDryRunInput] = useState(
    "/wheel-check or use context7; /1password if need; /graphify /design-md /ego-browser",
  );
  const [customizeSnapData, setCustomizeSnapData] = useState<
    Awaited<ReturnType<typeof manageSlashSkills>> | null
  >(null);
  const [writebackConvInput, setWritebackConvInput] = useState(
    "4886f126-34b5-4dea-b6dd-01685971fb77",
  );
  const [writebackSnapData, setWritebackSnapData] = useState<
    Awaited<ReturnType<typeof manageWritebackHook>> | null
  >(null);
  const [peerProfileQueryInput, setPeerProfileQueryInput] = useState("gemini4, opus 5.5");
  const [peerAgentsSnapData, setPeerAgentsSnapData] = useState<
    Awaited<ReturnType<typeof managePeerAgents>> | null
  >(null);
  // Shared files (T-098). undefined = not answered yet, null = the check gave nothing readable.
  // Kept apart from the snapshot above: the other buttons replace it with a reply that carries
  // no list, and that must not turn a list into "unknown".
  const [peerSharedFiles, setPeerSharedFiles] = useState<PeerSharedFile[] | null | undefined>(
    undefined,
  );
  const [peerPresenceSummary, setPeerPresenceSummary] = useState<PeerPresenceSummary | null>(null);
  const [peerPresenceVerify, setPeerPresenceVerify] = useState<
    PeerPresenceVerify | null | undefined
  >(undefined);
  const [peerPresenceBusy, setPeerPresenceBusy] = useState<"" | "status" | "verify_presence">("");
  const applyPeerStatus = (res: Awaited<ReturnType<typeof managePeerAgents>>) => {
    setPeerAgentsSnapData(res);
    setPeerSharedFiles(res.sharedFiles ?? null);
    setPeerPresenceSummary(res.presence ?? null);
  };
  const markPeerSharedFilesUnknown = () => {
    setPeerSharedFiles(null);
    setPeerPresenceSummary(null);
  };

  useEffect(() => {
    if (settings.status === "ready") {
      syncSidebarDropPreferences(
        settings.values.enableSidebarFolderDrop,
        settings.values.sidebarDropDefaultBehavior,
      );
      syncInlineRenamePreferences({
        enableInlineDoubleClickRename: settings.values.enableInlineDoubleClickRename,
        autoJumpToFirstPlaceInput: settings.values.autoJumpToFirstPlaceInput,
        inlineRenameCaretPosition: settings.values.inlineRenameCaretPosition,
        enableQuickRenameAndLabelShortcuts:
          settings.values.enableQuickRenameAndLabelShortcuts,
        enableLabelNumberShortcuts:
          settings.values.enableLabelNumberShortcuts ?? true,
        labelNumberShortcutMode:
          settings.values.labelNumberShortcutMode ?? "empty-input",
        labelShortcutCombo: settings.values.labelShortcutCombo ?? "both",
        enableThreadNavigationShortcuts:
          settings.values.enableThreadNavigationShortcuts ?? true,
        enablePinWorkspaceShortcut:
          settings.values.enablePinWorkspaceShortcut ?? true,
        enableMarkDoneShortcut: settings.values.enableMarkDoneShortcut,
        markDonePrefix: settings.values.markDonePrefix,
        enableDesktopContextMenuHelper: settings.values.enableDesktopContextMenuHelper,
        enableCmdClickOpenSystemDefault: settings.values.enableCmdClickOpenSystemDefault,
        cmdClickDefaultTarget: settings.values.cmdClickDefaultTarget,
        enableSidebarCmdClickFinder: settings.values.enableSidebarCmdClickFinder,
        enableSidebarDeleteKeyArchive: settings.values.enableSidebarDeleteKeyArchive,
      });
      syncQuickJumpPreferences({
        enableWorkspaceQuickJump: settings.values.enableWorkspaceQuickJump,
        enableCommandCenterProjectItems: settings.values.enableCommandCenterProjectItems,
        dedupeCommandCenterAgentRows: settings.values.dedupeCommandCenterAgentRows,
        quickJumpDefaultAction: settings.values.quickJumpDefaultAction,
      });
      syncScheduleRunsPreferences(
        settings.values.enableScheduleRunsInspector,
        "plugin-settings",
      );
      setScheduleDomHealth(getScheduleRunsDomHealthSnapshot());
      syncVoiceCustomModelPreferences(settings.values.enableVoiceCustomModelHelper);
      syncDictationSendBehavior(
        normalizeDictationSendBehavior(settings.values.dictationSendBehavior),
      );
      syncModelQuickSwitchPrefs({
        enabled: settings.values.enableModelQuickSwitch,
        digitMode: settings.values.modelQuickSwitchDigits,
      });
      syncProjectPickerShortcutPrefs({
        enabled: settings.values.enableProjectPickerShortcut ?? true,
        preset: settings.values.projectPickerShortcutPreset ?? "alt_p",
        customShortcut: settings.values.projectPickerCustomShortcut ?? "Alt+P",
      });
      const savedCustomShortcut = settings.values.projectPickerCustomShortcut ?? "Alt+P";
      if (lastSyncedCustomShortcutRef.current !== savedCustomShortcut) {
        lastSyncedCustomShortcutRef.current = savedCustomShortcut;
        setCustomProjectShortcutInput(savedCustomShortcut);
      }
      setProjectPickerStatus(getProjectPickerShortcutStatus());
      syncSidebarGroupingShortcutPrefs({
        enabled: settings.values.enableSidebarGroupingShortcuts ?? true,
        preset: settings.values.sidebarGroupingPreset ?? "cmd_ctrl_p_s",
        projectShortcut: settings.values.sidebarGroupingProjectShortcut ?? "Cmd+Ctrl+P",
        statusShortcut: settings.values.sidebarGroupingStatusShortcut ?? "Cmd+Ctrl+S",
        toggleOnRePress: settings.values.sidebarGroupingToggleOnRePress ?? false,
      });
      const savedGroupingProject = settings.values.sidebarGroupingProjectShortcut ?? "Cmd+Ctrl+P";
      if (lastSyncedGroupingProjectRef.current !== savedGroupingProject) {
        lastSyncedGroupingProjectRef.current = savedGroupingProject;
        setCustomGroupingProjectInput(savedGroupingProject);
      }
      const savedGroupingStatus = settings.values.sidebarGroupingStatusShortcut ?? "Cmd+Ctrl+S";
      if (lastSyncedGroupingStatusRef.current !== savedGroupingStatus) {
        lastSyncedGroupingStatusRef.current = savedGroupingStatus;
        setCustomGroupingStatusInput(savedGroupingStatus);
      }
      setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
      syncSidebarDefaultCollapsePrefs({ enabled: settings.values.startNewProjectsCollapsed });
      syncSettingsSearchPrefs({
        enabled: settings.values.enableSettingsSearch ?? true,
        shortcut: settings.values.settingsSearchShortcut ?? true,
      });
      syncSmartCopyPreferences({
        enabled: settings.values.enableSmartClipboardCopy ?? true,
        defaultMode: settings.values.defaultClipboardCopyMode ?? "smart",
        bulletMarker: settings.values.smartCopyBulletMarker ?? "bullet",
        linkFormat: settings.values.smartCopyLinkFormat ?? "label-only",
      });
      syncMarkdownTablePreferences({
        enabled: settings.values.enableMarkdownTableEnhancer ?? true,
        renderLatexMath: settings.values.enableLatexMathRendering ?? true,
      });
      syncSessionTimePreferences(
        {
          enabled: settings.values.enableSessionFinishedTimeEnhancer ?? true,
          clockFormat: settings.values.sessionTimeClockFormat ?? "24h",
          showFinishedTimeInSidebar: settings.values.showFinishedTimeInSidebar ?? true,
          showRelativeAgeInTurnFooter:
            settings.values.showRelativeAgeInTurnFooter ?? true,
        },
        "plugin-settings",
      );
      setSessionTimeHealth(getSessionTimeHealthSnapshot());
      syncPinPrefixPrefs({
        enabled: settings.values.enablePinTitlePrefix ?? true,
        prefix: settings.values.pinTitlePrefix ?? DEFAULT_PIN_PREFIX,
      });
      const savedPinPrefix = settings.values.pinTitlePrefix ?? DEFAULT_PIN_PREFIX;
      if (lastSyncedPinPrefixRef.current !== savedPinPrefix) {
        lastSyncedPinPrefixRef.current = savedPinPrefix;
        setPinPrefixInput(savedPinPrefix);
      }
      setPinPrefixStatus(getPinPrefixStatus());
    }
  }, [settings]);

  useEffect(() => {
    void manageVoiceStt({ action: "inspect", source: "settings-ui" })
      .then((res) => {
        setVoiceSnapData(res);
        if (res.dictationStt.model) setVoiceModelInput(res.dictationStt.model);
        if (res.dictationStt.baseUrl) setVoiceBaseUrlInput(res.dictationStt.baseUrl);
      })
      .catch(() => {});
    void manageAgentHistory({ action: "inspect", source: "settings-ui" })
      .then((res) => {
        setAgentHistorySnapData(res);
      })
      .catch(() => {});
    void reconcilePaseoRecovery({ action: "status", source: "settings-ui" })
      .then((res) => {
        setRecoverySnapData(res);
      })
      .catch(() => {});
    void manageQuotaQueue({ action: "status", source: "settings-ui" })
      .then((res) => {
        setQuotaQueueSnapData(res);
      })
      .catch(() => {});
    void manageSlashSkills({
      action: "status",
      limit: 120,
      source: "settings-ui",
    })
      .then((res) => {
        setCustomizeSnapData(res);
      })
      .catch(() => {});
    void manageWritebackHook({
      action: "status",
      source: "settings-ui",
    })
      .then((res) => {
        setWritebackSnapData(res);
      })
      .catch(() => {});
    void managePeerAgents({
      action: "status",
      source: "settings-ui",
    })
      .then(applyPeerStatus)
      .catch(markPeerSharedFilesUnknown);
  }, [
    manageVoiceStt,
    manageAgentHistory,
    reconcilePaseoRecovery,
    manageQuotaQueue,
    manageSlashSkills,
    manageWritebackHook,
    managePeerAgents,
  ]);

  const resolveActiveWsId = (): string | undefined => {
    const g = globalThis as { document?: unknown; window?: unknown };
    if (g.document && g.window) {
      return resolveCurrentActiveWorkspaceId(
        g.document as Parameters<typeof resolveCurrentActiveWorkspaceId>[0],
        g.window as Parameters<typeof resolveCurrentActiveWorkspaceId>[1],
      );
    }
    return undefined;
  };

  const renameInspectMutation = useMutation({
    mutationFn: () =>
      manageLabels({
        action: "inspect",
        workspaceId: resolveActiveWsId(),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        if (!renameDiagInput.trim() && res.workspaceTitle) {
          setRenameDiagInput(res.workspaceTitle);
        }
      } else {
        toast.error(res.message);
      }
    },
  });

  const renameApplyMutation = useMutation({
    mutationFn: (vars: { title: string | null }) =>
      renameThread({
        workspaceId: renameInspectMutation.data?.workspaceId || resolveActiveWsId(),
        title: vars.title,
        source: "ui",
      }),
    onSuccess: (res) => {
      if (res.ok) {
        toast.show(res.message, { variant: "success" });
        if (res.title) {
          setRenameDiagInput(res.title);
        }
        renameInspectMutation.mutate();
      } else {
        toast.error(res.message);
      }
    },
  });

  const folderDiagMutation = useMutation({
    mutationFn: (vars: { path: string; dryRun: boolean }) =>
      importFolder({
        paths: [vars.path],
        dryRun: vars.dryRun,
        source: "ui",
      }),
    onSuccess: (res, vars) => {
      if (res.ok) {
        toast.show(res.message, { variant: "success" });
        if (!vars.dryRun && res.primaryWorkspaceId) {
          focusWorkspaceInApp(res.primaryWorkspaceId, res.primaryProjectId);
        }
      } else {
        toast.error(res.message);
      }
    },
  });

  const quickJumpDiagMutation = useMutation({
    mutationFn: (vars: {
      query: string;
      action: "list" | "jump";
      jumpMode?: QuickJumpAction;
      dryRun?: boolean;
    }) =>
      quickJump({
        action: vars.action,
        query: vars.query,
        jumpMode: vars.jumpMode,
        dryRun: vars.dryRun,
        limit: 12,
        source: "ui",
      }),
    onSuccess: (res, vars) => {
      if (res.ok) {
        toast.show(res.message, { variant: "success" });
        if (vars.action === "jump" && !vars.dryRun) {
          if (res.jumpMode === "locate-sidebar") {
            locateProjectInSidebar({
              projectId: res.targetProjectId,
              projectKey: res.targetProjectKey,
              projectName: res.targetProjectName,
              expandIfCollapsed: true,
              highlightFlash: true,
            });
          } else if (res.targetWorkspaceId) {
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
        }
      } else {
        toast.error(res.message);
      }
    },
  });

  const diagMutation = useMutation({
    mutationFn: (rawInput: string) => diagnosePath({ rawInput }),
  });

  const openMutation = useMutation({
    mutationFn: (vars: { path: string; target: OpenerTarget }) => openTarget(vars),
    onSuccess: (res) => {
      if (res.ok) {
        toast.show(res.message, { variant: "success" });
      } else {
        toast.error(res.message);
      }
      if (testInput.trim()) {
        diagMutation.mutate(testInput.trim());
      }
    },
  });

  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 14 : 24,
        gap: 18,
      },
      diagBox: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 8,
      },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      input: {
        flex: 1,
        minWidth: 220,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 6,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        fontSize: 12,
      },
      btn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      btnText: {
        color: theme.colors.accentForeground,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      secondaryBtn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      secondaryBtnText: {
        color: theme.colors.foreground,
        fontSize: 11.5,
      },
      label: {
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      detail: {
        color: theme.colors.foregroundMuted,
        fontSize: 11.5,
      },
    }),
    [theme, layout.compact],
  );

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={styles.content}>
        <Text style={styles.label}>
          {t("settings.loadError")} {settings.error}
        </Text>
      </View>
    );
  }

  const { values, revision, save } = settings;

  const applyCustomProjectPickerShortcut = (raw: string) => {
    const trimmed = raw.trim();
    const parsed = parseProjectPickerShortcutChord(trimmed);
    if (!parsed) {
      setProjectShortcutError(t("settings.projectPickerInvalidShortcut"));
      return;
    }
    setProjectShortcutError(null);
    lastSyncedCustomShortcutRef.current = trimmed;
    syncProjectPickerShortcutPrefs({
      preset: "custom",
      customShortcut: trimmed,
    });
    setProjectPickerStatus(getProjectPickerShortcutStatus());
    void save(
      {
        ...values,
        projectPickerShortcutPreset: "custom",
        projectPickerCustomShortcut: trimmed,
      },
      revision,
    );
  };

  const resetProjectPickerShortcutToDefault = () => {
    setProjectShortcutError(null);
    setRecordingProjectShortcut(false);
    lastSyncedCustomShortcutRef.current = "Alt+P";
    setCustomProjectShortcutInput("Alt+P");
    syncProjectPickerShortcutPrefs({
      preset: "alt_p",
      customShortcut: "Alt+P",
    });
    setProjectPickerStatus(getProjectPickerShortcutStatus());
    void save(
      {
        ...values,
        projectPickerShortcutPreset: "alt_p",
        projectPickerCustomShortcut: "Alt+P",
      },
      revision,
    );
  };

  const applyCustomSidebarGroupingShortcut = (target: "project" | "status", raw: string) => {
    const trimmed = raw.trim();
    const isDisable = trimmed === "" || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "off";
    const parsed = isDisable ? null : parseProjectPickerShortcutChord(trimmed);
    if (!isDisable && !parsed) {
      if (target === "project") {
        setGroupingProjectShortcutError(t("settings.sidebarGroupingInvalidShortcut"));
      } else {
        setGroupingStatusShortcutError(t("settings.sidebarGroupingInvalidShortcut"));
      }
      return;
    }
    const nextValue = isDisable ? "none" : trimmed;
    if (target === "project") {
      setGroupingProjectShortcutError(null);
      lastSyncedGroupingProjectRef.current = nextValue;
      setCustomGroupingProjectInput(nextValue);
      syncSidebarGroupingShortcutPrefs({
        preset: "custom",
        projectShortcut: nextValue,
      });
      setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
      void save(
        {
          ...values,
          sidebarGroupingPreset: "custom",
          sidebarGroupingProjectShortcut: nextValue,
        },
        revision,
      );
    } else {
      setGroupingStatusShortcutError(null);
      lastSyncedGroupingStatusRef.current = nextValue;
      setCustomGroupingStatusInput(nextValue);
      syncSidebarGroupingShortcutPrefs({
        preset: "custom",
        statusShortcut: nextValue,
      });
      setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
      void save(
        {
          ...values,
          sidebarGroupingPreset: "custom",
          sidebarGroupingStatusShortcut: nextValue,
        },
        revision,
      );
    }
  };

  const resetSidebarGroupingShortcutToDefault = () => {
    setGroupingProjectShortcutError(null);
    setGroupingStatusShortcutError(null);
    setRecordingGroupingTarget(null);
    lastSyncedGroupingProjectRef.current = "Cmd+Ctrl+P";
    lastSyncedGroupingStatusRef.current = "Cmd+Ctrl+S";
    setCustomGroupingProjectInput("Cmd+Ctrl+P");
    setCustomGroupingStatusInput("Cmd+Ctrl+S");
    syncSidebarGroupingShortcutPrefs({
      enabled: true,
      preset: "cmd_ctrl_p_s",
      projectShortcut: "Cmd+Ctrl+P",
      statusShortcut: "Cmd+Ctrl+S",
      toggleOnRePress: false,
    });
    setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
    void save(
      {
        ...values,
        enableSidebarGroupingShortcuts: true,
        sidebarGroupingPreset: "cmd_ctrl_p_s",
        sidebarGroupingProjectShortcut: "Cmd+Ctrl+P",
        sidebarGroupingStatusShortcut: "Cmd+Ctrl+S",
        sidebarGroupingToggleOnRePress: false,
      },
      revision,
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <SettingsSection title={t("settings.sectionBehavior")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.defaultActionLabel")}
            hint={t("settings.defaultActionHint")}
            value={values.defaultPrimaryAction}
            options={[
              { label: t("settings.optFinderReveal"), value: "finder-reveal" },
              { label: t("settings.optFinderFolder"), value: "finder-folder" },
              { label: t("settings.optSystemPreview"), value: "system-preview" },
              { label: t("settings.optAntigravity"), value: "antigravity" },
              { label: t("settings.optCursor"), value: "cursor" },
              { label: t("settings.optVscode"), value: "vscode" },
              { label: t("settings.optTerminal"), value: "terminal" },
            ]}
            onValueChange={(next) => {
              void save({ ...values, defaultPrimaryAction: next }, revision);
            }}
          />

          <SettingsSelect
            label={t("settings.preferredEditorLabel")}
            hint={t("settings.preferredEditorHint")}
            value={values.preferredCodeEditor}
            options={[
              { label: "Antigravity IDE", value: "antigravity" },
              { label: "Cursor IDE", value: "cursor" },
              { label: "Visual Studio Code", value: "vscode" },
            ]}
            onValueChange={(next) => {
              void save({ ...values, preferredCodeEditor: next }, revision);
            }}
          />

          <SettingsSelect
            label={t("settings.canvasBgLabel")}
            hint={t("settings.canvasBgHint")}
            value={values.defaultCanvasBackground}
            options={[
              { label: t("settings.optBgChecker"), value: "checker" },
              { label: t("settings.optBgDark"), value: "dark" },
              { label: t("settings.optBgLight"), value: "light" },
            ]}
            onValueChange={(next) => {
              void save({ ...values, defaultCanvasBackground: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.autoAssocLabel")}
            hint={t("settings.autoAssocHint")}
            value={values.autoAssociateImagePanels}
            onValueChange={(next) => {
              void save({ ...values, autoAssociateImagePanels: next }, revision);
              syncImagePanelAssociations("file-inspector-finder", "image-inspector", next);
            }}
          />

          <SettingsSwitch
            label={t("settings.desktopHelperLabel")}
            hint={t("settings.desktopHelperHint")}
            value={values.enableDesktopContextMenuHelper}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix,
                enableDesktopContextMenuHelper: next,
                enableCmdClickOpenSystemDefault: values.enableCmdClickOpenSystemDefault,
                cmdClickDefaultTarget: values.cmdClickDefaultTarget,
                enableSidebarCmdClickFinder: values.enableSidebarCmdClickFinder,
              });
              void save({ ...values, enableDesktopContextMenuHelper: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.enableCmdClickOpenSystemDefault")}
            hint={t("settings.enableCmdClickOpenSystemDefaultDesc")}
            value={values.enableCmdClickOpenSystemDefault ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
                enableCmdClickOpenSystemDefault: next,
                cmdClickDefaultTarget: values.cmdClickDefaultTarget,
                enableSidebarCmdClickFinder: values.enableSidebarCmdClickFinder,
              });
              void save({ ...values, enableCmdClickOpenSystemDefault: next }, revision);
            }}
          />

          <SettingsSelect
            label={t("settings.cmdClickDefaultTargetLabel")}
            hint={t("settings.cmdClickDefaultTargetDesc")}
            value={values.cmdClickDefaultTarget ?? "system-default"}
            options={[
              { label: t("settings.optSystemDefault"), value: "system-default" },
              { label: t("settings.optSystemPreview"), value: "system-preview" },
              { label: t("settings.optFinderReveal"), value: "finder-reveal" },
              { label: t("settings.optFinderFolder"), value: "finder-folder" },
              { label: t("settings.optAntigravity"), value: "antigravity" },
              { label: t("settings.optCursor"), value: "cursor" },
              { label: t("settings.optVscode"), value: "vscode" },
            ]}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
                enableCmdClickOpenSystemDefault: values.enableCmdClickOpenSystemDefault,
                cmdClickDefaultTarget: next as OpenerTarget,
                enableSidebarCmdClickFinder: values.enableSidebarCmdClickFinder,
              });
              void save(
                { ...values, cmdClickDefaultTarget: next as OpenerTarget },
                revision,
              );
            }}
          />

          <SettingsSwitch
            label={t("settings.enableSidebarCmdClickFinder")}
            hint={t("settings.enableSidebarCmdClickFinderDesc")}
            value={values.enableSidebarCmdClickFinder ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
                enableCmdClickOpenSystemDefault: values.enableCmdClickOpenSystemDefault,
                cmdClickDefaultTarget: values.cmdClickDefaultTarget,
                enableSidebarCmdClickFinder: next,
              });
              void save({ ...values, enableSidebarCmdClickFinder: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.inlineDoubleClickRenameLabel")}
            hint={t("settings.inlineDoubleClickRenameHint")}
            value={values.enableInlineDoubleClickRename}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: next,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
              });
              void save({ ...values, enableInlineDoubleClickRename: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.autoJumpFirstPlaceLabel")}
            hint={t("settings.autoJumpFirstPlaceHint")}
            value={values.autoJumpToFirstPlaceInput}
            onValueChange={(next) => {
              const nextCaret: InlineRenameCaretPosition = next
                ? "start"
                : values.inlineRenameCaretPosition === "end"
                  ? "end"
                  : "select-all";
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: next,
                inlineRenameCaretPosition: nextCaret,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
              });
              void save(
                {
                  ...values,
                  autoJumpToFirstPlaceInput: next,
                  inlineRenameCaretPosition: nextCaret,
                },
                revision,
              );
            }}
          />

          <SettingsSelect
            label={t("settings.inlineRenameCaretModeLabel")}
            hint={t("settings.inlineRenameCaretModeHint")}
            value={values.inlineRenameCaretPosition}
            options={[
              { label: t("settings.optCaretStart"), value: "start" },
              { label: t("settings.optCaretSelectAll"), value: "select-all" },
              { label: t("settings.optCaretEnd"), value: "end" },
            ]}
            onValueChange={(next) => {
              const nextAutoJump = next === "start";
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: nextAutoJump,
                inlineRenameCaretPosition: next,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
              });
              void save(
                {
                  ...values,
                  autoJumpToFirstPlaceInput: nextAutoJump,
                  inlineRenameCaretPosition: next,
                },
                revision,
              );
            }}
          />

          <SettingsSwitch
            label={t("settings.quickRenameLabelShortcutsLabel")}
            hint={t("settings.quickRenameLabelShortcutsHint")}
            value={values.enableQuickRenameAndLabelShortcuts}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts: next,
                labelShortcutCombo: values.labelShortcutCombo ?? "both",
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix,
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
              });
              void save({ ...values, enableQuickRenameAndLabelShortcuts: next }, revision);
            }}
          />

          {values.enableQuickRenameAndLabelShortcuts && (
            <SettingsSelect
              label={t("settings.labelShortcutComboLabel")}
              hint={t("settings.labelShortcutComboHint")}
              value={values.labelShortcutCombo ?? "both"}
              options={[
                { label: t("settings.optLabelShortcutBoth"), value: "both" },
                { label: t("settings.optLabelShortcutCmdL"), value: "cmd_l" },
                { label: t("settings.optLabelShortcutCmdShiftL"), value: "cmd_shift_l" },
              ]}
              onValueChange={(next) => {
                syncInlineRenamePreferences({
                  enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                  autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                  inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                  enableQuickRenameAndLabelShortcuts:
                    values.enableQuickRenameAndLabelShortcuts,
                  labelShortcutCombo: next as LabelShortcutCombo,
                  enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                  markDonePrefix: values.markDonePrefix,
                  enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
                });
                void save(
                  { ...values, labelShortcutCombo: next as LabelShortcutCombo },
                  revision,
                );
              }}
            />
          )}

          {values.enableQuickRenameAndLabelShortcuts && (
            <SettingsSwitch
              label={t("settings.enableLabelNumberShortcutsLabel")}
              hint={t("settings.enableLabelNumberShortcutsHint")}
              value={values.enableLabelNumberShortcuts ?? true}
              onValueChange={(next) => {
                syncInlineRenamePreferences({
                  enableLabelNumberShortcuts: next,
                });
                void save({ ...values, enableLabelNumberShortcuts: next }, revision);
              }}
            />
          )}

          {values.enableQuickRenameAndLabelShortcuts &&
            (values.enableLabelNumberShortcuts ?? true) && (
              <SettingsSwitch
                label={t("settings.labelNumberShortcutModeLabel")}
                hint={t("settings.labelNumberShortcutModeHint")}
                value={(values.labelNumberShortcutMode ?? "empty-input") !== "modifier-only"}
                onValueChange={(next) => {
                  const mode = next ? "empty-input" : "modifier-only";
                  syncInlineRenamePreferences({
                    labelNumberShortcutMode: mode,
                  });
                  void save({ ...values, labelNumberShortcutMode: mode }, revision);
                }}
              />
            )}

          {values.enableQuickRenameAndLabelShortcuts && (
            <SettingsAction
              label={t("settings.testLabelsBarLabel")}
              hint={
                labelsBarTestResult
                  ? labelsBarTestResult
                  : isZh
                    ? "点击即刻测试打开工作区标签管理栏（能试：验证当前工作区标签读取、颜色选择器与标签切换）"
                    : "Click to test opening the workspace labels bar (verify active labels, color picker, and tag toggles)"
              }
              actionLabel={isZh ? "测试标签栏" : "Test Labels"}
              onPress={async () => {
                const res = await triggerQuickThreadMetadataBar("labels");
                if (res.ok) {
                  setLabelsBarTestResult(res.message);
                  toast.show(res.message);
                } else {
                  setLabelsBarTestResult(res.message);
                  toast.show(res.message);
                }
              }}
            />
          )}

          <SettingsSwitch
            label={t("settings.threadNavigationShortcutsLabel")}
            hint={t("settings.threadNavigationShortcutsHint")}
            value={values.enableThreadNavigationShortcuts ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableThreadNavigationShortcuts: next,
              });
              void save({ ...values, enableThreadNavigationShortcuts: next }, revision);
            }}
          />

          {(values.enableThreadNavigationShortcuts ?? true) && (
            <>
              <SettingsAction
                label={
                  isZh
                    ? "测试跳转至上一会话 (Cmd+; / ⌘;)"
                    : "Test jump to previous thread (Cmd+;)"
                }
                hint={
                  threadNavTestResult
                    ? threadNavTestResult
                    : isZh
                      ? "点击即刻测试在侧边栏向后切换至上一个会话，验证工作区激活、平滑滚动定位与高亮闪烁"
                      : "Click to test jumping to the previous thread in the sidebar with auto-scroll and highlight"
                }
                actionLabel={t("settings.testThreadNavPrevBtn")}
                onPress={() => {
                  const res = navigateSidebarThreadRelative({ delta: -1 });
                  const desc = res.ok
                    ? `${isZh ? "已跳转至上一会话" : "Jumped to previous thread"}: ${res.targetTitle ?? res.targetWorkspaceId ?? "ok"} (${res.source})`
                    : (isZh
                        ? "未找到可跳转的侧边栏会话（请先在左侧边栏展开项目或选择工作区）"
                        : "No thread located to jump to");
                  setThreadNavTestResult(desc);
                  toast.show(desc);
                }}
              />

              <SettingsAction
                label={
                  isZh
                    ? "测试跳转至下一会话 (Cmd+' / ⌘')"
                    : "Test jump to next thread (Cmd+')"
                }
                hint={
                  threadNavTestResult
                    ? threadNavTestResult
                    : isZh
                      ? "点击即刻测试在侧边栏向前切换至下一个会话，验证工作区激活、平滑滚动定位与高亮闪烁"
                      : "Click to test jumping to the next thread in the sidebar with auto-scroll and highlight"
                }
                actionLabel={t("settings.testThreadNavNextBtn")}
                onPress={() => {
                  const res = navigateSidebarThreadRelative({ delta: 1 });
                  const desc = res.ok
                    ? `${isZh ? "已跳转至下一会话" : "Jumped to next thread"}: ${res.targetTitle ?? res.targetWorkspaceId ?? "ok"} (${res.source})`
                    : (isZh
                        ? "未找到可跳转的侧边栏会话（请先在左侧边栏展开项目或选择工作区）"
                        : "No thread located to jump to");
                  setThreadNavTestResult(desc);
                  toast.show(desc);
                }}
              />
            </>
          )}

          <SettingsSwitch
            label={t("settings.pinWorkspaceShortcutLabel")}
            hint={t("settings.pinWorkspaceShortcutHint")}
            value={values.enablePinWorkspaceShortcut ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enablePinWorkspaceShortcut: next,
              });
              void save({ ...values, enablePinWorkspaceShortcut: next }, revision);
            }}
          />

          {(values.enablePinWorkspaceShortcut ?? true) && (
            <SettingsAction
              label={
                isZh
                  ? "测试置顶切换 (Cmd+Option+P / ⌘⌥P)"
                  : "Test pin toggle (Cmd+Option+P / ⌘⌥P)"
              }
              hint={
                pinWorkspaceTestResult
                  ? pinWorkspaceTestResult
                  : isZh
                    ? "点击即刻测试为当前活跃工作区切换置顶状态，验证 workspace.pin 调度与上下文菜单 ⌘⌥P 提示"
                    : "Click to test toggling pin on the active workspace and verify workspace.pin dispatch with ⌘⌥P hint"
              }
              actionLabel={t("settings.testPinWorkspaceBtn")}
              onPress={() => {
                const res = toggleActiveWorkspacePin();
                const desc = res.ok
                  ? `${isZh ? "已触发置顶切换" : "Toggled pin"}: ${res.message} (${res.source})`
                  : (isZh
                      ? "未定位到活跃工作区（请先打开或选择一个工作区）"
                      : "No active workspace located");
                setPinWorkspaceTestResult(desc);
                toast.show(desc);
              }}
            />
          )}

          <SettingsSwitch
            label={t("settings.pinTitlePrefixLabel")}
            hint={t("settings.pinTitlePrefixHint")}
            value={values.enablePinTitlePrefix ?? true}
            onValueChange={(next) => {
              syncPinPrefixPrefs({
                enabled: next,
                prefix: values.pinTitlePrefix ?? DEFAULT_PIN_PREFIX,
              });
              setPinPrefixStatus(getPinPrefixStatus());
              void save({ ...values, enablePinTitlePrefix: next }, revision);
            }}
          />

          <View style={styles.diagBox}>
            <Text style={styles.label}>{t("settings.pinTitlePrefixValueLabel")}</Text>
            <Text style={styles.detail}>{t("settings.pinTitlePrefixValueHint")}</Text>
            <View style={styles.row}>
              <TextInput
                value={pinPrefixInput}
                onChangeText={setPinPrefixInput}
                placeholder={DEFAULT_PIN_PREFIX}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.input}
                accessibilityLabel={t("settings.pinTitlePrefixValueLabel")}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.pinTitlePrefixApplyBtn")}
                onPress={() => {
                  const normalized = normalizePinPrefix(pinPrefixInput);
                  lastSyncedPinPrefixRef.current = normalized;
                  setPinPrefixInput(normalized);
                  syncPinPrefixPrefs({ prefix: normalized });
                  setPinPrefixStatus(getPinPrefixStatus());
                  void save({ ...values, pinTitlePrefix: normalized }, revision);
                  const msg = isZh
                    ? `已更新置顶前缀为 "${normalized.trim()}"`
                    : `Updated pin prefix to "${normalized.trim()}"`;
                  setPinPrefixActionMsg(msg);
                  toast.show(msg);
                }}
                style={styles.btn}
              >
                <Text style={styles.btnText}>{t("settings.pinTitlePrefixApplyBtn")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.pinTitlePrefixResetBtn")}
                onPress={() => {
                  lastSyncedPinPrefixRef.current = DEFAULT_PIN_PREFIX;
                  setPinPrefixInput(DEFAULT_PIN_PREFIX);
                  syncPinPrefixPrefs({ enabled: true, prefix: DEFAULT_PIN_PREFIX });
                  setPinPrefixStatus(getPinPrefixStatus());
                  void save(
                    {
                      ...values,
                      enablePinTitlePrefix: true,
                      pinTitlePrefix: DEFAULT_PIN_PREFIX,
                    },
                    revision,
                  );
                  const msg = isZh ? "已恢复默认前缀 [pin]" : "Reset pin prefix to [pin]";
                  setPinPrefixActionMsg(msg);
                  toast.show(msg);
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>
                  {t("settings.pinTitlePrefixResetBtn")}
                </Text>
              </Pressable>
            </View>

            <Text style={styles.detail}>
              {isZh
                ? `当前置顶会话: ${pinPrefixStatus?.pinnedCount ?? 0} 个 · 已含前缀: ${pinPrefixStatus?.withPrefixCount ?? 0} · 待补充: ${pinPrefixStatus?.missingPrefixCount ?? 0} · 状态监听: ${pinPrefixStatus?.storeAvailable ? "已连接" : "等待加载"}`
                : `Pinned: ${pinPrefixStatus?.pinnedCount ?? 0} · With prefix: ${pinPrefixStatus?.withPrefixCount ?? 0} · Missing: ${pinPrefixStatus?.missingPrefixCount ?? 0} · Store: ${pinPrefixStatus?.storeAvailable ? "Ready" : "Pending"}`}
            </Text>

            <View style={styles.row}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.pinTitlePrefixInspectBtn")}
                onPress={async () => {
                  const local = inspectPinnedWorkspacesNow();
                  if (local.pinnedCount > 0 || pinPrefixStatus?.storeAvailable) {
                    const lines = local.items.slice(0, 8).map((item) =>
                      item.hasPrefix
                        ? `[ok] ${item.title}`
                        : `[missing] ${item.title || item.workspaceId} -> ${item.proposedTitle ?? ""}`,
                    );
                    setPinPrefixInspectLines(lines);
                    setPinPrefixActionMsg(
                      isZh
                        ? `检查完成：共 ${local.pinnedCount} 个置顶会话（${local.withPrefixCount} 已带前缀，${local.missingPrefixCount} 待补充）`
                        : `Inspected ${local.pinnedCount} pinned session(s): ${local.withPrefixCount} with prefix, ${local.missingPrefixCount} missing`,
                    );
                    setPinPrefixStatus(getPinPrefixStatus());
                    return;
                  }
                  const res = await managePinPrefix({
                    action: "inspect",
                    prefix: values.pinTitlePrefix ?? DEFAULT_PIN_PREFIX,
                  });
                  setPinPrefixInspectLines(
                    res.items.slice(0, 8).map((item) =>
                      item.hasPrefix
                        ? `[ok] ${item.title}`
                        : `[missing] ${item.title || item.workspaceId} -> ${item.proposedTitle ?? ""}`,
                    ),
                  );
                  setPinPrefixActionMsg(res.message);
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>
                  {t("settings.pinTitlePrefixInspectBtn")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.pinTitlePrefixSyncBtn")}
                onPress={async () => {
                  const localRes = await reconcileAllPinnedNow();
                  let msg = isZh
                    ? `客户端同步完成：更新 ${localRes.updated} 个会话`
                    : `Synced ${localRes.updated} pinned session(s)`;
                  if (localRes.checked === 0) {
                    const rpcRes = await managePinPrefix({
                      action: "sync",
                      prefix: values.pinTitlePrefix ?? DEFAULT_PIN_PREFIX,
                    });
                    msg = rpcRes.message;
                  }
                  setPinPrefixStatus(getPinPrefixStatus());
                  setPinPrefixActionMsg(msg);
                  toast.show(msg);
                }}
                style={styles.btn}
              >
                <Text style={styles.btnText}>{t("settings.pinTitlePrefixSyncBtn")}</Text>
              </Pressable>
            </View>

            {pinPrefixActionMsg && <Text style={styles.detail}>{pinPrefixActionMsg}</Text>}
            {pinPrefixInspectLines &&
              pinPrefixInspectLines.map((line, idx) => (
                <Text key={`pin-inspect-${idx}`} style={styles.detail}>
                  {line}
                </Text>
              ))}
          </View>

          <SettingsSwitch
            label={t("settings.markDoneShortcutLabel")}
            hint={t("settings.markDoneShortcutHint")}
            value={values.enableMarkDoneShortcut ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: next,
                markDonePrefix: values.markDonePrefix ?? "d ",
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
              });
              void save({ ...values, enableMarkDoneShortcut: next }, revision);
            }}
          />

          <SettingsAction
            label={t("settings.testMarkDoneLabel")}
            hint={
              markDoneTestResult
                ? markDoneTestResult
                : isZh
                  ? "点击即刻测试为当前活跃会话切换「d 」前缀，同时触发左侧边栏平滑滚动定位与高亮闪烁"
                  : "Click to toggle the 'd ' prefix on the active session and verify left sidebar auto-reveal and highlight"
            }
            actionLabel={isZh ? "测试切换" : "Test Toggle"}
            onPress={async () => {
              const res = await toggleCurrentSessionDone();
              if (res) {
                setMarkDoneTestResult(
                  `${res.action === "marked" ? "Marked" : "Unmarked"}: "${res.previousTitle}" -> "${res.newTitle}" (${res.workspaceId})`,
                );
                toast.show(res.message);
              } else {
                setMarkDoneTestResult(
                  isZh
                    ? "未能找到当前活跃会话（请先在左侧选择或打开一个工作区）"
                    : "No active workspace located (select or open a workspace first)",
                );
              }
            }}
          />

          <SettingsSwitch
            label={t("settings.sidebarDeleteKeyArchiveLabel")}
            hint={t("settings.sidebarDeleteKeyArchiveHint")}
            value={values.enableSidebarDeleteKeyArchive ?? true}
            onValueChange={(next) => {
              syncInlineRenamePreferences({
                enableInlineDoubleClickRename: values.enableInlineDoubleClickRename,
                autoJumpToFirstPlaceInput: values.autoJumpToFirstPlaceInput,
                inlineRenameCaretPosition: values.inlineRenameCaretPosition,
                enableQuickRenameAndLabelShortcuts:
                  values.enableQuickRenameAndLabelShortcuts,
                enableMarkDoneShortcut: values.enableMarkDoneShortcut,
                markDonePrefix: values.markDonePrefix ?? "d ",
                enableDesktopContextMenuHelper: values.enableDesktopContextMenuHelper,
                enableCmdClickOpenSystemDefault: values.enableCmdClickOpenSystemDefault,
                cmdClickDefaultTarget: values.cmdClickDefaultTarget,
                enableSidebarCmdClickFinder: values.enableSidebarCmdClickFinder,
                enableSidebarDeleteKeyArchive: next,
              });
              void save({ ...values, enableSidebarDeleteKeyArchive: next }, revision);
            }}
          />

          <SettingsAction
            label={t("settings.testSidebarDeleteKeyArchiveLabel")}
            hint={
              deleteArchiveTestResult
                ? deleteArchiveTestResult
                : isZh
                  ? "点击测试侧边栏 Delete 归档目标解析（优先定位右键上下文菜单项、选中会话行或当前会话，并验证输入框避让）"
                  : "Click to test sidebar Delete key archive target resolution (checks open context menus, selected session row, or active workspace with input protection)"
            }
            actionLabel={isZh ? "测试目标" : "Test Target"}
            onPress={() => {
              const target = resolveSidebarArchiveTarget();
              if (target) {
                const desc = `Target: [${target.source}] wsId=${target.workspaceId ?? "none"} (menu=${Boolean(target.menuItem)})`;
                setDeleteArchiveTestResult(desc);
                toast.show(desc);
              } else {
                const desc = isZh
                  ? "未检测到可归档的侧边栏会话或菜单（请先在左侧边栏点击会话或展开右键菜单）"
                  : "No archive target located (click a sidebar session or open its menu first)";
                setDeleteArchiveTestResult(desc);
                toast.show(desc);
              }
            }}
          />

          <SettingsSwitch
            label={
              isZh
                ? "智能剪贴板复制（Beeper/微信/网页无 ** 星号 + Notion 富文本保留）"
                : "Smart Clipboard Copy (Clean Plain Text + Rich HTML for Notion)"
            }
            hint={
              isZh
                ? "开启后：Cmd+C 及点击回复下方复制按钮时，text/plain 自动清除 ** 与 ### 符号（粘贴到 Beeper、LinkedIn、微信或普通输入框无星号干扰），同时 text/html 保留完整粗体与列表排版（粘贴到 Notion、飞书、Google Docs 保持原样）。按 Cmd+Shift+C 强制仅复制纯文本，按 Option+Cmd+C（或 Option+点击复制按钮）复制原始 Markdown。"
                : "When enabled, Cmd+C and message Copy buttons put clean plain text (no ** or ###) into text/plain for Beeper/LinkedIn/WeChat/browser inputs, while keeping rich HTML in text/html for Notion/Google Docs. Press Cmd+Shift+C for Plain Only, or Option+Cmd+C (or Option+Click Copy) for Raw Markdown."
            }
            value={values.enableSmartClipboardCopy ?? true}
            onValueChange={(next) => {
              syncSmartCopyPreferences({ enabled: next });
              void save({ ...values, enableSmartClipboardCopy: next }, revision);
            }}
          />

          <SettingsSelect
            label={isZh ? "默认复制模式 (Cmd+C / 复制按钮)" : "Default Copy Mode (Cmd+C / Copy Button)"}
            hint={
              isZh
                ? "智能双格式（推荐）：Beeper/网页得纯文本、Notion 得富文本 · 原始 Markdown：保留 ** 星号 · 仅纯文本：连 Notion 也只粘贴纯文本"
                : "Smart Dual-Format (Recommended): Beeper/web inputs get clean text while Notion gets rich HTML · Raw Markdown: keeps ** · Plain Text Only: strips HTML too"
            }
            value={(values.defaultClipboardCopyMode ?? "smart") as SmartCopyMode}
            options={[
              {
                label: isZh
                  ? "智能双格式：纯文本无 ** + Notion 富文本（推荐）"
                  : "Smart: Clean Plain Text + Rich HTML (Recommended)",
                value: "smart",
              },
              {
                label: isZh
                  ? "原始 Markdown（保留 ** 与 ### 符号）"
                  : "Raw Markdown (Keep ** and ### syntax)",
                value: "markdown",
              },
              {
                label: isZh
                  ? "仅干净纯文本（不写富文本 HTML）"
                  : "Clean Plain Text Only (No HTML)",
                value: "plain",
              },
            ]}
            onValueChange={(next) => {
              syncSmartCopyPreferences({ defaultMode: next });
              void save({ ...values, defaultClipboardCopyMode: next }, revision);
            }}
          />

          <SettingsSwitch
            label={isZh ? "选中文字引用回复" : "Quote Selection as Reply Context"}
            hint={
              isZh
                ? "在对话、子代理面板或文件预览里选中文字，点击浮出的「引用」或「评论」，引用会进入输入框上方的引用栏；每条引用可单独写评论。发送时按 Markdown 引用块写在消息前面，已发出的消息里可以看到完整内容。按键未发送时自动还原，引用未出现在已发消息中时自动恢复到引用栏。"
                : "Select text in a chat, sub-agent panel, or file preview and press Quote or Comment. Quotes collect above the composer, each with its own optional comment, and are sent as Markdown blockquotes ahead of your message, visible in the sent bubble. A key press that does not send is reverted; if the quote is missing from the sent bubble the tray is restored."
            }
            value={quoteReplyStatus?.preferences.enabled ?? true}
            onValueChange={(next) => {
              setQuoteReplyStatus({ ...getQuoteReplyStatus(), preferences: syncQuoteReplyPreferences({ enabled: next }) });
            }}
          />

          <SettingsAction
            label={isZh ? "引用回复诊断" : "Quote Reply Diagnostics"}
            hint={[
              `${isZh ? "状态" : "Status"}: ${quoteReplyStatus?.installed ? (isZh ? "已安装" : "installed") : isZh ? "未安装" : "not installed"}`,
              `${isZh ? "当前会话" : "Session"}: ${quoteReplyStatus?.sessionKey ?? "-"} · ${isZh ? "待发引用" : "pending quotes"}: ${quoteReplyStatus?.quotes.length ?? 0}`,
              `${isZh ? "输入框" : "Composer"}: ${quoteReplyStatus?.composerFound ? (isZh ? "已定位" : "found") : isZh ? "未在屏幕上" : "not on screen"} · ${isZh ? "单条上限" : "max chars"}: ${quoteReplyStatus?.preferences.maxQuoteChars ?? 4000}`,
              quoteReplySelfTest ? `${isZh ? "自检" : "Self-test"}: ${quoteReplySelfTest.ok ? "ok" : "fail"} · ${quoteReplySelfTest.summary}` : "",
              ...(quoteReplyStatus?.receipts ?? []).slice(0, 6).map(
                (r) => `${r.at.slice(11, 19)} ${r.trigger} ${r.ok ? "" : "[!] "}${r.outcome}`,
              ),
            ]
              .filter(Boolean)
              .join("\n")}
            actionLabel={isZh ? "运行自检" : "Run Self-Test"}
            onPress={() => {
              const res = runQuoteReplySelfTest();
              setQuoteReplySelfTest(res);
              setQuoteReplyStatus(getQuoteReplyStatus());
              toast.show(res.summary);
            }}
          />

          <SettingsAction
            label={isZh ? "清空引用栏 / 恢复默认" : "Clear Tray / Reset Defaults"}
            hint={isZh ? "清空当前会话的待发引用，并把引用回复设置恢复为默认（开启、单条 4000 字）" : "Clear pending quotes for the current session and reset Quote Reply to defaults (on, 4000 chars per quote)"}
            actionLabel={isZh ? "清空并重置" : "Clear & Reset"}
            onPress={() => {
              clearQuoteTray();
              resetQuoteReplyPreferences();
              setQuoteReplyStatus(getQuoteReplyStatus());
            }}
          />

          <SettingsSwitch
            label={t("settings.sidebarDropLabel")}
            hint={t("settings.sidebarDropHint")}
            value={values.enableSidebarFolderDrop}
            onValueChange={(next) => {
              syncSidebarDropPreferences(next, values.sidebarDropDefaultBehavior);
              void save({ ...values, enableSidebarFolderDrop: next }, revision);
            }}
          />

          <SettingsSelect
            label={t("settings.sidebarDropModeLabel")}
            hint={t("settings.sidebarDropModeHint")}
            value={values.sidebarDropDefaultBehavior}
            options={[
              { label: t("settings.optDropOpenOrCreate"), value: "open-or-create" },
              { label: t("settings.optDropAlwaysCreate"), value: "always-create" },
            ]}
            onValueChange={(next) => {
              syncSidebarDropPreferences(values.enableSidebarFolderDrop, next);
              void save({ ...values, sidebarDropDefaultBehavior: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.quickJumpEnabledLabel")}
            hint={t("settings.quickJumpEnabledHint")}
            value={values.enableWorkspaceQuickJump}
            onValueChange={(next) => {
              syncQuickJumpPreferences({
                enableWorkspaceQuickJump: next,
                enableCommandCenterProjectItems: values.enableCommandCenterProjectItems,
                autoRevealActiveWorkspaceInSidebar:
                  values.autoRevealActiveWorkspaceInSidebar,
                quickJumpDefaultAction: values.quickJumpDefaultAction,
              });
              void save({ ...values, enableWorkspaceQuickJump: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.commandCenterProjectsLabel")}
            hint={t("settings.commandCenterProjectsHint")}
            value={values.enableCommandCenterProjectItems}
            onValueChange={(next) => {
              syncQuickJumpPreferences({
                enableWorkspaceQuickJump: values.enableWorkspaceQuickJump,
                enableCommandCenterProjectItems: next,
                autoRevealActiveWorkspaceInSidebar:
                  values.autoRevealActiveWorkspaceInSidebar,
                quickJumpDefaultAction: values.quickJumpDefaultAction,
              });
              void save({ ...values, enableCommandCenterProjectItems: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.commandCenterDedupeLabel")}
            hint={t("settings.commandCenterDedupeHint")}
            value={values.dedupeCommandCenterAgentRows}
            onValueChange={(next) => {
              syncQuickJumpPreferences({ dedupeCommandCenterAgentRows: next });
              void save({ ...values, dedupeCommandCenterAgentRows: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.autoRevealSidebarLabel")}
            hint={t("settings.autoRevealSidebarHint")}
            value={values.autoRevealActiveWorkspaceInSidebar}
            onValueChange={(next) => {
              syncQuickJumpPreferences({
                enableWorkspaceQuickJump: values.enableWorkspaceQuickJump,
                enableCommandCenterProjectItems: values.enableCommandCenterProjectItems,
                autoRevealActiveWorkspaceInSidebar: next,
                quickJumpDefaultAction: values.quickJumpDefaultAction,
              });
              void save({ ...values, autoRevealActiveWorkspaceInSidebar: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.startNewProjectsCollapsedLabel")}
            hint={t("settings.startNewProjectsCollapsedHint")}
            value={values.startNewProjectsCollapsed}
            onValueChange={(next) => {
              syncSidebarDefaultCollapsePrefs({ enabled: next });
              setSidebarCollapseStatus(getSidebarDefaultCollapseStatus());
              void save({ ...values, startNewProjectsCollapsed: next }, revision);
            }}
          />

          <SettingsSelect
            label={t("settings.quickJumpModeLabel")}
            hint={t("settings.quickJumpModeHint")}
            value={values.quickJumpDefaultAction}
            options={[
              { label: t("settings.optJumpNewWorkspace"), value: "new-workspace" },
              { label: t("settings.optJumpOpenLatest"), value: "open-latest" },
              { label: t("settings.optJumpLocateSidebar"), value: "locate-sidebar" },
              { label: t("settings.optJumpCreateNew"), value: "create-new" },
            ]}
            onValueChange={(next) => {
              syncQuickJumpPreferences({
                enableWorkspaceQuickJump: values.enableWorkspaceQuickJump,
                enableCommandCenterProjectItems: values.enableCommandCenterProjectItems,
                autoRevealActiveWorkspaceInSidebar:
                  values.autoRevealActiveWorkspaceInSidebar,
                quickJumpDefaultAction: next,
              });
              void save({ ...values, quickJumpDefaultAction: next }, revision);
            }}
          />

          <SettingsSwitch
            label={
              isZh
                ? "侧边栏节奏小秒表图标 (Cadence Timer) 与 Schedules 运行记录抽屉 (⌘⇧H)"
                : "Sidebar Cadence Timer Badges, 1-Click Run Now & Schedules Runs Drawer (⌘⇧H)"
            }
            hint={
              isZh
                ? "在左侧边栏为自动定时运行的工作区标注小秒表图标以减少不必要注意力，支持 Alt+单击或右键菜单一键立即运行；Schedules 页面支持运行记录抽屉穿透"
                : "Decorate cadence workspaces in left sidebar with small timer badges to reduce human attention, 1-click Run Now via Alt+Click or context menu, and Runs Drawer in Schedules"
            }
            value={values.enableScheduleRunsInspector}
            onValueChange={(next) => {
              syncScheduleRunsPreferences(next, "plugin-settings");
              setScheduleDomHealth(getScheduleRunsDomHealthSnapshot());
              void save({ ...values, enableScheduleRunsInspector: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.voiceHelperEnabledLabel")}
            hint={t("settings.voiceHelperEnabledHint")}
            value={values.enableVoiceCustomModelHelper}
            onValueChange={(next) => {
              syncVoiceCustomModelPreferences(next);
              void save({ ...values, enableVoiceCustomModelHelper: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.dictationGuardLabel")}
            hint={t("settings.dictationGuardHint")}
            value={values.dictationSendBehavior !== "native"}
            onValueChange={(next) => {
              const behavior = next ? "insert-only" : "native";
              syncDictationSendBehavior(behavior);
              setDictationGuardStatus(getDictationGuardStatus());
              void save({ ...values, dictationSendBehavior: behavior }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.modelQuickSwitchLabel")}
            hint={t("settings.modelQuickSwitchHint")}
            value={values.enableModelQuickSwitch}
            onValueChange={(next) => {
              syncModelQuickSwitchPrefs({ enabled: next });
              setModelSwitchStatus(getModelQuickSwitchStatus());
              void save({ ...values, enableModelQuickSwitch: next }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.modelQuickSwitchDigitsLabel")}
            hint={t("settings.modelQuickSwitchDigitsHint")}
            value={values.modelQuickSwitchDigits !== "modifier-only"}
            onValueChange={(next) => {
              const digitMode = next ? "empty-search" : "modifier-only";
              syncModelQuickSwitchPrefs({ digitMode });
              setModelSwitchStatus(getModelQuickSwitchStatus());
              void save({ ...values, modelQuickSwitchDigits: digitMode }, revision);
            }}
          />

          <SettingsSwitch
            label={t("settings.projectPickerShortcutLabel")}
            hint={t("settings.projectPickerShortcutHint")}
            value={values.enableProjectPickerShortcut ?? true}
            onValueChange={(next) => {
              syncProjectPickerShortcutPrefs({ enabled: next });
              setProjectPickerStatus(getProjectPickerShortcutStatus());
              void save({ ...values, enableProjectPickerShortcut: next }, revision);
            }}
          />

          {(values.enableProjectPickerShortcut ?? true) && (
            <SettingsSelect
              label={t("settings.projectPickerPresetLabel")}
              hint={t("settings.projectPickerPresetHint")}
              value={values.projectPickerShortcutPreset ?? "alt_p"}
              options={[
                { label: t("settings.optProjectShortcutAltP"), value: "alt_p" },
                { label: t("settings.optProjectShortcutCmdShiftJ"), value: "cmd_shift_j" },
                { label: t("settings.optProjectShortcutCmdAltO"), value: "cmd_alt_o" },
                { label: t("settings.optProjectShortcutCmdP"), value: "cmd_p" },
                { label: t("settings.optProjectShortcutCustom"), value: "custom" },
              ]}
              onValueChange={(next) => {
                const preset = next as ProjectPickerShortcutPreset;
                setProjectShortcutError(null);
                syncProjectPickerShortcutPrefs({ preset });
                setProjectPickerStatus(getProjectPickerShortcutStatus());
                void save({ ...values, projectPickerShortcutPreset: preset }, revision);
              }}
            />
          )}

          {(values.enableProjectPickerShortcut ?? true) &&
            (values.projectPickerShortcutPreset ?? "alt_p") === "custom" && (
              <SettingsRow
                label={t("settings.projectPickerCustomLabel")}
                hint={t("settings.projectPickerCustomHint")}
                error={projectShortcutError}
              >
                <View style={styles.row}>
                  <TextInput
                    value={customProjectShortcutInput}
                    onChangeText={(txt) => {
                      setCustomProjectShortcutInput(txt);
                      setProjectShortcutError(null);
                    }}
                    onSubmitEditing={() => {
                      applyCustomProjectPickerShortcut(customProjectShortcutInput);
                    }}
                    placeholder="Alt+P / Mod+Shift+J"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={styles.input}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("settings.projectPickerApplyBtn")}
                    onPress={() => {
                      applyCustomProjectPickerShortcut(customProjectShortcutInput);
                    }}
                    style={styles.btn}
                  >
                    <Text style={styles.btnText}>{t("settings.projectPickerApplyBtn")}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("settings.projectPickerRecordBtn")}
                    onPress={() => {
                      setProjectShortcutError(null);
                      setRecordingProjectShortcut((prev) => !prev);
                    }}
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryBtnText}>
                      {recordingProjectShortcut
                        ? t("settings.projectPickerRecordingBtn")
                        : t("settings.projectPickerRecordBtn")}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("settings.projectPickerResetBtn")}
                    onPress={resetProjectPickerShortcutToDefault}
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryBtnText}>
                      {t("settings.projectPickerResetBtn")}
                    </Text>
                  </Pressable>
                </View>
              </SettingsRow>
            )}

          <SettingsSwitch
            label={t("settings.sidebarGroupingShortcutLabel")}
            hint={t("settings.sidebarGroupingShortcutHint")}
            value={values.enableSidebarGroupingShortcuts ?? true}
            onValueChange={(next) => {
              syncSidebarGroupingShortcutPrefs({ enabled: next });
              setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
              void save({ ...values, enableSidebarGroupingShortcuts: next }, revision);
            }}
          />

          {(values.enableSidebarGroupingShortcuts ?? true) && (
            <>
              <SettingsSelect
                label={t("settings.sidebarGroupingPresetLabel")}
                hint={t("settings.sidebarGroupingPresetHint")}
                value={values.sidebarGroupingPreset ?? "cmd_ctrl_p_s"}
                options={[
                  { label: t("settings.optGroupingShortcutCmdCtrl"), value: "cmd_ctrl_p_s" },
                  { label: t("settings.optGroupingShortcutCmdAlt"), value: "cmd_alt_p_s" },
                  { label: t("settings.optGroupingShortcutCtrlShift"), value: "ctrl_shift_p_s" },
                  { label: t("settings.optGroupingShortcutCustom"), value: "custom" },
                ]}
                onValueChange={(next) => {
                  const preset = next as SidebarGroupingPreset;
                  setGroupingProjectShortcutError(null);
                  setGroupingStatusShortcutError(null);
                  syncSidebarGroupingShortcutPrefs({ preset });
                  setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
                  void save({ ...values, sidebarGroupingPreset: preset }, revision);
                }}
              />

              {(values.sidebarGroupingPreset ?? "cmd_ctrl_p_s") === "custom" && (
                <>
                  <SettingsRow
                    label={t("settings.sidebarGroupingProjectCustomLabel")}
                    hint={t("settings.sidebarGroupingProjectCustomHint")}
                    error={groupingProjectShortcutError}
                  >
                    <View style={styles.row}>
                      <TextInput
                        value={customGroupingProjectInput}
                        onChangeText={(txt) => {
                          setCustomGroupingProjectInput(txt);
                          setGroupingProjectShortcutError(null);
                        }}
                        onSubmitEditing={() => {
                          applyCustomSidebarGroupingShortcut("project", customGroupingProjectInput);
                        }}
                        placeholder="Cmd+Ctrl+P"
                        placeholderTextColor={theme.colors.foregroundMuted}
                        style={styles.input}
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("settings.projectPickerApplyBtn")}
                        onPress={() => {
                          applyCustomSidebarGroupingShortcut("project", customGroupingProjectInput);
                        }}
                        style={styles.btn}
                      >
                        <Text style={styles.btnText}>{t("settings.projectPickerApplyBtn")}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("settings.projectPickerRecordBtn")}
                        onPress={() => {
                          setGroupingProjectShortcutError(null);
                          setRecordingGroupingTarget((prev) =>
                            prev === "project" ? null : "project",
                          );
                        }}
                        style={styles.secondaryBtn}
                      >
                        <Text style={styles.secondaryBtnText}>
                          {recordingGroupingTarget === "project"
                            ? t("settings.projectPickerRecordingBtn")
                            : t("settings.projectPickerRecordBtn")}
                        </Text>
                      </Pressable>
                    </View>
                  </SettingsRow>

                  <SettingsRow
                    label={t("settings.sidebarGroupingStatusCustomLabel")}
                    hint={t("settings.sidebarGroupingStatusCustomHint")}
                    error={groupingStatusShortcutError}
                  >
                    <View style={styles.row}>
                      <TextInput
                        value={customGroupingStatusInput}
                        onChangeText={(txt) => {
                          setCustomGroupingStatusInput(txt);
                          setGroupingStatusShortcutError(null);
                        }}
                        onSubmitEditing={() => {
                          applyCustomSidebarGroupingShortcut("status", customGroupingStatusInput);
                        }}
                        placeholder="Cmd+Ctrl+S"
                        placeholderTextColor={theme.colors.foregroundMuted}
                        style={styles.input}
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("settings.projectPickerApplyBtn")}
                        onPress={() => {
                          applyCustomSidebarGroupingShortcut("status", customGroupingStatusInput);
                        }}
                        style={styles.btn}
                      >
                        <Text style={styles.btnText}>{t("settings.projectPickerApplyBtn")}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("settings.projectPickerRecordBtn")}
                        onPress={() => {
                          setGroupingStatusShortcutError(null);
                          setRecordingGroupingTarget((prev) =>
                            prev === "status" ? null : "status",
                          );
                        }}
                        style={styles.secondaryBtn}
                      >
                        <Text style={styles.secondaryBtnText}>
                          {recordingGroupingTarget === "status"
                            ? t("settings.projectPickerRecordingBtn")
                            : t("settings.projectPickerRecordBtn")}
                        </Text>
                      </Pressable>
                    </View>
                  </SettingsRow>
                </>
              )}

              <SettingsSwitch
                label={t("settings.sidebarGroupingToggleOnRePressLabel")}
                hint={t("settings.sidebarGroupingToggleOnRePressHint")}
                value={values.sidebarGroupingToggleOnRePress ?? false}
                onValueChange={(next) => {
                  syncSidebarGroupingShortcutPrefs({ toggleOnRePress: next });
                  setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
                  void save({ ...values, sidebarGroupingToggleOnRePress: next }, revision);
                }}
              />
            </>
          )}

          <SettingsSwitch
            label={t("settings.showComposerPillLabel")}
            hint={t("settings.showComposerPillHint")}
            value={values.showComposerPill}
            onValueChange={(next) => {
              void save({ ...values, showComposerPill: next }, revision);
            }}
          />

          <SettingsAction
            label={t("settings.resyncLabel")}
            hint={t("settings.resyncHint")}
            actionLabel={t("settings.resyncAction")}
            onPress={() => {
              syncImagePanelAssociations("file-inspector-finder", "image-inspector", true);
              toast.show(t("settings.resyncSuccess"), {
                variant: "success",
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionQuickJumpDiag")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>{t("settings.quickJumpDiagPrompt")}</Text>
          <View style={styles.row}>
            <TextInput
              value={quickJumpQueryInput}
              onChangeText={setQuickJumpQueryInput}
              placeholder={t("settings.quickJumpDiagPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.quickJumpPreviewBtn")}
              onPress={() => {
                quickJumpDiagMutation.mutate({
                  query: quickJumpQueryInput.trim(),
                  action: "jump",
                  dryRun: true,
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {t("settings.quickJumpPreviewBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.quickJumpTestBtn")}
              onPress={() => {
                quickJumpDiagMutation.mutate({
                  query: quickJumpQueryInput.trim(),
                  action: "jump",
                  jumpMode: values.quickJumpDefaultAction,
                  dryRun: false,
                });
              }}
              style={styles.btn}
            >
              <Icon name="FolderOpen" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnText}>{t("settings.quickJumpTestBtn")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.quickJumpLocateBtn")}
              onPress={() => {
                quickJumpDiagMutation.mutate({
                  query: quickJumpQueryInput.trim(),
                  action: "jump",
                  jumpMode: "locate-sidebar",
                  dryRun: false,
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.quickJumpLocateBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.quickJumpRevealActiveBtn")}
              onPress={() => {
                const wsId = resolveActiveWsId();
                const ok = revealWorkspaceInSidebar({
                  workspaceId: wsId,
                  highlightFlash: true,
                });
                toast.show(
                  ok
                    ? `Revealed active workspace (${wsId ?? "current"}) in left sidebar`
                    : `Triggered parent project expansion & sidebar scroll for ${wsId ?? "current"}`,
                  { variant: "success" },
                );
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.quickJumpRevealActiveBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.quickJumpOpenModalBtn")}
              onPress={() => {
                void openQuickWorkspaceSwitcherModal({
                  initialQuery: quickJumpQueryInput.trim(),
                  defaultJumpMode: values.quickJumpDefaultAction,
                  onListJumpProjects: async (q) => {
                    const r = await quickJump({
                      action: "list",
                      query: q,
                      limit: 50,
                      source: "quick-switcher",
                    });
                    return r.candidates;
                  },
                  onExecuteQuickJump: async (input) => {
                    const r = await quickJump({
                      action: "jump",
                      projectId: input.projectId,
                      query: input.query,
                      jumpMode: input.jumpMode,
                      source: input.source ?? "quick-switcher",
                    });
                    return {
                      ok: r.ok,
                      jumpMode: r.jumpMode,
                      targetWorkspaceId: r.targetWorkspaceId,
                      targetProjectId: r.targetProjectId,
                      targetProjectKey: r.targetProjectKey,
                      targetProjectName: r.targetProjectName,
                      message: r.message,
                    };
                  },
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.quickJumpOpenModalBtn")}
              </Text>
            </Pressable>
          </View>

          {quickJumpDiagMutation.data ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                {t("settings.quickJumpSummaryPrefix")}{" "}
                {quickJumpDiagMutation.data.totalProjects} ·{" "}
                {t("settings.quickJumpActiveThreadsPrefix")}{" "}
                {quickJumpDiagMutation.data.totalActiveWorkspaces} ·{" "}
                {t("settings.quickJumpEmptyProjectsPrefix")}{" "}
                {quickJumpDiagMutation.data.emptyProjects} ·{" "}
                {quickJumpDiagMutation.data.durationMs}ms
              </Text>
              <Text style={styles.detail}>
                • {quickJumpDiagMutation.data.targetProjectName || "-"} →{" "}
                {quickJumpDiagMutation.data.selectedCandidate?.primaryWorkspaceTitle || "-"} (
                {quickJumpDiagMutation.data.targetWorkspaceId || "sidebar-only"})
              </Text>
              {quickJumpDiagMutation.data.candidates.slice(0, 4).map((cand) => (
                <Text key={cand.projectId} style={styles.detail}>
                  • [{cand.score} pts] {cand.projectName} ({cand.activeWorkspaceCount} threads) —{" "}
                  {cand.shortPath}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionInlineRenameDiag")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>{t("settings.inlineRenameDiagPrompt")}</Text>
          <View style={styles.row}>
            <TextInput
              value={renameDiagInput}
              onChangeText={setRenameDiagInput}
              placeholder={t("settings.inlineRenameDiagPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.inlineRenameInspectBtn")}
              onPress={() => {
                renameInspectMutation.mutate();
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {t("settings.inlineRenameInspectBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.inlineRenameApplyBtn")}
              onPress={() => {
                const trimmed = renameDiagInput.trim();
                if (!trimmed) return;
                renameApplyMutation.mutate({ title: trimmed });
              }}
              style={styles.btn}
            >
              <Icon name="Edit3" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnText}>{t("settings.inlineRenameApplyBtn")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.inlineRenameResetBtn")}
              onPress={() => {
                renameApplyMutation.mutate({ title: null });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.inlineRenameResetBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.inlineRenameTestInlineBtn")}
              onPress={() => {
                const g = globalThis as { document?: unknown; window?: unknown };
                if (g.document && g.window) {
                  const doc = g.document as Parameters<typeof findF2InlineRenameTarget>[0];
                  const win = g.window as Parameters<typeof findF2InlineRenameTarget>[1];
                  const target = findF2InlineRenameTarget(doc, win, resolveActiveWsId());
                  if (target) {
                    const session = mountInlineTitleInput(
                      doc,
                      win ?? null,
                      target,
                      async (nextTitle, meta) => {
                        await renameThread({
                          workspaceId: meta.workspaceId,
                          agentId: meta.agentId,
                          title: nextTitle,
                          source: meta.source,
                        });
                      },
                      undefined,
                      { caretPosition: values.inlineRenameCaretPosition },
                    );
                    if (session) {
                      toast.show(
                        `${t("settings.inlineRenameCaretStatusPrefix")} [${session.inputEl.selectionStart ?? 0}, ${session.inputEl.selectionEnd ?? 0}]`,
                        { variant: "success" },
                      );
                      return;
                    }
                  }
                  const probe = doc.createElement("input");
                  probe.value = "Install Notpamina on two WordPress sites";
                  const res = applyInlineInputCaret(probe, values.inlineRenameCaretPosition);
                  toast.show(
                    `${t("settings.inlineRenameCaretStatusPrefix")} [${res.selectionStart}, ${res.selectionEnd}] · scrollLeft=${res.scrollLeft}`,
                    { variant: "success" },
                  );
                }
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.inlineRenameTestInlineBtn")}
              </Text>
            </Pressable>
          </View>

          <View style={{ gap: 5, marginTop: 4 }}>
            <Text style={styles.detail}>
              • {t("settings.inlineRenameCaretStatusPrefix")}{" "}
              {values.inlineRenameCaretPosition === "start"
                ? t("settings.optCaretStart")
                : values.inlineRenameCaretPosition === "end"
                  ? t("settings.optCaretEnd")
                  : t("settings.optCaretSelectAll")}
            </Text>
            <Text style={styles.detail}>
              •{" "}
              {values.enableInlineDoubleClickRename
                ? t("settings.inlineRenameSurfaces")
                : t("settings.inlineRenameDisabledHint")}
            </Text>
            {renameInspectMutation.data ? (
              <>
                <Text style={styles.detail}>
                  • {t("settings.inlineRenameActiveWs")}{" "}
                  {renameInspectMutation.data.workspaceId || "-"} ·{" "}
                  {t("settings.inlineRenameCurrentTitle")}{" "}
                  {renameInspectMutation.data.workspaceTitle || "-"}
                </Text>
                {(renameApplyMutation.data?.recentActions ??
                  renameInspectMutation.data.recentActions
                )
                  ?.slice(0, 3)
                  .map((act, idx: number) => (
                    <Text key={`${act.timestampIso}-${idx}`} style={styles.detail}>
                      • [{act.target}] {act.resolvedPath} — {act.message}
                    </Text>
                  ))}
              </>
            ) : null}
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionFolderImportDiag")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>{t("settings.folderDiagPrompt")}</Text>
          <View style={styles.row}>
            <TextInput
              value={folderTestInput}
              onChangeText={setFolderTestInput}
              placeholder={t("settings.folderDiagPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("actions.dryRunCheckBtn")}
              onPress={() => {
                const p = folderTestInput.trim() || ".";
                folderDiagMutation.mutate({ path: p, dryRun: true });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>{t("actions.dryRunCheckBtn")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("actions.importFolderBtn")}
              onPress={() => {
                const p = folderTestInput.trim() || ".";
                folderDiagMutation.mutate({ path: p, dryRun: false });
              }}
              style={styles.btn}
            >
              <Icon name="FolderPlus" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnText}>{t("actions.importFolderBtn")}</Text>
            </Pressable>
          </View>

          {folderDiagMutation.data ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                {folderDiagMutation.data.reusedCount > 0
                  ? t("settings.folderDiagStatusReused")
                  : t("settings.folderDiagStatusCreated")}
              </Text>
              <Text style={styles.detail}>
                • {t("settings.folderDiagWorkspaceId")}{" "}
                {folderDiagMutation.data.primaryWorkspaceId || "-"} (
                {folderDiagMutation.data.primaryWorkspaceName || "-"})
              </Text>
              <Text style={styles.detail}>
                • {t("settings.folderDiagDirectory")}{" "}
                {folderDiagMutation.data.primaryDirectory || "-"} ·{" "}
                {folderDiagMutation.data.durationMs}ms
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionDiagnostic")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>{t("settings.diagPrompt")}</Text>
          <View style={styles.row}>
            <TextInput
              value={testInput}
              onChangeText={setTestInput}
              placeholder={t("settings.diagPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.diagRunBtn")}
              onPress={() => diagMutation.mutate(testInput.trim() || ".")}
              style={styles.btn}
            >
              <Icon name="Activity" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnText}>{t("settings.diagRunBtn")}</Text>
            </Pressable>
          </View>

          {diagMutation.data ? (
            <View style={{ gap: 6, marginTop: 6 }}>
              <Text style={styles.label}>
                {diagMutation.data.resolvedMetadata.exists
                  ? t("settings.diagExists")
                  : t("settings.diagMissing")}
              </Text>
              <Text style={styles.detail}>
                • {t("settings.diagResolvedPath")} {diagMutation.data.resolvedMetadata.absolutePath}
              </Text>
              <Text style={styles.detail}>
                • {t("settings.diagParentDir")} {diagMutation.data.resolvedMetadata.parentDir}
              </Text>
              <Text style={styles.detail}>
                • {t("settings.diagFileMeta")} {diagMutation.data.resolvedMetadata.sizeFormatted}
                {diagMutation.data.resolvedMetadata.width
                  ? ` · ${diagMutation.data.resolvedMetadata.width}×${diagMutation.data.resolvedMetadata.height} px`
                  : ""}{" "}
                · {t("settings.diagModified")} {diagMutation.data.resolvedMetadata.modifiedRelative}
              </Text>
              <View style={styles.row}>
                {diagMutation.data.availableTargets.map((targetItem) => (
                  <Pressable
                    key={targetItem.target}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("settings.diagTestPrefix")} ${targetItem.label}`}
                    onPress={() =>
                      openMutation.mutate({
                        path: diagMutation.data.resolvedMetadata.absolutePath,
                        target: targetItem.target,
                      })
                    }
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryBtnText}>
                      {t("settings.diagTestPrefix")} {targetItem.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "定时任务运行历史与防卡死对账器 (Schedules Runs & Anti-Freeze Inspector)"
            : "Schedule Runs & Anti-Freeze DOM Inspector (⌘⇧H)"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "实时读取 Paseo 全部定时任务与 AG 灾备孪生运行历史（runs[]），监控 Schedules DOM 观察器与防卡死熔断器状态（能读 / 能试 / 能调）："
              : "Inspect live Paseo schedule run history, monitor the Schedules DOM observer & anti-freeze circuit breaker, or run an idempotency self-test:"}
          </Text>

          <View
            style={{
              padding: 8,
              borderRadius: 6,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: theme.colors.border,
              gap: 4,
            }}
          >
            <Text style={styles.label}>
              • DOM Guard:{" "}
              {!scheduleDomHealth.enabled
                ? "DISABLED"
                : scheduleDomHealth.circuitBreakerTripped
                  ? "TRIPPED (Auto-Protected)"
                  : "HEALTHY · rAF Coalesced + Idempotent"}
              {" · "}source={scheduleDomHealth.sourceBadge}
              {" · "}observer={scheduleDomHealth.observerConnected ? "connected" : "idle"}
            </Text>
            <Text style={styles.detail}>
              • Passes: {scheduleDomHealth.totalPasses} (writes={scheduleDomHealth.writePasses}, no-op skipped={scheduleDomHealth.skippedNoOpPasses}, self-mutations ignored={scheduleDomHealth.ignoredSelfMutationBatches}) · lastPass={scheduleDomHealth.lastPassDurationMs}ms · rows={scheduleDomHealth.lastDecoratedRowCount} · cachedSchedules={scheduleDomHealth.cachedScheduleCount}
            </Text>
            {scheduleDomHealth.circuitBreakerReason ? (
              <Text style={styles.label}>
                • Reason: {scheduleDomHealth.circuitBreakerReason}
              </Text>
            ) : null}
            {scheduleDomSelfTest ? (
              <Text style={styles.label}>
                • Self-Test: {scheduleDomSelfTest.summary}
              </Text>
            ) : null}
          </View>

          <View style={styles.row}>
            <TextInput
              value={scheduleRunsQueryInput}
              onChangeText={setScheduleRunsQueryInput}
              placeholder={
                isZh
                  ? "筛选任务名/ID（留空默认列出有运行记录的任务）..."
                  : "Filter schedule name or ID (leave empty for schedules with runs)..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setScheduleDomHealth(getScheduleRunsDomHealthSnapshot());
                void inspectScheduleRuns({
                  query: scheduleRunsQueryInput.trim() || undefined,
                  onlyWithRuns: !scheduleRunsQueryInput.trim(),
                  includeWorkspaceNames: true,
                  maxRunsPerSchedule: 15,
                }).then((res) => {
                  setScheduleRunsDiagData(res);
                  setScheduleDomHealth(getScheduleRunsDomHealthSnapshot());
                });
              }}
              style={styles.btn}
            >
              <Icon name="Clock" size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnText}>
                {isZh ? "读取运行账本" : "Inspect Runs"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const testRes = runScheduleRunsDomIdempotencySelfTest();
                setScheduleDomSelfTest(testRes);
                setScheduleDomHealth(getScheduleRunsDomHealthSnapshot());
                if (testRes.ok) {
                  toast.show(testRes.summary, { variant: "success" });
                } else {
                  toast.error(testRes.summary);
                }
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {isZh ? "防卡死幂等自检 (能试)" : "DOM Self-Test"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const nextSnap = resetScheduleRunsDomCircuitBreaker();
                setScheduleDomHealth(nextSnap);
                toast.show(
                  isZh
                    ? "已重置熔断保护器并刷新 Schedules 缓存"
                    : "Reset DOM circuit breaker & refreshed schedule cache",
                  { variant: "success" },
                );
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "重置熔断并刷新 (能调)" : "Reset & Refresh"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                triggerScheduleRunsDrawer(scheduleRunsQueryInput.trim() || null)
              }
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "打开运行抽屉 (⌘⇧H)" : "Open Runs Drawer (⌘⇧H)"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void openScheduleRunSession({
                  action: "recover-due",
                  scheduleId: scheduleRunsQueryInput.trim(),
                  dryRun: false,
                }).then((res) => {
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "自愈补跑失败槽位 (能调)" : "Recover Failed Slots"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void openScheduleRunSession({
                  action: "auto-evolve",
                  scheduleId: scheduleRunsQueryInput.trim(),
                  dryRun: true,
                }).then((res) => {
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "预演自演进 (能试)" : "Dry-Run Auto-Evolve"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void openScheduleRunSession({
                  action: "auto-evolve",
                  scheduleId: scheduleRunsQueryInput.trim(),
                  dryRun: false,
                }).then((res) => {
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "一键自演进与双端同步 (能调)" : "Auto-Evolve & Sync Twins"}
              </Text>
            </Pressable>
          </View>

          {scheduleRunsDiagData ? (
            <View style={{ gap: 6, marginTop: 6 }}>
              <Text style={styles.label}>
                {isZh
                  ? `已扫描 ${scheduleRunsDiagData.totalSchedules} 个任务 · ${scheduleRunsDiagData.schedulesWithRuns} 个含运行记录 · 共 ${scheduleRunsDiagData.totalRuns} 次运行（✓ ${scheduleRunsDiagData.succeededRuns} / ✕ ${scheduleRunsDiagData.failedRuns}）· ${scheduleRunsDiagData.durationMs}ms`
                  : `Scanned ${scheduleRunsDiagData.totalSchedules} schedules · ${scheduleRunsDiagData.schedulesWithRuns} with runs · ${scheduleRunsDiagData.totalRuns} total runs (✓ ${scheduleRunsDiagData.succeededRuns} / ✕ ${scheduleRunsDiagData.failedRuns}) · ${scheduleRunsDiagData.durationMs}ms`}
              </Text>
              {scheduleRunsDiagData.recentRuns.slice(0, 6).map((runItem) => (
                <View
                  key={runItem.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    paddingVertical: 4,
                  }}
                >
                  <Text style={[styles.detail, { flex: 1 }]} numberOfLines={1}>
                    • [{runItem.status === "succeeded" ? "✓" : "✕"}]{" "}
                    {runItem.scheduleName} ({runItem.durationFormatted}) —{" "}
                    {runItem.workspaceName || runItem.outputPreview}
                  </Text>
                  {runItem.workspaceId ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void openScheduleRunSession({
                          action: "open-run",
                          scheduleId: runItem.scheduleId,
                          runId: runItem.id,
                          workspaceId: runItem.workspaceId ?? undefined,
                          agentId: runItem.agentId ?? undefined,
                          dryRun: false,
                        }).then((res) => {
                          if (res.workspaceId) {
                            navigateToPaseoWorkspace(res.workspaceId, res.agentId);
                          }
                        });
                      }}
                      style={styles.secondaryBtn}
                    >
                      <Text style={styles.secondaryBtnText}>
                        {isZh ? "进入对话 ↗" : "Open Chat ↗"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionSidebarDefaultCollapse")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.sidebarCollapseStatusPrefix")}{" "}
            {sidebarCollapseStatus
              ? `${sidebarCollapseStatus.prefs.enabled ? "on" : "off"} · installed=${sidebarCollapseStatus.installed} · visible=${sidebarCollapseStatus.projects.length} · open=${sidebarCollapseStatus.projects.filter((p) => p.expanded).length} · remembered=${sidebarCollapseStatus.knownCount ?? "none yet"}`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              onPress={() => setSidebarCollapseStatus(runSidebarDefaultCollapseSelfTest())}
            >
              <Text style={styles.btnText}>{t("settings.sidebarCollapseSelfTestBtn")}</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => {
                collapseEmptySidebarProjectsNow();
                setSidebarCollapseStatus(getSidebarDefaultCollapseStatus());
              }}
            >
              <Text style={styles.btnText}>{t("settings.sidebarCollapseTidyBtn")}</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settings.sidebarCollapseReceiptsTitle")}</Text>
          {sidebarCollapseStatus && sidebarCollapseStatus.receipts.length > 0 ? (
            sidebarCollapseStatus.receipts.slice(0, 6).map((r) => (
              <Text key={`${r.at}-${r.trigger}`} style={styles.detail}>
                • {r.ok ? "✓" : "✕"} {r.at.slice(11, 19)} [{r.trigger}] {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.sidebarCollapseNoReceipts")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionSidebarChildSessions")}>
        <SettingsSwitch
          label={t("settings.sidebarChildEnabledLabel")}
          hint={t("settings.sidebarChildEnabledHint")}
          value={sidebarChildStatus?.prefs.enabled ?? true}
          onValueChange={(next) => {
            syncSidebarChildSessionsPrefs({ enabled: next });
            setSidebarChildStatus(getSidebarChildSessionsStatus());
            setSidebarChildChecks(null);
          }}
        />
        <SettingsSwitch
          label={t("settings.sidebarChildTabsLabel")}
          hint={t("settings.sidebarChildTabsHint")}
          value={sidebarChildStatus?.prefs.tabChildren ?? true}
          onValueChange={(next) => {
            syncSidebarChildSessionsPrefs({ tabChildren: next });
            setSidebarChildStatus(getSidebarChildSessionsStatus());
            setSidebarChildChecks(null);
          }}
        />
        <SettingsSelect
          label={t("settings.sidebarChildModelIconsLabel")}
          hint={t("settings.sidebarChildModelIconsHint")}
          value={normalizeSubsessionModelIconMode(sidebarChildStatus?.prefs.modelIcons)}
          options={[
            { label: t("settings.sidebarChildModelIconsAlways"), value: "always" },
            { label: t("settings.sidebarChildModelIconsDifferent"), value: "different" },
            { label: t("settings.sidebarChildModelIconsOff"), value: "off" },
          ]}
          onValueChange={(next) => {
            syncSidebarChildSessionsPrefs({
              modelIcons: normalizeSubsessionModelIconMode(next),
            });
            setSidebarChildStatus(getSidebarChildSessionsStatus());
            setSidebarChildChecks(null);
          }}
        />
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.sidebarChildStatusPrefix")}{" "}
            {sidebarChildStatus
              ? `${sidebarChildStatus.prefs.enabled ? "on" : "off"} · store=${sidebarChildStatus.storeFound ? "found" : "missing"} · nested workspaces=${sidebarChildStatus.nested.length} · tab sub-sessions=${sidebarChildStatus.tabRows.reduce((n, r) => n + r.count, 0)} · model icons=${normalizeSubsessionModelIconMode(sidebarChildStatus.prefs.modelIcons)} (${sidebarChildStatus.modelIconsShown ?? 0} shown · ${sidebarChildStatus.crossModelCount ?? 0} cross-model) · kept at top=${sidebarChildStatus.skipped.length} · render ${sidebarChildStatus.renderMs} ms`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              onPress={() => {
                setSidebarChildChecks(runSidebarChildSessionsSelfTest());
                setSidebarChildStatus(getSidebarChildSessionsStatus());
              }}
            >
              <Text style={styles.btnText}>{t("settings.sidebarChildSelfTestBtn")}</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => {
                syncSidebarChildSessionsPrefs({
                  enabled: true,
                  tabChildren: true,
                  modelIcons: DEFAULT_SUBSESSION_MODEL_ICON_MODE,
                });
                setSidebarChildStatus(getSidebarChildSessionsStatus());
                setSidebarChildChecks(null);
              }}
            >
              <Text style={styles.btnText}>{t("settings.sidebarChildResetBtn")}</Text>
            </Pressable>
          </View>
          {sidebarChildChecks
            ? sidebarChildChecks.map((c) => (
                <Text key={`check-${c.name}`} style={styles.detail}>
                  • {c.ok ? "✓" : "✕"} {c.name}: {c.detail}
                </Text>
              ))
            : null}
          <Text style={styles.detail}>{t("settings.sidebarChildNestedTitle")}</Text>
          {sidebarChildStatus && sidebarChildStatus.nested.length > 0 ? (
            sidebarChildStatus.nested.slice(0, 12).map((n) => (
              <Text key={`nested-${n.workspaceId}`} style={styles.detail}>
                • {n.title} ← {n.parentTitle}
                {n.modelSummary ? ` · ${n.modelSummary}${n.differsFromParent ? " *" : ""}` : ""}
                {n.onScreen ? "" : " (not on screen)"}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.sidebarChildNone")}</Text>
          )}
          <Text style={styles.detail}>{t("settings.sidebarChildSkippedTitle")}</Text>
          {sidebarChildStatus && sidebarChildStatus.skipped.length > 0 ? (
            sidebarChildStatus.skipped.slice(0, 12).map((s) => (
              <Text key={`skip-${s.agentId}`} style={styles.detail}>
                • {s.title} #{s.agentId.slice(0, 8)}: {describeSkipReason(s.reason, isZh)}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.sidebarChildNone")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settingsSearch.cardTitle")}>
        <SettingsSwitch
          label={t("settingsSearch.enableLabel")}
          hint={t("settingsSearch.enableHint")}
          value={values.enableSettingsSearch}
          onValueChange={(next) => {
            syncSettingsSearchPrefs({ enabled: next });
            setSettingsSearchStatus(getSettingsSearchStatus());
            void save({ ...values, enableSettingsSearch: next }, revision);
          }}
        />
        <SettingsSwitch
          label={t("settingsSearch.shortcutLabel")}
          hint={t("settingsSearch.shortcutHint")}
          value={values.settingsSearchShortcut}
          onValueChange={(next) => {
            syncSettingsSearchPrefs({ shortcut: next });
            setSettingsSearchStatus(getSettingsSearchStatus());
            void save({ ...values, settingsSearchShortcut: next }, revision);
          }}
        />
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settingsSearch.statusPrefix")}{" "}
            {settingsSearchStatus
              ? `${settingsSearchStatus.prefs.enabled ? "on" : "off"} · ${settingsSearchStatus.merged.pages} pages / ${settingsSearchStatus.merged.rows} rows · learned ${settingsSearchStatus.live.pages} pages${settingsSearchStatus.live.newest ? ` (latest ${settingsSearchStatus.live.newest.slice(5, 16).replace("T", " ")})` : ""} · seed Paseo ${settingsSearchStatus.seed.paseoVersion} (${settingsSearchStatus.seed.generatedAt}) · field ${settingsSearchStatus.mounted ? "on screen" : "off screen"}`
              : "-"}
          </Text>
          {settingsSearchStatus && settingsSearchStatus.merged.emptyPages.length > 0 ? (
            <Text style={styles.detail}>
              {t("settingsSearch.emptyPagesPrefix")} {settingsSearchStatus.merged.emptyPages.join(", ")}
            </Text>
          ) : null}
          <View style={styles.row}>
            <TextInput
              value={settingsSearchQuery}
              onChangeText={setSettingsSearchQuery}
              onSubmitEditing={() =>
                setSettingsSearchStatus(runSettingsSearchSelfTest(settingsSearchQuery.trim()))
              }
              placeholder={t("settingsSearch.testPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              style={styles.btn}
              onPress={() =>
                setSettingsSearchStatus(runSettingsSearchSelfTest(settingsSearchQuery.trim()))
              }
            >
              <Text style={styles.btnText}>{t("settingsSearch.testBtn")}</Text>
            </Pressable>
          </View>
          {settingsSearchStatus?.lastTest ? (
            <View>
              <Text style={styles.detail}>
                "{settingsSearchStatus.lastTest.query}" → {settingsSearchStatus.lastTest.count}
              </Text>
              {settingsSearchStatus.lastTest.top.map((row) => (
                <Text key={`${row.where}-${row.title}`} style={styles.detail}>
                  • {row.where} › {row.title} [{row.field === 0 ? "title" : row.field === 1 ? "page" : "hint"} · {row.source}]
                </Text>
              ))}
            </View>
          ) : null}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              style={styles.btn}
              disabled={Boolean(settingsSearchStatus?.rebuilding)}
              onPress={() => {
                void rebuildSettingsIndex().then(setSettingsSearchStatus);
              }}
            >
              <Text style={styles.btnText}>
                {settingsSearchStatus?.rebuilding
                  ? t("settingsSearch.rebuildingBtn")
                      .replace("{done}", String(settingsSearchStatus.rebuilding.done))
                      .replace("{total}", String(settingsSearchStatus.rebuilding.total))
                  : t("settingsSearch.rebuildBtn")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.btn}
              onPress={() => setSettingsSearchStatus(resetLearnedSettingsPages())}
            >
              <Text style={styles.btnText}>{t("settingsSearch.resetBtn")}</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settingsSearch.receiptsTitle")}</Text>
          {settingsSearchStatus && settingsSearchStatus.receipts.length > 0 ? (
            settingsSearchStatus.receipts.slice(0, 6).map((r) => (
              <Text key={`${r.at}-${r.trigger}-${r.outcome}`} style={styles.detail}>
                • {r.ok ? "✓" : "✕"} {r.at.slice(11, 19)} [{r.trigger}] {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settingsSearch.noReceipts")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionModelQuickSwitch")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.modelQuickSwitchStatusPrefix")}{" "}
            {modelSwitchStatus
              ? `${modelSwitchStatus.prefs.enabled ? "on" : "off"} · digits=${modelSwitchStatus.prefs.digitMode} · installed=${modelSwitchStatus.installed}`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              onPress={() => setModelSwitchStatus(runModelQuickSwitchSelfTest())}
            >
              <Text style={styles.btnText}>{t("settings.modelQuickSwitchSelfTestBtn")}</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settings.modelQuickSwitchReceiptsTitle")}</Text>
          {modelSwitchStatus && modelSwitchStatus.receipts.length > 0 ? (
            modelSwitchStatus.receipts.slice(0, 6).map((r) => (
              <Text key={`${r.at}-${r.trigger}`} style={styles.detail}>
                • {r.ok ? "✓" : "✕"} {r.at.slice(11, 19)} [{r.trigger}] {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.modelQuickSwitchNoReceipts")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionProjectPickerShortcut")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.projectPickerStatusPrefix")}{" "}
            {projectPickerStatus
              ? `${projectPickerStatus.prefs.enabled ? "on" : "off"} · chord=${projectPickerStatus.displayShortcut} (${projectPickerStatus.prefs.preset}) · installed=${projectPickerStatus.installed} · triggers=${projectPickerStatus.triggersVisible} · project="${projectPickerStatus.currentProject ?? "none"}" · picker=${projectPickerStatus.pickerOpen ? "open" : "closed"}`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.projectPickerSelfTestBtn")}
              onPress={() => setProjectPickerStatus(runProjectPickerShortcutSelfTest())}
            >
              <Text style={styles.btnText}>{t("settings.projectPickerSelfTestBtn")}</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.projectPickerResetBtn")}
              onPress={resetProjectPickerShortcutToDefault}
            >
              <Text style={styles.btnText}>{t("settings.projectPickerResetBtn")}</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settings.projectPickerReceiptsTitle")}</Text>
          {projectPickerStatus && projectPickerStatus.receipts.length > 0 ? (
            projectPickerStatus.receipts.slice(0, 6).map((r, idx) => (
              <Text key={`${r.at}-${r.trigger}-${idx}`} style={styles.detail}>
                • [{r.ok ? "OK" : "ERR"}] {r.at.slice(11, 19)} [{r.trigger}] {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.projectPickerNoReceipts")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionSidebarGroupingShortcut")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.sidebarGroupingStatusPrefix")}{" "}
            {sidebarGroupingStatus
              ? `${sidebarGroupingStatus.prefs.enabled ? "on" : "off"} · active=${sidebarGroupingStatus.currentMode} · project=${sidebarGroupingStatus.displayProjectShortcut} · status=${sidebarGroupingStatus.displayStatusShortcut} (${sidebarGroupingStatus.prefs.preset}) · toggleOnRePress=${sidebarGroupingStatus.prefs.toggleOnRePress} · store=${sidebarGroupingStatus.storeAvailable} · installed=${sidebarGroupingStatus.installed}`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.sidebarGroupingTestProjectBtn")}
              onPress={() => {
                switchSidebarGrouping("project", { trigger: "project" });
                setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
              }}
            >
              <Text style={styles.btnText}>{t("settings.sidebarGroupingTestProjectBtn")}</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.sidebarGroupingTestStatusBtn")}
              onPress={() => {
                switchSidebarGrouping("status", { trigger: "status" });
                setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
              }}
            >
              <Text style={styles.btnText}>{t("settings.sidebarGroupingTestStatusBtn")}</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.sidebarGroupingTestToggleBtn")}
              onPress={() => {
                switchSidebarGrouping("toggle", { trigger: "toggle" });
                setSidebarGroupingStatus(getSidebarGroupingShortcutStatus());
              }}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.sidebarGroupingTestToggleBtn")}
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.sidebarGroupingSelfTestBtn")}
              onPress={() => setSidebarGroupingStatus(runSidebarGroupingShortcutSelfTest())}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.sidebarGroupingSelfTestBtn")}
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel={t("settings.projectPickerResetBtn")}
              onPress={resetSidebarGroupingShortcutToDefault}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.projectPickerResetBtn")}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settings.sidebarGroupingReceiptsTitle")}</Text>
          {sidebarGroupingStatus && sidebarGroupingStatus.receipts.length > 0 ? (
            sidebarGroupingStatus.receipts.slice(0, 6).map((r, idx) => (
              <Text key={`${r.at}-${r.trigger}-${idx}`} style={styles.detail}>
                • [{r.ok ? "OK" : "ERR"}] {r.at.slice(11, 19)} [{r.trigger}] {r.prevMode} → {r.nextMode} · {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.sidebarGroupingNoReceipts")}</Text>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionVoiceSttDiag")}>
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {t("settings.dictationGuardStatusPrefix")}{" "}
            {dictationGuardStatus
              ? `${dictationGuardStatus.policy} · installed=${dictationGuardStatus.installed} · overlay=${dictationGuardStatus.overlayState} · autoSendRef=${dictationGuardStatus.autoSendRefBound ? "bound" : "not-found"}`
              : "-"}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.btn}
              onPress={() => setDictationGuardStatus(runDictationGuardSelfTest())}
            >
              <Text style={styles.btnText}>{t("settings.dictationGuardSelfTestBtn")}</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>{t("settings.dictationGuardReceiptsTitle")}</Text>
          {dictationGuardStatus && dictationGuardStatus.receipts.length > 0 ? (
            dictationGuardStatus.receipts.slice(0, 5).map((r) => (
              <Text key={`${r.at}-${r.trigger}`} style={styles.detail}>
                • {r.ok ? "✓" : "✕"} {r.at.slice(11, 19)} [{r.trigger}] {r.outcome}
              </Text>
            ))
          ) : (
            <Text style={styles.detail}>{t("settings.dictationGuardNoReceipts")}</Text>
          )}
        </View>
        <View style={styles.diagBox}>
          <Text style={styles.label}>{t("settings.voiceSttDiagPrompt")}</Text>

          <View style={styles.row}>
            {VOICE_STT_PRESETS.map((preset) => {
              const isSelected =
                voiceSnapData?.dictationStt.model.toLowerCase() ===
                preset.model.toLowerCase();
              return (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  onPress={() => {
                    setVoiceModelInput(preset.model);
                    setVoiceBaseUrlInput(preset.baseUrl);
                    void manageVoiceStt({
                      action: "apply",
                      presetId: preset.id,
                      model: preset.model,
                      source: "settings-ui",
                    }).then((res) => {
                      setVoiceSnapData(res);
                      setVoiceModelInput(res.dictationStt.model);
                      if (res.dictationStt.baseUrl) {
                        setVoiceBaseUrlInput(res.dictationStt.baseUrl);
                      }
                      if (res.ok) {
                        toast.show(res.message, { variant: "success" });
                      } else {
                        toast.error(res.message);
                      }
                    });
                  }}
                  style={isSelected ? styles.btn : styles.secondaryBtn}
                >
                  <Text style={isSelected ? styles.btnText : styles.secondaryBtnText}>
                    {isZh ? preset.labelZh : preset.label} ({preset.badge})
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.row}>
            <TextInput
              value={voiceModelInput}
              onChangeText={setVoiceModelInput}
              placeholder={t("settings.voiceSttModelPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <TextInput
              value={voiceBaseUrlInput}
              onChangeText={setVoiceBaseUrlInput}
              placeholder={t("settings.voiceSttBaseUrlPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
          </View>

          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageVoiceStt({
                  action: "inspect",
                  source: "settings-ui",
                }).then((res) => {
                  setVoiceSnapData(res);
                  setVoiceModelInput(res.dictationStt.model);
                  if (res.dictationStt.baseUrl) {
                    setVoiceBaseUrlInput(res.dictationStt.baseUrl);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {t("settings.voiceSttInspectBtn")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const m = voiceModelInput.trim();
                if (!m) return;
                void manageVoiceStt({
                  action: "apply",
                  model: m,
                  baseUrl: voiceBaseUrlInput.trim() || undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setVoiceSnapData(res);
                  setVoiceModelInput(res.dictationStt.model);
                  if (res.dictationStt.baseUrl) {
                    setVoiceBaseUrlInput(res.dictationStt.baseUrl);
                  }
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>{t("settings.voiceSttApplyBtn")}</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageVoiceStt({
                  action: "test",
                  model: voiceModelInput.trim() || undefined,
                  baseUrl: voiceBaseUrlInput.trim() || undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setVoiceSnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.voiceSttTestBtn")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageVoiceStt({
                  action: "reset",
                  source: "settings-ui",
                }).then((res) => {
                  setVoiceSnapData(res);
                  setVoiceModelInput(res.dictationStt.model);
                  setVoiceBaseUrlInput(res.dictationStt.baseUrl);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("settings.voiceSttResetBtn")}
              </Text>
            </Pressable>
          </View>

          {voiceSnapData ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                • Dictation STT: {voiceSnapData.dictationStt.provider} ·{" "}
                {voiceSnapData.dictationStt.model} ({voiceSnapData.dictationStt.sourceBadge})
              </Text>
              <Text style={styles.detail}>
                • Base URL: {voiceSnapData.dictationStt.baseUrl || "local"} · API Key:{" "}
                {voiceSnapData.dictationStt.apiKeyPreview || "none"} · Audio Pool Gateway (:8787):{" "}
                {voiceSnapData.gateway.reachable
                  ? `ONLINE (${voiceSnapData.gateway.healthyKeys}/${voiceSnapData.gateway.totalKeys} Gemini keys · SiliconFlow=${voiceSnapData.gateway.siliconflowConfigured})`
                  : "OFFLINE"}
              </Text>
              {voiceSnapData.testResult ? (
                <Text style={styles.label}>
                  • {voiceSnapData.testResult.ok ? "✓" : "✕"} [{voiceSnapData.testResult.provider} ·{" "}
                  {voiceSnapData.testResult.model}] {voiceSnapData.testResult.latencyMs}ms —{" "}
                  {voiceSnapData.testResult.ok
                    ? `"${voiceSnapData.testResult.transcript}"`
                    : voiceSnapData.testResult.error}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "Customize 控制面：斜杠命令、Skills、Rules、Subagents、MCPs 与插件 (能读 / 能试 / 能调)"
            : "Customize: Slash Commands, Skills, Rules, Subagents, MCPs & Plugins"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "对标 Cursor Customize 统一管理面：检索、置顶 (★ Pin)、启用/禁用 947 项斜杠命令与 Skills，盘点 Rules / Subagents / MCPs / Plugins，并测试多 Skill 句中展开："
              : "Unified Customize control plane: filter, ★ Pin to top of `/` autocomplete, Enable/Disable across 947 Slash Commands & Skills, inspect Rules / Subagents / MCPs / Plugins, and dry-run multi-skill prompt expansion:"}
          </Text>

          <View style={styles.row}>
            {(
              [
                { id: "all", label: isZh ? "全部" : "All", count: undefined },
                {
                  id: "commands",
                  label: isZh ? "Commands" : "Commands",
                  count: customizeSnapData?.customizeCounts.commands,
                },
                {
                  id: "skills",
                  label: isZh ? "Skills" : "Skills",
                  count: customizeSnapData?.customizeCounts.skills,
                },
                {
                  id: "rules",
                  label: isZh ? "Rules" : "Rules",
                  count: customizeSnapData?.customizeCounts.rules,
                },
                {
                  id: "subagents",
                  label: isZh ? "Subagents" : "Subagents",
                  count: customizeSnapData?.customizeCounts.subagents,
                },
                {
                  id: "mcps",
                  label: isZh ? "MCPs" : "MCPs",
                  count: customizeSnapData?.customizeCounts.mcps,
                },
                {
                  id: "plugins",
                  label: isZh ? "Plugins" : "Plugins",
                  count: customizeSnapData?.customizeCounts.plugins,
                },
              ] as const
            ).map((cat) => {
              const active = customizeCategory === cat.id;
              return (
                <Pressable
                  key={cat.id}
                  accessibilityRole="button"
                  onPress={() => {
                    setCustomizeCategory(cat.id);
                    void manageSlashSkills({
                      action: "status",
                      category: cat.id,
                      scope: customizeScope,
                      query: customizeSearchInput.trim() || undefined,
                      limit: 120,
                      source: "settings-ui",
                    }).then(setCustomizeSnapData);
                  }}
                  style={active ? styles.btn : styles.secondaryBtn}
                >
                  <Text style={active ? styles.btnText : styles.secondaryBtnText}>
                    {cat.label}
                    {typeof cat.count === "number" ? ` (${cat.count})` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.row}>
            {(
              [
                { id: "all", label: isZh ? "全部范围" : "All Scopes" },
                {
                  id: "pinned",
                  label: isZh
                    ? `★ 已置顶 (${customizeSnapData?.pinnedCount ?? 0})`
                    : `★ Pinned (${customizeSnapData?.pinnedCount ?? 0})`,
                },
                { id: "workspace", label: isZh ? "当前工作区" : "Workspace" },
                { id: "user", label: isZh ? "全局 (Vec Yang)" : "User Global" },
                {
                  id: "disabled",
                  label: isZh
                    ? `已禁用 (${customizeSnapData?.disabledCount ?? 0})`
                    : `Disabled (${customizeSnapData?.disabledCount ?? 0})`,
                },
              ] as const
            ).map((sc) => {
              const active = customizeScope === sc.id;
              return (
                <Pressable
                  key={sc.id}
                  accessibilityRole="button"
                  onPress={() => {
                    setCustomizeScope(sc.id);
                    void manageSlashSkills({
                      action: "status",
                      category: customizeCategory,
                      scope: sc.id,
                      query: customizeSearchInput.trim() || undefined,
                      limit: 120,
                      source: "settings-ui",
                    }).then(setCustomizeSnapData);
                  }}
                  style={active ? styles.btn : styles.secondaryBtn}
                >
                  <Text style={active ? styles.btnText : styles.secondaryBtnText}>{sc.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.row}>
            <TextInput
              value={customizeSearchInput}
              onChangeText={setCustomizeSearchInput}
              placeholder={
                isZh
                  ? "搜索 Commands, Skills, Rules, Subagents, MCPs, Plugins (如 wheel-check, boost, plan)..."
                  : "Search Commands, Skills, Rules, Subagents, MCPs, Plugins (e.g. wheel-check, boost, plan)..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageSlashSkills({
                  action: "status",
                  category: customizeCategory,
                  scope: customizeScope,
                  query: customizeSearchInput.trim() || undefined,
                  limit: 120,
                  source: "settings-ui",
                }).then((res) => {
                  setCustomizeSnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Search" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>{isZh ? "筛选 (能读)" : "Filter"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageSlashSkills({
                  action: "sync",
                  category: customizeCategory,
                  scope: customizeScope,
                  query: customizeSearchInput.trim() || undefined,
                  limit: 120,
                  source: "settings-ui",
                }).then((res) => {
                  setCustomizeSnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "⚡ 同步全量目录与补丁 (能调)" : "⚡ Sync Catalog & Patches"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageSlashSkills({
                  action: "reset-pins",
                  category: customizeCategory,
                  scope: customizeScope,
                  query: customizeSearchInput.trim() || undefined,
                  limit: 120,
                  source: "settings-ui",
                }).then((res) => {
                  setCustomizeSnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "重置默认置顶" : "Reset Default Pins"}
              </Text>
            </Pressable>
          </View>

          <View style={styles.row}>
            <TextInput
              value={customizeDryRunInput}
              onChangeText={setCustomizeDryRunInput}
              placeholder={
                isZh
                  ? "干跑测试多 Skill 展开，例如：请用 /wheel-check 和 /graphify 检查架构"
                  : "Dry-run multi-skill prompt expansion, e.g. check architecture with /wheel-check and /graphify"
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageSlashSkills({
                  action: "test",
                  samplePrompt:
                    customizeDryRunInput.trim() ||
                    "check architecture with /wheel-check and /1password",
                  category: customizeCategory,
                  scope: customizeScope,
                  query: customizeSearchInput.trim() || undefined,
                  limit: 120,
                  source: "settings-ui",
                }).then((res) => {
                  setCustomizeSnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {isZh ? "干跑测试 /skill 展开 (能试)" : "Dry-Run /skill Expansion"}
              </Text>
            </Pressable>
          </View>

          {customizeSnapData ? (
            <View style={{ gap: 6, marginTop: 6 }}>
              <Text style={styles.label}>
                • Catalog: {customizeSnapData.totalAdvertised} exported (`/`) · Commands=
                {customizeSnapData.customizeCounts.commands} · Skills=
                {customizeSnapData.customizeCounts.skills} · Rules=
                {customizeSnapData.customizeCounts.rules} · Subagents=
                {customizeSnapData.customizeCounts.subagents} · MCPs=
                {customizeSnapData.customizeCounts.mcps} · Plugins=
                {customizeSnapData.customizeCounts.plugins} · Source:{" "}
                {customizeSnapData.configSource}
              </Text>
              <Text style={styles.detail}>
                • ★ Pinned ({customizeSnapData.pinnedCount}):{" "}
                {customizeSnapData.pinnedSlashCommands
                  .slice(0, 12)
                  .map((s: string) => `/${s}`)
                  .join(", ")}
                {customizeSnapData.pinnedSlashCommands.length > 12 ? " ..." : ""} · Disabled (
                {customizeSnapData.disabledCount}):{" "}
                {customizeSnapData.disabledSlashCommands.length > 0
                  ? customizeSnapData.disabledSlashCommands.map((s: string) => `/${s}`).join(", ")
                  : "none"}
              </Text>

              {customizeSnapData.dryRun.resolutions.length > 0 ? (
                <View style={{ gap: 3, marginTop: 2 }}>
                  <Text style={styles.label}>
                    {isZh ? "• 多 Skill 干跑解析结果：" : "• Multi-Skill Dry-Run Resolution:"}
                  </Text>
                  {customizeSnapData.dryRun.resolutions.map((r, idx) => (
                    <Text key={`${r.slug}-${idx}`} style={styles.detail}>
                      {"  "}✓ {r.token} [{r.mode} · {r.status}] → {r.path || "(built-in)"} (
                      {r.injected_chars} chars)
                    </Text>
                  ))}
                </View>
              ) : null}

              <View style={{ gap: 4, marginTop: 4 }}>
                {customizeSnapData.customizeItems.slice(0, 18).map((item) => {
                  const canPinOrDisable =
                    item.category === "commands" || item.category === "skills";
                  const isDisabled = !item.enabled;
                  return (
                    <View
                      key={`${item.category}-${item.name}`}
                      style={[
                        styles.row,
                        {
                          justifyContent: "space-between",
                          paddingVertical: 4,
                          borderBottomWidth: 1,
                          borderBottomColor: theme.colors.border,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={styles.label}>
                          {item.pinned ? "★ " : ""}
                          {canPinOrDisable ? `/${item.name}` : item.name}{" "}
                          <Text style={styles.detail}>
                            [{item.category} · {item.source}
                            {isDisabled ? " · DISABLED" : ""}]
                          </Text>
                        </Text>
                        <Text style={styles.detail} numberOfLines={1}>
                          {item.description}
                        </Text>
                      </View>
                      <View style={styles.row}>
                        {canPinOrDisable ? (
                          <>
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                void manageSlashSkills({
                                  action: item.pinned ? "unpin" : "pin",
                                  slug: item.name,
                                  category: customizeCategory,
                                  scope: customizeScope,
                                  query: customizeSearchInput.trim() || undefined,
                                  limit: 120,
                                  source: "settings-ui",
                                }).then((res) => {
                                  setCustomizeSnapData(res);
                                  toast.show(res.message, { variant: "success" });
                                });
                              }}
                              style={item.pinned ? styles.btn : styles.secondaryBtn}
                            >
                              <Text
                                style={item.pinned ? styles.btnText : styles.secondaryBtnText}
                              >
                                {item.pinned
                                  ? isZh
                                    ? "★ 已置顶"
                                    : "★ Pinned"
                                  : isZh
                                    ? "☆ 置顶"
                                    : "☆ Pin"}
                              </Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                void manageSlashSkills({
                                  action: isDisabled ? "enable" : "disable",
                                  slug: item.name,
                                  category: customizeCategory,
                                  scope: customizeScope,
                                  query: customizeSearchInput.trim() || undefined,
                                  limit: 120,
                                  source: "settings-ui",
                                }).then((res) => {
                                  setCustomizeSnapData(res);
                                  toast.show(res.message, { variant: "success" });
                                });
                              }}
                              style={styles.secondaryBtn}
                            >
                              <Text style={styles.secondaryBtnText}>
                                {isDisabled
                                  ? isZh
                                    ? "启用"
                                    : "Enable"
                                  : isZh
                                    ? "禁用"
                                    : "Disable"}
                              </Text>
                            </Pressable>
                          </>
                        ) : null}
                        {item.path ? (
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => {
                              if (!item.path) return;
                              void openTarget({
                                workspaceId: resolveActiveWsId(),
                                path: item.path,
                                target: "finder-reveal",
                              });
                            }}
                            style={styles.secondaryBtn}
                          >
                            <Text style={styles.secondaryBtnText}>Finder ↗</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "会话历史回放、全域 Skill 展开与保险库对账器 (Agent History, Slash Skills & Session Patch Reconciler)"
            : "Agent History, Slash Skills & Session Patch Reconciler"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "双层架构对账（能读 / 能试 / 能调）：底层协议补丁 (session.ts 历史回放 + 947 项全域/句中 /skill 自动展开 + 保险库守卫) + 插件层自动拦截「Couldn't refresh agent history」与句中 `/` 技能补全："
              : "Dual-layer architecture reconciler: inspect session.ts replay + 947 global/inline /skill patches & CLI Conversation Vault armor, dry-run /skill expansion, or trigger 1-click self-healing:"}
          </Text>

          <View style={styles.row}>
            <TextInput
              value={agentHistoryQueryInput}
              onChangeText={setAgentHistoryQueryInput}
              placeholder={
                isZh
                  ? "输入 Workspace ID / Conversation UUID，或输入 `/wheel-check /1password /graphify` 干跑测试多 Skill 展开..."
                  : "Enter Workspace ID / Conversation UUID, or `/wheel-check /1password /graphify` to dry-run skill expansion..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const q = agentHistoryQueryInput.trim();
                void manageAgentHistory({
                  action: q ? "probe" : "inspect",
                  workspaceId: q || resolveActiveWsId(),
                  conversationId: /^[0-9a-f-]{32,36}$/i.test(q) ? q : undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setAgentHistorySnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {isZh ? "对账与探活 (能读/能试)" : "Inspect & Probe"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const q = agentHistoryQueryInput.trim();
                void manageAgentHistory({
                  action: "heal",
                  workspaceId: q || resolveActiveWsId(),
                  conversationId: /^[0-9a-f-]{32,36}$/i.test(q) ? q : undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setAgentHistorySnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "⚡ 一键恢复聊天记录与补丁 (能调)" : "⚡ Auto-Heal History & Patches"}
              </Text>
            </Pressable>
          </View>

          {agentHistorySnapData ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                • Session Patch:{" "}
                {agentHistorySnapData.sessionPatches.ok ? "✓ HEALTHY" : "✕ NEEDS HEAL"} (
                {agentHistorySnapData.sessionPatches.details}) ·{" "}
                {agentHistorySnapData.sessionPatches.configSummary}
              </Text>
              <Text style={styles.detail}>
                • CLI Conversation Vault: {agentHistorySnapData.vaultStats.healthyConversationsCount}/
                {agentHistorySnapData.vaultStats.antigravityAgentsCount} active Antigravity agents
                healthy · missing .db={agentHistorySnapData.vaultStats.missingDbCount} · missing
                transcript={agentHistorySnapData.vaultStats.missingTranscriptCount} · shelved
                transcripts={agentHistorySnapData.vaultStats.shelvedTranscriptCount}
              </Text>
              {agentHistorySnapData.targetAgent ? (
                <Text style={styles.label}>
                  • Target Workspace: {agentHistorySnapData.targetAgent.workspaceName || "-"} (
                  {agentHistorySnapData.targetAgent.workspaceId || "-"}) · cid=
                  {agentHistorySnapData.targetAgent.conversationId?.slice(0, 8) || "-"} ·{" "}
                  {agentHistorySnapData.targetAgent.detail}
                </Text>
              ) : null}
              {agentHistorySnapData.actionsTaken.length > 0 ? (
                <Text style={styles.detail}>
                  • Healed Actions: {agentHistorySnapData.actionsTaken.join(" | ")}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "启动自动拉起与中断智能体自愈对账器 (Startup Auto-Pull-Up & Interrupted Agent Reconciler)"
            : "Startup Auto-Pull-Up & Interrupted Agent Reconciler (/pull-up)"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "核验 Paseo 启动自动拉起配置 (resumeOnStartup + version.cache + catalog.ts 单飞锁)，扫描因启动并发超时或 :8045 闪断掉线的会话并一键拉起续跑（能读 / 能试 / 能调）："
              : "Inspect Paseo startup auto-pull-up guards (resumeOnStartup + version.cache + catalog.ts singleflight), simulate interrupted agent detection, or pull up stalled agents:"}
          </Text>

          <View style={styles.row}>
            <TextInput
              value={recoveryAgentInput}
              onChangeText={setRecoveryAgentInput}
              placeholder={
                isZh
                  ? "筛选 Agent ID 前缀（留空默认扫描最近 24 小时全部活跃会话）..."
                  : "Optional Agent ID prefix (leave empty to scan all recent active agents)..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void reconcilePaseoRecovery({
                  action: "simulate",
                  agentId: recoveryAgentInput.trim() || undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setRecoverySnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {isZh ? "扫描与模拟 (能读/能试)" : "Simulate Scan"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void reconcilePaseoRecovery({
                  action: "heal",
                  agentId: recoveryAgentInput.trim() || undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setRecoverySnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "⚡ 一键拉起中断智能体 (能调)" : "⚡ Auto-Pull-Up Interrupted"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void reconcilePaseoRecovery({
                  action: "reset",
                  source: "settings-ui",
                }).then((res) => {
                  setRecoverySnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "重置熔断计数" : "Reset Breaker"}
              </Text>
            </Pressable>
          </View>

          {recoverySnapData ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                • Guards: resumeOnStartup={recoverySnapData.resumeOnStartup ? "✓ true" : "✕ false"} ·
                version.cache={recoverySnapData.versionCacheOk ? "✓ fast" : "✕ missing"} ·
                catalog.ts={recoverySnapData.catalogSingleflightOk ? "✓ singleflight" : "✕ unpatched"}{" "}
                · Proxy(:8045)={recoverySnapData.proxyHealthy ? "✓ ONLINE" : "✕ OFFLINE"}
              </Text>
              <Text style={styles.detail}>
                • Scanned: {recoverySnapData.totalScanned} active agents · Startup failed in daemon.log:{" "}
                {recoverySnapData.daemonStartupFailedCount} · Interrupted:{" "}
                {recoverySnapData.interruptedCount} · Healed: {recoverySnapData.healedCount} · Timeline desync:{" "}
                {recoverySnapData.timelineDesyncCount ?? 0} (synced: {recoverySnapData.timelineSyncedCount ?? 0}) ·
                Circuit breaker skipped: {recoverySnapData.circuitBreakerCount}
              </Text>
              {recoverySnapData.agents.slice(0, 6).map((ag) => (
                <View
                  key={ag.agentId}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    paddingVertical: 3,
                  }}
                >
                  <Text style={[styles.detail, { flex: 1 }]} numberOfLines={1}>
                    • [{ag.status}] {ag.agentId.slice(0, 8)} ({ag.workspaceId || "-"}) · [
                    {ag.toolSummary}] {ag.title} — {ag.reason}
                  </Text>
                  {ag.workspaceId ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        if (ag.workspaceId) {
                          navigateToPaseoWorkspace(ag.workspaceId, ag.agentId);
                        }
                      }}
                      style={styles.secondaryBtn}
                    >
                      <Text style={styles.secondaryBtnText}>
                        {isZh ? "打开会话 ↗" : "Open ↗"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          <View
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              gap: 8,
            }}
          >
            <SettingsSwitch
              label={
                isZh
                  ? "429 配额冷却期间暂缓排队消息并逐条恢复"
                  : "Hold queued messages on 429 quota wait and drain one by one"
              }
              hint={
                isZh
                  ? "当前回合因 429 或配额冷却中断时，暂缓自动下发后续排队消息；等待配额刷新且前序回合输入完成后，再严格逐条发送。"
                  : "When a turn ends on 429 or quota cooldown, hold queued messages until quota refreshes and the previous turn finishes, then drain strictly one message at a time."
              }
              value={values.enableQuotaQueueGuard ?? true}
              onValueChange={(next: boolean) => {
                syncQuotaQueuePrefs({ enabled: next });
                void save({ ...values, enableQuotaQueueGuard: next }, revision);
              }}
            />
            <SettingsSwitch
              label={
                isZh
                  ? "配额刷新后自动逐条发送排队消息"
                  : "Automatically drain queued messages one by one after quota refresh"
              }
              hint={
                isZh
                  ? "关闭后仅暂缓下发，需手动点击检测或发送。"
                  : "When disabled, queued messages stay held until you trigger drain manually."
              }
              value={values.quotaQueueAutoDrain ?? true}
              onValueChange={(next: boolean) => {
                syncQuotaQueuePrefs({ autoDrain: next });
                void save({ ...values, quotaQueueAutoDrain: next }, revision);
              }}
            />

            <View style={styles.row}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void manageQuotaQueue({
                    action: recoveryAgentInput.trim() ? "check" : "status",
                    agentId: recoveryAgentInput.trim() || undefined,
                    triggerRecoveryIfReady: Boolean(recoveryAgentInput.trim()),
                    source: "settings-ui",
                  }).then((res) => {
                    setQuotaQueueSnapData(res);
                    toast.show(res.message, { variant: res.ok ? "success" : "error" });
                  });
                }}
                style={styles.secondaryBtn}
              >
                <Icon name="Clock" size={14} color={theme.colors.foreground} />
                <Text style={styles.secondaryBtnText}>
                  {isZh ? "检查排队与配额" : "Inspect Quota Queue"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const targetAid =
                    recoveryAgentInput.trim() ||
                    quotaQueueSnapData?.entries.find((e) => e.queuedMessages.length > 0)?.agentId;
                  if (!targetAid) {
                    toast.show(
                      isZh ? "当前没有待发送的配额暂缓队列" : "No quota-held queued messages",
                      { variant: "info" },
                    );
                    return;
                  }
                  void manageQuotaQueue({
                    action: "drain_one",
                    agentId: targetAid,
                    source: "settings-ui",
                  }).then((res) => {
                    setQuotaQueueSnapData(res);
                    toast.show(res.message, { variant: res.ok ? "success" : "error" });
                  });
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>
                  {isZh ? "探测并发送 1 条" : "Check & Drain 1"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  syncQuotaQueuePrefs({ enabled: true, autoDrain: true });
                  void save(
                    {
                      ...values,
                      enableQuotaQueueGuard: true,
                      quotaQueueAutoDrain: true,
                    },
                    revision,
                  );
                  void manageQuotaQueue({ action: "reset", source: "settings-ui" }).then((res) => {
                    setQuotaQueueSnapData(res);
                    toast.show(res.message, { variant: "success" });
                  });
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>
                  {isZh ? "恢复队列默认设置" : "Reset Queue Defaults"}
                </Text>
              </Pressable>
            </View>

            {quotaQueueSnapData ? (
              <View style={{ gap: 4 }}>
                <Text style={styles.detail}>
                  {isZh
                    ? `• 暂缓会话: ${quotaQueueSnapData.heldCount} 个 · 排队消息总数: ${quotaQueueSnapData.totalQueuedMessages} 条 · 账本: ${quotaQueueSnapData.stateFile}`
                    : `• Held agents: ${quotaQueueSnapData.heldCount} · Total queued: ${quotaQueueSnapData.totalQueuedMessages} · Ledger: ${quotaQueueSnapData.stateFile}`}
                </Text>
                {quotaQueueSnapData.entries.slice(0, 5).map((entry) => (
                  <Text key={entry.agentId} style={styles.detail} numberOfLines={2}>
                    • {entry.agentId.slice(0, 8)} ({entry.provider || "provider"}/
                    {entry.model || "model"}) · {entry.queuedCount}{" "}
                    {isZh ? "条排队" : "queued"} ·{" "}
                    {entry.held
                      ? entry.holdReason || (isZh ? "等待配额刷新" : "Waiting for quota refresh")
                      : isZh
                        ? "已放行待逐条发送"
                        : "Ready for serial drain"}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "写回门禁与结束钩子对账器 (Stop Hook & Writeback Gate Reconciler)"
            : "Stop Hook & Writeback Gate Reconciler (finishing-with-writeback)"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "核验 Antigravity Stop Hook v2.0.0 防复读保护（transcriptPath 尾部回退、fullyIdle:false 后台挂起放行、executionNum 单轮限流），支持按 Conversation UUID 对比回放 v1 vs v2（能读 / 能试 / 能调）："
              : "Inspect Antigravity Stop Hook v2.0.0 anti-repetition guards (transcriptPath tail fallback, fullyIdle:false background yield bypass, executionNum cap), replay transcripts, or tune policy:"}
          </Text>

          <View style={styles.row}>
            <TextInput
              value={writebackConvInput}
              onChangeText={setWritebackConvInput}
              placeholder={
                isZh
                  ? "输入 Conversation UUID 回放验算（例如 4886f126-34b5-4dea-b6dd-01685971fb77）..."
                  : "Conversation UUID to replay (e.g. 4886f126-34b5-4dea-b6dd-01685971fb77)..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageWritebackHook({
                  action: "simulate",
                  conversationId: writebackConvInput.trim() || undefined,
                  source: "settings-ui",
                }).then((res) => {
                  setWritebackSnapData(res);
                  if (res.ok) {
                    toast.show(res.message, { variant: "success" });
                  } else {
                    toast.error(res.message);
                  }
                });
              }}
              style={styles.secondaryBtn}
            >
              <Icon name="Activity" size={14} color={theme.colors.foreground} />
              <Text style={styles.secondaryBtnText}>
                {isZh ? "回放与验算 (能读/能试)" : "Replay Transcript"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const nextEnabled = !(writebackSnapData?.enabled ?? true);
                void manageWritebackHook({
                  action: "tune",
                  enabled: nextEnabled,
                  source: "settings-ui",
                }).then((res) => {
                  setWritebackSnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {writebackSnapData?.enabled === false
                  ? isZh
                    ? "启用 Stop Hook (能调)"
                    : "Enable Stop Hook"
                  : isZh
                    ? "暂停 Stop Hook (能调)"
                    : "Pause Stop Hook"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void manageWritebackHook({
                  action: "reset",
                  clearMarkers: true,
                  source: "settings-ui",
                }).then((res) => {
                  setWritebackSnapData(res);
                  toast.show(res.message, { variant: "success" });
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "重置默认并清理标记" : "Reset & Clear Markers"}
              </Text>
            </Pressable>
          </View>

          {writebackSnapData ? (
            <View style={{ gap: 5, marginTop: 6 }}>
              <Text style={styles.label}>
                • Hook v{writebackSnapData.hookVersion} ({writebackSnapData.configSource}) ·
                enabled={writebackSnapData.enabled ? "✓ true" : "✕ false"} · maxBlocksPerTurn=
                {writebackSnapData.maxBlocksPerTurn} · requireFullyIdle=
                {writebackSnapData.requireFullyIdle ? "✓ true" : "✕ false"} ·
                transcriptTailFallback=
                {writebackSnapData.transcriptTailFallback ? "✓ true" : "✕ false"}
              </Text>
              <Text style={styles.detail}>
                • hooks.json: stop={writebackSnapData.stopHookEnabledInHooksJson ? "✓" : "✕"} ·
                turnMarker={writebackSnapData.turnMarkerEnabledInHooksJson ? "✓" : "✕"} · Active
                markers: {writebackSnapData.activeMarkersCount} · Recent audit (
                {writebackSnapData.auditSampleSize}): allow={writebackSnapData.auditAllowCount} ·
                block={writebackSnapData.auditBlockCount}
              </Text>
              {writebackSnapData.replay ? (
                <View style={{ gap: 4, marginTop: 4 }}>
                  <Text style={styles.label}>
                    • Replay ({writebackSnapData.replay.conversationId.slice(0, 8)}):{" "}
                    {writebackSnapData.replay.totalStopPoints} stop points · Legacy v1 blocked{" "}
                    {writebackSnapData.replay.legacyV1BlockCount}x → Current v2 blocked{" "}
                    {writebackSnapData.replay.v2BlockCount}x (Eliminated{" "}
                    {writebackSnapData.replay.falseBlocksEliminated} false blocks)
                  </Text>
                  {writebackSnapData.replay.events
                    .filter((ev) => ev.legacyV1Decision === "block" || ev.v2Decision === "block")
                    .slice(0, 8)
                    .map((ev) => (
                      <Text
                        key={`${ev.line}_${ev.stepIndex ?? 0}`}
                        style={styles.detail}
                        numberOfLines={1}
                      >
                        • L{ev.line} (step {ev.stepIndex ?? "-"}) · fullyIdle=
                        {ev.fullyIdle ? "true" : "false"} · exec={ev.executionNum} · Writeback=
                        {ev.hasWritebackLine ? "✓" : "✕"} · v1={ev.legacyV1Decision} → v2=
                        {ev.v2Decision} ({ev.v2Reason})
                      </Text>
                    ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "智能剪贴板与 Markdown 净化对账器 (Smart Clipboard Copy & Markdown Stripper Reconciler)"
            : "Smart Clipboard Copy & Markdown Stripper Reconciler (⌘C / ⌘⇧C / ⌥⌘C)"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.label}>
            {isZh
              ? "根治复制回复粘贴到 Beeper / LinkedIn / 微信出现满屏 `**` 星号的问题（能读 / 能试 / 能调）：默认 `⌘C` 同时写入干净纯文本（`text/plain` 供 Beeper/微信/网页）与富文本 HTML（`text/html` 供 Notion/Docs），按 `⌘⇧C` 强制纯文本，按 `⌥⌘C` 或 `Option+点击复制` 获取原始 Markdown："
              : "Eliminate unwanted `**` asterisks when pasting into Beeper, LinkedIn, WeChat, or browser inputs while keeping rich formatting in Notion (`text/plain` = Clean Text, `text/html` = Rich HTML):"}
          </Text>

          <Text style={styles.detail}>
            • Active Status: {smartCopyStatus?.installed ? "✓ INSTALLED" : "○ IDLE"} · Enabled:{" "}
            {smartCopyStatus?.preferences.enabled !== false ? "✓ true" : "✕ false"} · Default Mode:{" "}
            {smartCopyStatus?.preferences.defaultMode ?? "smart"} · Bullet:{" "}
            {smartCopyStatus?.preferences.bulletMarker === "dash" ? "- " : "• "} · Link:{" "}
            {smartCopyStatus?.preferences.linkFormat ?? "label-only"} · Shortcuts: ⌘C (Smart) / ⌘⇧C
            (Clean Plain) / ⌥⌘C (Raw Markdown) / ⌥+Click Copy Icon
          </Text>

          <View style={styles.row}>
            <TextInput
              value={smartCopySampleInput}
              onChangeText={setSmartCopySampleInput}
              placeholder={
                isZh
                  ? "输入包含 **粗体**、### 标题或列表的样本进行实时净化验算..."
                  : "Enter sample text with **bold**, ### headings, or bullets to test..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const res = runSmartCopySelfTest(smartCopySampleInput);
                setSmartCopySelfTest(res);
                setSmartCopyStatus(getSmartCopyStatus());
                toast.show(res.summary);
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "验算转换结果 (能试)" : "Run Self-Test"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                syncSmartCopyPreferences({
                  enabled: true,
                  defaultMode: "smart",
                  bulletMarker: "bullet",
                  linkFormat: "label-only",
                });
                void save(
                  {
                    ...values,
                    enableSmartClipboardCopy: true,
                    defaultClipboardCopyMode: "smart",
                    smartCopyBulletMarker: "bullet",
                    smartCopyLinkFormat: "label-only",
                  },
                  revision,
                );
                setSmartCopyStatus(getSmartCopyStatus());
                toast.show(isZh ? "已恢复智能复制默认配置" : "Restored Smart Copy defaults");
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "恢复默认 (能调)" : "Restore Defaults"}
              </Text>
            </Pressable>
          </View>

          {smartCopySelfTest ? (
            <View style={{ gap: 4, marginTop: 6 }}>
              <Text style={styles.label}>• {smartCopySelfTest.summary}</Text>
              <Text style={styles.detail}>
                • Beeper / LinkedIn / WeChat (`text/plain`): {smartCopySelfTest.smartPlainOutput.slice(0, 180)}
              </Text>
              <Text style={styles.detail}>
                • Notion / Docs (`text/html`): {smartCopySelfTest.smartHtmlOutput.slice(0, 180)}
              </Text>
              <Text style={styles.detail}>
                • Code Block Guard (`**kwargs`, `# comment`):{" "}
                {smartCopySelfTest.codeBlockPreserved ? "✓ Preserved verbatim" : "✕ Failed"}
              </Text>
            </View>
          ) : null}

          {smartCopyStatus && smartCopyStatus.receipts.length > 0 ? (
            <View style={{ gap: 3, marginTop: 4 }}>
              <Text style={styles.label}>
                {isZh ? "最近复制对账记录：" : "Recent Copy Receipts:"}
              </Text>
              {smartCopyStatus.receipts.slice(0, 4).map((rc, idx) => (
                <Text key={`${rc.at}_${idx}`} style={styles.detail} numberOfLines={1}>
                  • [{rc.trigger}] mode={rc.modeUsed} · stripped={rc.strippedTokens} · plain=
                  {rc.plainChars}c / html={rc.htmlChars}c · "{rc.preview}"
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "Markdown 表格渲染与断行修复对账器 (能读 / 能试 / 能调)"
            : "Markdown Table Rendering & Row-Split Reconciler"
        }
      >
        <SettingsCard>
          <SettingsSwitch
            label={
              isZh
                ? "启用 Markdown 表格单元格换行与截断自动修复"
                : "Enable Markdown table cell line-break & truncated row healer"
            }
            hint={
              isZh
                ? "拦截 Paseo normalizeMarkdownHtml 将表格内 <br> 转为换行符导致的错列断行，自动修复 <truncated N bytes> 截断行与长代码列挤压"
                : "Prevents normalizeMarkdownHtml from splitting GFM table rows on <br> and heals truncated rows"
            }
            value={values.enableMarkdownTableEnhancer ?? true}
            onValueChange={(next) => {
              syncMarkdownTablePreferences({ enabled: next });
              setMarkdownTableStatus(getMarkdownTableStatus());
              void save({ ...values, enableMarkdownTableEnhancer: next }, revision);
            }}
          />
          <SettingsSwitch
            label={
              isZh
                ? "启用 LaTeX 数学公式渲染 (KaTeX MathML)"
                : "Enable LaTeX Math Rendering (KaTeX MathML)"
            }
            hint={
              isZh
                ? "修复 Paseo 默认禁用 latexMath 导致数学公式裸露为 $$...$$ 源码的问题，注入内置 KaTeX 引擎渲染原生高清 MathML 数学排版"
                : "Fixes Paseo's disabled latexMath flag by rendering mathematical formulas ($$...$$) into native MathML via bundled KaTeX"
            }
            value={values.enableLatexMathRendering ?? true}
            onValueChange={(next: boolean) => {
              syncMarkdownTablePreferences({ renderLatexMath: next });
              setMarkdownTableStatus(getMarkdownTableStatus());
              void save({ ...values, enableLatexMathRendering: next }, revision);
            }}
          />
        </SettingsCard>

        <View style={styles.diagBox}>
          <Text style={styles.detail}>
            • {isZh ? "当前生效状态 (能读)" : "Active Status"}:{" "}
            {markdownTableStatus?.preferences.enabled !== false ? "true" : "false"} · Metro
            Hooks:{" "}
            {markdownTableStatus?.metroHookInstalled
              ? `[${markdownTableStatus.hookedExports.join(", ")}]`
              : "DOM-Healer Active"}{" "}
            · KaTeX:{" "}
            {markdownTableStatus?.katexAvailable
              ? `[${markdownTableStatus.katexVersion ?? "0.16.47"} MathML]`
              : "Loading"}{" "}
            · Tables Scanned: {markdownTableStatus?.tablesScanned ?? 0} · Tables Healed:{" "}
            {markdownTableStatus?.tablesHealed ?? 0} · Rows Merged:{" "}
            {markdownTableStatus?.rowsMergedTotal ?? 0} · Cell &lt;br&gt; Fixed:{" "}
            {markdownTableStatus?.lineBreaksConvertedTotal ?? 0} · Math Formulas Healed:{" "}
            {markdownTableStatus?.mathFormulasHealedTotal ?? 0}
          </Text>

          <View style={styles.row}>
            <TextInput
              value={markdownTableSampleInput}
              onChangeText={setMarkdownTableSampleInput}
              placeholder={
                isZh
                  ? "输入包含 <br> 或 <truncated N bytes> 的 GFM 表格样本进行实时验算..."
                  : "Enter GFM table sample with <br> or <truncated N bytes>..."
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const res = runMarkdownTableSelfTest(markdownTableSampleInput);
                if (typeof document !== "undefined") {
                  repairRenderedDomTables(document);
                }
                setMarkdownTableSelfTest(res);
                setMarkdownTableStatus(getMarkdownTableStatus());
                toast.show(res.summary);
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "验算并修复排版 (能试)" : "Run Layout Self-Test"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                syncMarkdownTablePreferences({
                  enabled: true,
                  convertCellBrToLineBreak: true,
                  healTruncatedRows: true,
                  enhanceTableTypographyCss: true,
                  renderLatexMath: true,
                  enhanceLatexMathTypographyCss: true,
                });
                void save(
                  {
                    ...values,
                    enableMarkdownTableEnhancer: true,
                    enableLatexMathRendering: true,
                  },
                  revision,
                );
                setMarkdownTableStatus(getMarkdownTableStatus());
                toast.show(
                  isZh ? "已恢复 Markdown 与 LaTeX 渲染默认配置" : "Restored Markdown and LaTeX defaults",
                );
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "恢复默认 (能调)" : "Restore Defaults"}
              </Text>
            </Pressable>
          </View>

          {markdownTableSelfTest ? (
            <View style={{ gap: 4, marginTop: 6 }}>
              <Text style={styles.label}>• {markdownTableSelfTest.summary}</Text>
              <Text style={styles.detail}>
                • Rows × Columns: {markdownTableSelfTest.bodyRowCount} ×{" "}
                {markdownTableSelfTest.colCount} · Cell &lt;br&gt; Preserved:{" "}
                {markdownTableSelfTest.cellLineBreaksPreserved ? "✓ Yes" : "✕ No"} · Truncated
                Row Repaired: {markdownTableSelfTest.truncatedRowRepaired ? "✓ Yes" : "✕ No"} ·
                Inline `&lt;br&gt;` Guard:{" "}
                {markdownTableSelfTest.codeSpanBrPreserved ? "✓ Preserved" : "✕ Failed"}
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <MermaidSettingsSection isZh={isZh} styles={styles} />

      <DocPreviewSettingsSection isZh={isZh} styles={styles} />

      <RelaySettingsSection isZh={isZh} styles={styles} />

      <ModelCatalogSettingsSection isZh={isZh} styles={styles} />

      <IntakeDecisionsSettingsSection isZh={isZh} styles={styles} />

      <SwarmWorkflowSettingsSection isZh={isZh} styles={styles} />

      <SettingsSection
        title={
          isZh
            ? "会话完成时间与本地时区展示对账器 (能读 / 能试 / 能调)"
            : "Session Finished Time & Local Timezone Reconciler"
        }
      >
        <SettingsCard>
          <SettingsSwitch
            label={
              isZh
                ? "显示会话与回合完成的具体本地时间 (如 Worked for 1h 29m · 01:38 / 7h ago · 01:38)"
                : "Show concise finished clock time in user timezone alongside relative age"
            }
            hint={
              isZh
                ? "开启后：不再只显示笼统的 xxh ago 或仅显示 Worked for 耗时。今日完成直接显示 HH:mm（如 01:38），跨日完成显示 MM/DD HH:mm（如 11/09 23:48），覆盖对话回合底部、左侧边栏、⌘K 搜索、Sessions 列表与标签页悬停提示。"
                : "Displays concise local finished time (HH:mm today, MM/DD HH:mm cross-day) across chat turn footers, left sidebar, Command Center (⌘K), Sessions list, and tab tooltips."
            }
            value={values.enableSessionFinishedTimeEnhancer ?? true}
            onValueChange={(next) => {
              syncSessionTimePreferences({ enabled: next }, "plugin-settings");
              setSessionTimeHealth(getSessionTimeHealthSnapshot());
              void save({ ...values, enableSessionFinishedTimeEnhancer: next }, revision);
            }}
          />

          <SettingsSelect
            label={isZh ? "时间显示制式 (Clock Format)" : "Clock Format"}
            hint={
              isZh
                ? "24 小时制（推荐，极简紧凑如 01:38 / 11/09 23:48）或 12 小时制（如 1:38 AM）"
                : "24-hour concise clock (01:38 / 11/09 23:48) or 12-hour clock (1:38 AM)"
            }
            value={(values.sessionTimeClockFormat ?? "24h") as SessionTimeClockFormat}
            options={[
              {
                label: isZh
                  ? "24 小时制 (01:38 / 11/09 23:48 · 推荐)"
                  : "24-Hour Concise (01:38 / 11/09 23:48 · Recommended)",
                value: "24h",
              },
              {
                label: isZh
                  ? "12 小时制 (1:38 AM / 11/09 11:48 PM)"
                  : "12-Hour Clock (1:38 AM / 11/09 11:48 PM)",
                value: "12h",
              },
            ]}
            onValueChange={(next) => {
              syncSessionTimePreferences({ clockFormat: next }, "plugin-settings");
              setSessionTimeHealth(getSessionTimeHealthSnapshot());
              void save({ ...values, sessionTimeClockFormat: next }, revision);
            }}
          />

          <SettingsSwitch
            label={
              isZh
                ? "在左侧边栏会话行同步显示完成时间 (如 7h · 01:38)"
                : "Show finished time in Left Sidebar workspace rows (e.g. 7h · 01:38)"
            }
            hint={
              isZh
                ? "开启后左侧边栏已结束会话行同时呈现相对时长与本地完成时刻；悬停可查看完整秒级时间戳与时区。"
                : "Appends concise local finished time to compact sidebar timestamps with full timezone tooltip on hover."
            }
            value={values.showFinishedTimeInSidebar ?? true}
            onValueChange={(next) => {
              syncSessionTimePreferences(
                { showFinishedTimeInSidebar: next },
                "plugin-settings",
              );
              setSessionTimeHealth(getSessionTimeHealthSnapshot());
              void save({ ...values, showFinishedTimeInSidebar: next }, revision);
            }}
          />

          <SettingsSwitch
            label={
              isZh
                ? "在对话回合底部同时附带相对距今时长 (如 Worked for 1h 29m · 01:38 (7h ago))"
                : "Include relative age in chat turn footer (e.g. Worked for 1h 29m · 01:38 (7h ago))"
            }
            hint={
              isZh
                ? "开启后，完成超过 1 分钟的回合底部在显示执行耗时与完成时刻的同时，括号内补充距今时长。"
                : "Shows both the local finished clock time and relative age on finished assistant turns."
            }
            value={values.showRelativeAgeInTurnFooter ?? true}
            onValueChange={(next) => {
              syncSessionTimePreferences(
                { showRelativeAgeInTurnFooter: next },
                "plugin-settings",
              );
              setSessionTimeHealth(getSessionTimeHealthSnapshot());
              void save({ ...values, showRelativeAgeInTurnFooter: next }, revision);
            }}
          />
        </SettingsCard>

        <View style={styles.diagBox}>
          <Text style={styles.detail}>
            • {isZh ? "当前时区与状态 (能读)" : "Active Timezone & Status"}:{" "}
            {sessionTimeHealth?.enabled !== false ? "✓ Enabled" : "✕ Disabled"} · Timezone:{" "}
            {sessionTimeHealth?.timeZone ?? "Local"} ({sessionTimeHealth?.offsetLabel ?? "GMT"}) ·
            Format: {sessionTimeHealth?.clockFormat ?? "24h"} · Source:{" "}
            {sessionTimeHealth?.sourceBadge ?? "default"} · Metro Hooks:{" "}
            {sessionTimeHealth?.metroHookInstalled
              ? `✓ (${sessionTimeHealth.hookedModules.join(", ")})`
              : "DOM-Enhancer Active"}{" "}
            · Decorated (Turns={sessionTimeHealth?.turnFootersDecorated ?? 0}, Sidebar=
            {sessionTimeHealth?.sidebarTimestampsDecorated ?? 0}, ⌘K=
            {sessionTimeHealth?.commandCenterTimestampsDecorated ?? 0}, AgentList=
            {sessionTimeHealth?.agentRowsDecorated ?? 0})
          </Text>

          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const res = runSessionTimeSelfTest();
                setSessionTimeSelfTest(res);
                setSessionTimeHealth(getSessionTimeHealthSnapshot());
                toast.show(res.summary);
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "验算本地时区格式 (能试)" : "Run Timezone Self-Test"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                syncSessionTimePreferences(
                  {
                    enabled: true,
                    clockFormat: "24h",
                    showFinishedTimeInSidebar: true,
                    showRelativeAgeInTurnFooter: true,
                  },
                  "plugin-settings",
                );
                void save(
                  {
                    ...values,
                    enableSessionFinishedTimeEnhancer: true,
                    sessionTimeClockFormat: "24h",
                    showFinishedTimeInSidebar: true,
                    showRelativeAgeInTurnFooter: true,
                  },
                  revision,
                );
                setSessionTimeHealth(getSessionTimeHealthSnapshot());
                toast.show(
                  isZh
                    ? "已恢复会话完成时间默认配置 (24h)"
                    : "Restored session finished time defaults (24h)",
                );
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "恢复默认 (能调)" : "Restore Defaults"}
              </Text>
            </Pressable>
          </View>

          {sessionTimeSelfTest ? (
            <View style={{ gap: 4, marginTop: 6 }}>
              <Text style={styles.label}>• {sessionTimeSelfTest.summary}</Text>
              <Text style={styles.detail}>
                • Turn Footer: "{sessionTimeSelfTest.turnFooterSample}" · Left Sidebar: "
                {sessionTimeSelfTest.sidebarCompactSample}" · ⌘K / Sessions List: "
                {sessionTimeSelfTest.proseRelativeSample}"
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "跨模型同伴调用与反伪造门禁 (Peer Agents & Cross-Model Review v5)"
            : "Peer Agents & Cross-Model Review Reconciler (v5)"
        }
      >
        <View style={styles.diagBox}>
          <Text style={styles.detail}>
            • {isZh ? "同伴感知块与通道状态 (能读)" : "Peer Block & Channel Status"}:{" "}
            v{peerAgentsSnapData?.blockVersion ?? 5} · Channel:{" "}
            {peerAgentsSnapData?.antigravityChannel ?? "cli-fallback"} · Active Peers:{" "}
            {peerAgentsSnapData?.activePeersCount ?? 0} (Closed Folded:{" "}
            {peerAgentsSnapData?.closedPeersCount ?? 0})
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "指令表面同步状态" : "Harness Surfaces"}:{" "}
            {(peerAgentsSnapData?.surfaces ?? [])
              .map((s) => `${s.name}=${s.state}${s.version ? `(v${s.version})` : ""}`)
              .join(" · ") || "loading..."}
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "已配置跨模型画像" : "Configured Profiles"} (
            {peerAgentsSnapData?.profiles?.length ?? 0}):{" "}
            {(peerAgentsSnapData?.profiles ?? [])
              .map((p) => `${p.name} [${p.provider}/${p.model}]`)
              .join(" · ") || "none"}
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "发件箱与队列对账" : "Outbox Summary"}:{" "}
            {peerAgentsSnapData?.outboxSummary ?? "outbox: ok"}
          </Text>

          <View style={{ gap: 4, marginTop: 6 }} testID="peer-shared-files">
            <View style={styles.row}>
              <Text style={styles.label}>
                {isZh
                  ? `共享文件 (${peerPresenceSummary?.windowMinutes ?? 30} 分钟)`
                  : `Shared files (${peerPresenceSummary?.windowMinutes ?? 30} min)`}
              </Text>
              <Text style={styles.detail} testID="peer-shared-files-count">
                {peerPresenceBusy === "status"
                  ? isZh
                    ? "检查中..."
                    : "checking..."
                  : peerSharedFiles === undefined
                    ? isZh
                      ? "加载中..."
                      : "loading..."
                    : peerSharedFiles === null
                      ? isZh
                        ? "未知"
                        : "unknown"
                      : [
                          String(peerPresenceSummary?.sharedTotal ?? peerSharedFiles.length),
                          formatPresenceSummary(peerPresenceSummary, isZh),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
              </Text>
            </View>
            <Text style={styles.detail}>
              {isZh
                ? "共享文件指两个及以上会话改过的文件，每行显示谁在改。"
                : "Shared files are edited by two or more sessions. Each line shows who is editing."}
            </Text>
            {peerSharedFiles === null ? (
              <Text style={styles.detail} testID="peer-shared-files-unknown">
                {isZh
                  ? "未知：检查没有返回可读结果。终端里的同一检查：antigravity-ops peers touching"
                  : "Unknown: the check returned nothing readable. The same check in a terminal: antigravity-ops peers touching"}
              </Text>
            ) : null}
            {peerSharedFiles && peerSharedFiles.length === 0 ? (
              <Text style={styles.detail} testID="peer-shared-files-empty">
                {isZh ? "当前没有共享文件。" : "No file is shared right now."}
              </Text>
            ) : null}
            {(peerSharedFiles ?? []).flatMap((file) => [
              <Text
                key={file.path}
                style={[styles.detail, { color: theme.colors.foreground }]}
              >
                {file.shortPath}
              </Text>,
              ...file.sessions.map((peerSession, index) => (
                <Text
                  key={`${file.path}#${peerSession.agent || peerSession.session || index}`}
                  style={[styles.detail, { paddingLeft: 12 }]}
                >
                  {formatPeerSessionRow(peerSession, Date.now() / 1000, isZh)}
                </Text>
              )),
            ])}
            {peerSharedFiles && peerPresenceSummary?.truncated ? (
              <Text style={styles.detail}>
                {isZh
                  ? `显示 ${peerPresenceSummary.sharedTotal} 个中的前 ${peerSharedFiles.length} 个。`
                  : `Showing ${peerSharedFiles.length} of ${peerPresenceSummary.sharedTotal}.`}
              </Text>
            ) : null}
            {(peerPresenceSummary?.warnings ?? []).map((warning, index) => (
              <Text key={`${index}:${warning}`} style={styles.detail}>
                {isZh ? "警告" : "Warning"}: {warning}
              </Text>
            ))}
            {peerPresenceBusy === "verify_presence" || peerPresenceVerify !== undefined ? (
              <Text style={styles.detail} testID="peer-presence-verdict">
                {isZh ? "记录" : "Recording"}:{" "}
                {peerPresenceBusy === "verify_presence"
                  ? isZh
                    ? "检查中..."
                    : "checking..."
                  : formatPresenceVerdict(peerPresenceVerify, isZh)}
              </Text>
            ) : null}
            <View style={styles.row}>
              <Pressable
                accessibilityRole="button"
                disabled={peerPresenceBusy !== ""}
                testID="peer-shared-files-recheck"
                onPress={() => {
                  setPeerPresenceBusy("status");
                  void managePeerAgents({ action: "status", source: "settings-ui" })
                    .then(applyPeerStatus)
                    .catch(markPeerSharedFilesUnknown)
                    .finally(() => setPeerPresenceBusy(""));
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>{isZh ? "重新检查" : "Re-check"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={peerPresenceBusy !== ""}
                testID="peer-presence-verify"
                onPress={() => {
                  setPeerPresenceBusy("verify_presence");
                  void managePeerAgents({ action: "verify_presence", source: "settings-ui" })
                    .then((res) => setPeerPresenceVerify(res.presenceVerify ?? null))
                    .catch(() => setPeerPresenceVerify(null))
                    .finally(() => setPeerPresenceBusy(""));
                }}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>
                  {isZh ? "检查记录" : "Check recording"}
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.row}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <TextInput
                placeholder={
                  isZh
                    ? "输入模型简写测试解析，如 gemini4, opus 5.5"
                    : "Enter model shorthands to test, e.g. gemini4, opus 5.5"
                }
                value={peerProfileQueryInput}
                onChangeText={setPeerProfileQueryInput}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void managePeerAgents({
                  action: "test_resolve",
                  profileQuery: peerProfileQueryInput,
                  source: "settings-ui",
                }).then((res) => {
                  setPeerAgentsSnapData(res);
                  toast.show(res.message);
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "试跑画像解析 (能试)" : "Dry-Run Profile Resolve"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void managePeerAgents({
                  action: "enable_all",
                  source: "settings-ui",
                }).then((res) => {
                  setPeerAgentsSnapData(res);
                  toast.show(
                    isZh
                      ? "已同步 v5 反伪造同伴感知块至全部指令表面"
                      : "Synced v5 peer-awareness block across all harnesses",
                  );
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "同步 v5 感知块 (能调)" : "Sync v5 Block"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void managePeerAgents({
                  action: "heal_outbox",
                  source: "settings-ui",
                }).then((res) => {
                  setPeerAgentsSnapData(res);
                  toast.show(
                    isZh
                      ? "已执行发件箱治愈与侧边栏标题血缘对账"
                      : "Healed peer outbox and reconciled workspace titles",
                  );
                });
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {isZh ? "治愈发件箱与血缘 (能调)" : "Heal Outbox & Lineage"}
              </Text>
            </Pressable>
          </View>

          {peerAgentsSnapData?.resolvedPreview ? (
            <View style={{ gap: 4, marginTop: 6 }}>
              <Text style={styles.label}>
                • {isZh ? "解析命中画像" : "Matched Profiles"}:{" "}
                {peerAgentsSnapData.resolvedPreview.matchedProfiles.join(" + ")}
              </Text>
              <Text style={styles.detail}>
                • {isZh ? "一键跨模型评审命令" : "1-Command Cross-Model Review"}:{" "}
                {peerAgentsSnapData.resolvedPreview.sampleReviewCommand}
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={
          isZh
            ? "系统起始提示词与全局环境指令"
            : "System Starter Prompt & Instructions"
        }
      >
        <View style={styles.diagBox} testID="system-prompt-settings-status">
          <Text style={styles.detail}>
            • {isZh ? "配置文件路径" : "Config Path"}:{" "}
            {systemPromptSnap?.configPath ?? "~/.paseo/config.json"} (
            {systemPromptSnap?.charCount ?? 0} {isZh ? "字符" : "chars"} · ~
            {systemPromptSnap?.estimatedTokens ?? 0} tokens ·{" "}
            {systemPromptSnap?.sections.length ?? 0} {isZh ? "个规则分区" : "sections"})
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "最近保存时间" : "Last Saved"}:{" "}
            {systemPromptSnap?.mtime ? new Date(systemPromptSnap.mtime).toLocaleString() : "unknown"}
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "规则模块概览" : "Rule Sections"}:{" "}
            {(systemPromptSnap?.sections ?? [])
              .map((s) => `${s.title} (${s.charCount}c)`)
              .join(" · ") || (isZh ? "无" : "none")}
          </Text>
          <Text style={styles.detail}>
            • {isZh ? "用户提示词分界健康度" : "User Prompt Boundary"}:{" "}
            {systemPromptSnap?.boundaryOk === false
              ? isZh
                ? `[WARN] <user prompt>: 后溢出 ${systemPromptSnap.leakedAfterUserPromptChars ?? 0} 字符系统指令（易导致模型误判为用户主任务）`
                : `[WARN] ${systemPromptSnap.leakedAfterUserPromptChars ?? 0} system chars placed below <user prompt>: marker`
              : isZh
                ? "[OK] 干净（系统指令全部位于 <user prompt>: 之上）"
                : "[OK] Clean (all system directives precede <user prompt>:)"}
          </Text>
          {systemPromptSnap?.boundaryOk === false ? (
            <View style={styles.row}>
              <Pressable
                accessibilityRole="button"
                testID="system-prompt-normalize-boundary-button"
                onPress={() => {
                  void inspectSystemPrompt({ action: "normalize_boundary" }).then((res) => {
                    setSystemPromptSnap(res);
                    toast.show(res.message);
                  });
                }}
                style={styles.btn}
              >
                <Text style={styles.btnText}>
                  {isZh ? "收拢分界标记到底部" : "Normalize Boundary"}
                </Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.row}>
            <View style={{ flex: 1, minWidth: 260 }}>
              <TextInput
                testID="system-prompt-test-clean-input"
                placeholder={
                  isZh
                    ? "粘贴转录文本测试气泡清洗..."
                    : "Paste transcript text to test bubble sanitization..."
                }
                value={testCleanInput}
                onChangeText={setTestCleanInput}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              testID="system-prompt-test-clean-button"
              onPress={() => {
                void inspectSystemPrompt({
                  action: "test_clean",
                  testInput:
                    testCleanInput ||
                    "<system starter prompt in paseo>\n\nhttps://example.com/task",
                }).then((res) => {
                  setSystemPromptSnap(res);
                  if (res.testResult) {
                    setTestCleanResult(
                      `[${res.testResult.strippedPrefix ? "STRIPPED" : "UNCHANGED"}] ${res.testResult.inputChars}c -> ${res.testResult.cleanedChars}c: ${res.testResult.cleanedText}`,
                    );
                  }
                  toast.show(res.message);
                });
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "测试清洗" : "Test Sanitization"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (systemPromptSnap?.configPath) {
                  void openTarget({
                    path: systemPromptSnap.configPath,
                    target: "system-default",
                  });
                }
              }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>
                {isZh ? "打开配置文件" : "Open Config File"}
              </Text>
            </Pressable>
          </View>

          {testCleanResult ? (
            <View style={{ gap: 4, marginTop: 6 }} testID="system-prompt-test-clean-result">
              <Text style={styles.detail}>• {isZh ? "清洗测试结果" : "Sanitization Result"}:</Text>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: "#16a34a", marginTop: 4 }}>
                {testCleanResult}
              </Text>
            </View>
          ) : null}

          {systemPromptSnap?.appendSystemPrompt ? (
            <View style={{ marginTop: 8, padding: 8, backgroundColor: "rgba(0,0,0,0.03)", borderRadius: 6 }}>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: "var(--color-text-secondary, #656d76)", maxHeight: 120, overflow: "hidden" }}>
                {systemPromptSnap.appendSystemPrompt.slice(0, 400)}
                {systemPromptSnap.appendSystemPrompt.length > 400 ? "..." : ""}
              </Text>
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.sectionContract")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.contractVoiceSttLabel")}
            hint={t("settings.contractVoiceSttHint")}
          />
          <SettingsRow
            label={t("settings.contractQuickJumpLabel")}
            hint={t("settings.contractQuickJumpHint")}
          />
          <SettingsRow
            label={t("settings.contractInlineRenameLabel")}
            hint={t("settings.contractInlineRenameHint")}
          />
          <SettingsRow
            label={t("settings.contractSidebarDropLabel")}
            hint={t("settings.contractSidebarDropHint")}
          />
          <SettingsRow
            label={t("settings.contractTabMenuLabel")}
            hint={t("settings.contractTabMenuHint")}
          />
          <SettingsRow
            label={t("settings.contractImageToolbarLabel")}
            hint={t("settings.contractImageToolbarHint")}
          />
          <SettingsRow
            label={t("settings.contractShortcutsLabel")}
            hint={t("settings.contractShortcutsHint")}
          />
          <SettingsRow
            label={t("settings.contractCommandsLabel")}
            hint={t("settings.contractCommandsHint")}
          />
          <SettingsRow
            label={t("settings.contractSidebarDeleteArchiveLabel")}
            hint={t("settings.contractSidebarDeleteArchiveHint")}
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
