import {
  type PluginWorkspacePanelProps,
  useRpc,
  useTranslation,
} from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  type LocalSwarmSummary,
  type LocalWorkflowRun,
  inspectSwarmWorkflowRpc,
} from "../shared/swarm-workflow-contracts";
import { isChineseLocale, pluginTranslations } from "./i18n";
import { extractCurrentRouteAgentId } from "./subagents-tree-web";
import {
  consumePendingSwarmOpenRequest,
  mountSwarmBoardIframe,
  openSwarmMemberConversationInPaseo,
  subscribeSwarmOpenRequests,
} from "./swarm-workflow-web";

type PanelMode = "swarm" | "workflows";

export function SwarmWorkflowWorkspacePanel({
  workspaceId,
  theme,
  layout,
}: PluginWorkspacePanelProps) {
  const { locale } = useTranslation(pluginTranslations);
  const isZh = isChineseLocale(locale);
  const toast = useToast();
  const inspectSwarmWorkflow = useRpc(inspectSwarmWorkflowRpc);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const stageHostTestId = `paseo-swarm-stage-${instanceId}`;

  const [mode, setMode] = useState<PanelMode>("swarm");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [preferredSwarmTab, setPreferredSwarmTab] = useState<string | undefined>(undefined);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);

  const routeAgentId = useMemo(
    () => extractCurrentRouteAgentId() ?? undefined,
    [workspaceId],
  );

  // Follow the active workspace's own swarm when switching workspaces unless an explicit
  // swarm open request selects another conversation.
  useEffect(() => {
    setSelectedConversationId(null);
    setSwitcherOpen(false);
  }, [workspaceId]);

  useEffect(() => {
    const initial = consumePendingSwarmOpenRequest();
    if (initial && (!initial.workspaceId || initial.workspaceId === workspaceId)) {
      if (initial.tab) setMode(initial.tab);
      if (initial.conversationId) setSelectedConversationId(initial.conversationId);
      if (initial.swarmTab) setPreferredSwarmTab(initial.swarmTab);
    }
    return subscribeSwarmOpenRequests((req) => {
      if (req.workspaceId && req.workspaceId !== workspaceId) return;
      if (req.tab) setMode(req.tab);
      if (req.conversationId) setSelectedConversationId(req.conversationId);
      if (req.swarmTab) setPreferredSwarmTab(req.swarmTab);
      setSwitcherOpen(false);
    });
  }, [workspaceId]);

  const dataQuery = useQuery({
    queryKey: [
      "finder.inspectSwarmWorkflow",
      workspaceId,
      routeAgentId,
      selectedConversationId,
    ],
    queryFn: () =>
      inspectSwarmWorkflow({
        action: "ensure_board_server",
        workspaceId,
        agentId: routeAgentId,
        conversationId: selectedConversationId ?? undefined,
        limit: 30,
      }),
    refetchInterval: mode === "workflows" ? 5000 : 12000,
    staleTime: 2500,
  });

  const restartMutation = useMutation({
    mutationFn: () =>
      inspectSwarmWorkflow({
        action: "restart_board",
        workspaceId,
        agentId: routeAgentId,
        conversationId: selectedConversationId ?? undefined,
        limit: 30,
      }),
    onSuccess: (res) => {
      void dataQuery.refetch();
      toast.show(res.message, { variant: res.ok ? "success" : "error" });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const data = dataQuery.data;
  const swarms: LocalSwarmSummary[] = data?.swarms ?? [];
  const workflows: LocalWorkflowRun[] = data?.workflows ?? [];

  const effectiveConversationId = useMemo(() => {
    if (selectedConversationId) return selectedConversationId;
    const resolved = data?.resolvedConversationId ?? null;
    if (resolved && swarms.some((s) => s.swarmId === resolved || s.members.some((m) => m.conversationId === resolved))) {
      return resolved;
    }
    return swarms[0]?.swarmId ?? resolved ?? "";
  }, [data?.resolvedConversationId, selectedConversationId, swarms]);

  const activeSwarm = useMemo(
    () =>
      swarms.find(
        (s) =>
          s.swarmId === effectiveConversationId ||
          s.members.some((m) => m.conversationId === effectiveConversationId),
      ) ?? null,
    [effectiveConversationId, swarms],
  );

  const proxyUrl = data?.bridge.running ? data.bridge.proxyUrl : null;
  const useWebIframe = Platform.OS === "web" && mode === "swarm" && Boolean(proxyUrl);

  useEffect(() => {
    if (!useWebIframe || !proxyUrl) {
      setIframeReady(false);
      return;
    }
    return mountSwarmBoardIframe({
      hostTestId: stageHostTestId,
      proxyUrl,
      conversationId: effectiveConversationId,
      initialSwarmTab: preferredSwarmTab,
      onStatusChange: (st) => {
        setIframeReady(st.ready);
      },
    });
  }, [effectiveConversationId, preferredSwarmTab, proxyUrl, stageHostTestId, useWebIframe]);

  const handleOpenConversation = useCallback(
    (cid: string | null) => {
      if (!cid) return;
      const ok = openSwarmMemberConversationInPaseo(cid, {
        workspaceId: activeSwarm?.paseoWorkspaceId ?? workspaceId,
        parentAgentId: activeSwarm?.paseoAgentId ?? routeAgentId ?? null,
      });
      if (!ok) {
        toast.show(isZh ? `对话 ID: ${cid.slice(0, 8)}` : `Conversation: ${cid.slice(0, 8)}`);
      }
    },
    [activeSwarm?.paseoAgentId, activeSwarm?.paseoWorkspaceId, isZh, routeAgentId, toast, workspaceId],
  );

  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        width: "100%" as const,
        height: "100%" as const,
        minHeight: 0,
        backgroundColor: theme.colors.surface0,
      },
      topBar: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingHorizontal: layout.compact ? 10 : 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      leftGroup: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
      },
      rightGroup: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      segmented: {
        flexDirection: "row" as const,
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 2,
        gap: 2,
      },
      segBtn: (active: boolean) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface0 : "transparent",
      }),
      segText: (active: boolean) => ({
        color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: active ? ("600" as const) : ("500" as const),
      }),
      chipBtn: (active = false) => ({
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.surface2 : theme.colors.surface0,
      }),
      chipText: (active = false) => ({
        color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: active ? ("600" as const) : ("500" as const),
      }),
      pickerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: layout.compact ? 10 : 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      stageHost: {
        flex: 1,
        width: "100%" as const,
        minHeight: 420,
        position: "relative" as const,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.surface0,
      },
      loadingOverlay: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        gap: 8,
        backgroundColor: theme.colors.surface0,
      },
      scrollBody: {
        flex: 1,
        padding: layout.compact ? 10 : 14,
      },
      card: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        marginBottom: 10,
        gap: 8,
      },
      cardTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      muted: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      },
      badge: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: {
        color: theme.colors.foreground,
        fontSize: 11,
        fontWeight: "600" as const,
      },
      phaseBox: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        padding: 10,
        gap: 6,
      },
      agentRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 7,
        backgroundColor: theme.colors.surface2,
      },
      emptyWrap: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        gap: 8,
      },
    }),
    [layout.compact, theme.colors],
  );

  return (
    <View style={styles.root} testID="paseo-swarm-workspace-panel">
      <View style={styles.topBar}>
        <View style={styles.leftGroup}>
          <View style={styles.segmented}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode("swarm")}
              style={styles.segBtn(mode === "swarm")}
              testID="paseo-swarm-mode-swarm"
            >
              <Text style={styles.segText(mode === "swarm")}>
                {`Swarm${swarms.length > 0 ? ` (${swarms.length})` : ""}`}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode("workflows")}
              style={styles.segBtn(mode === "workflows")}
              testID="paseo-swarm-mode-workflows"
            >
              <Text style={styles.segText(mode === "workflows")}>
                {`Workflows${workflows.length > 0 ? ` (${workflows.length})` : ""}`}
              </Text>
            </Pressable>
          </View>
          {mode === "swarm" && swarms.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSwitcherOpen((v) => !v)}
              style={styles.chipBtn(switcherOpen)}
              testID="paseo-swarm-switcher-toggle"
            >
              <Text style={styles.chipText(switcherOpen)} numberOfLines={1}>
                {activeSwarm
                  ? `${activeSwarm.title.slice(0, 28)} · ${swarms.length} ▾`
                  : isZh
                    ? `切换 Swarm (${swarms.length}) ▾`
                    : `Switch Swarm (${swarms.length}) ▾`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.rightGroup}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void dataQuery.refetch()}
            style={styles.chipBtn(false)}
            testID="paseo-swarm-refresh-btn"
          >
            <Icon name="RefreshCw" size={13} color={theme.colors.foregroundMuted} />
            <Text style={styles.chipText(false)}>{isZh ? "刷新" : "Refresh"}</Text>
          </Pressable>
          {mode === "swarm" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => restartMutation.mutate()}
              style={styles.chipBtn(false)}
              testID="paseo-swarm-restart-btn"
            >
              <Icon name="RotateCcw" size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.chipText(false)}>{isZh ? "重载" : "Reload"}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {mode === "swarm" && switcherOpen && swarms.length > 0 ? (
        <View style={styles.pickerRow} testID="paseo-swarm-switcher-tray">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              {swarms.slice(0, 16).map((sw) => {
                const selected = activeSwarm?.swarmId === sw.swarmId;
                const isThisWs =
                  Boolean(data?.resolvedConversationId) &&
                  (sw.swarmId === data?.resolvedConversationId ||
                    sw.members.some((m) => m.conversationId === data?.resolvedConversationId));
                return (
                  <Pressable
                    key={sw.swarmId}
                    accessibilityRole="button"
                    onPress={() => {
                      setSelectedConversationId(sw.swarmId);
                      setSwitcherOpen(false);
                    }}
                    style={styles.chipBtn(selected)}
                    testID={`paseo-swarm-pick-${sw.swarmId.slice(0, 8)}`}
                  >
                    <Text style={styles.chipText(selected)} numberOfLines={1}>
                      {`${isThisWs ? (isZh ? "[当前] " : "[Current] ") : ""}${sw.title.slice(0, 26)} (${sw.memberCount}m · ${sw.postCount}p)`}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      ) : null}

      {dataQuery.isLoading && !data ? (
        <View style={styles.emptyWrap}>
          <Loading />
          <Text style={styles.muted}>
            {isZh ? "正在连接 Antigravity 原生 Swarm 面板…" : "Connecting to native Antigravity Swarm Board..."}
          </Text>
        </View>
      ) : mode === "swarm" ? (
        useWebIframe ? (
          <View style={styles.stageHost} testID={stageHostTestId}>
            {!iframeReady ? (
              <View style={styles.loadingOverlay}>
                <Loading />
                <Text style={styles.muted}>
                  {isZh ? "加载官方 Swarm Board / Members / Graph / Hive…" : "Loading official Swarm Board / Members / Graph / Hive..."}
                </Text>
              </View>
            ) : null}
          </View>
        ) : (
          <ScrollView style={styles.scrollBody}>
            {data?.activeSwarmSnapshot ? (
              <View style={{ gap: 10 }}>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{data.activeSwarmSnapshot.title}</Text>
                  <Text style={styles.muted}>
                    {data.activeSwarmSnapshot.memberCount} members · {data.activeSwarmSnapshot.postCount} posts
                  </Text>
                  {data.activeSwarmSnapshot.members.map((m) => (
                    <Pressable
                      key={m.name}
                      accessibilityRole="button"
                      onPress={() => handleOpenConversation(m.conversationId)}
                      style={styles.agentRow}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.cardTitle}>
                          @{m.name} ({m.role})
                        </Text>
                        <Text style={styles.muted}>
                          {m.status} · {m.model || "default"}
                        </Text>
                      </View>
                      <Text style={styles.muted}>{m.conversationId.slice(0, 8)} ↗</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{isZh ? "共享消息板" : "Shared Board"}</Text>
                  {data.activeSwarmSnapshot.messages.slice(-20).map((msg) => (
                    <View key={msg.seq} style={styles.phaseBox}>
                      <Text style={styles.muted}>
                        #{msg.seq} · @{msg.agent} · {msg.time}
                      </Text>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{msg.text}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <View style={styles.emptyWrap}>
                <Text style={styles.cardTitle}>
                  {isZh ? "当前尚未发现 Swarm 记录" : "No Swarm found yet"}
                </Text>
                <Text style={styles.muted}>
                  {isZh
                    ? "在 Antigravity 会话中输入 `/swarm <任务>` 启动原生多智能体蜂群，面板会自动实时呈现 Board / Members / Graph / Hive。"
                    : "Run `/swarm <task>` in an Antigravity session to start a native multi-agent swarm."}
                </Text>
              </View>
            )}
          </ScrollView>
        )
      ) : (
        <ScrollView style={styles.scrollBody} testID="paseo-workflows-list">
          {workflows.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.cardTitle}>
                {isZh ? "暂无 `/run-workflow` 运行记录" : "No `/run-workflow` runs found"}
              </Text>
              <Text style={styles.muted}>
                {isZh
                  ? "在 Antigravity 会话中输入 `/run-workflow <任务>` 编排 Python 多智能体流水线（agent / parallel / pipeline / phase）。"
                  : "Invoke `/run-workflow <task>` in an Antigravity session to orchestrate Python multi-agent pipelines."}
              </Text>
            </View>
          ) : (
            workflows.map((wf) => {
              const isExpanded = expandedWorkflowId === wf.id || workflows.length === 1;
              return (
                <View key={wf.id} style={styles.card} testID={`paseo-workflow-card-${wf.stepIndex}`}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setExpandedWorkflowId(isExpanded ? null : wf.id)}
                    style={{ gap: 4 }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={2}>
                        {wf.description}
                      </Text>
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{wf.status.toUpperCase()}</Text>
                      </View>
                    </View>
                    <Text style={styles.muted}>
                      {wf.phases.length} phase(s) · {wf.agents.length} agent(s) · {wf.logLineCount} log lines ·{" "}
                      {wf.appDataLabel} · conv {wf.conversationId.slice(0, 8)}
                    </Text>
                  </Pressable>

                  {isExpanded ? (
                    <View style={{ gap: 8 }}>
                      {wf.phases.map((ph, idx) => (
                        <View key={`${wf.id}-ph-${idx}`} style={styles.phaseBox}>
                          <Text style={styles.cardTitle}>{ph.name}</Text>
                          {ph.agents.map((ag, aIdx) => (
                            <Pressable
                              key={`${wf.id}-ag-${idx}-${aIdx}`}
                              accessibilityRole="button"
                              onPress={() => handleOpenConversation(ag.childConversationId)}
                              style={styles.agentRow}
                              testID={`paseo-workflow-agent-${ag.childConversationId?.slice(0, 8) ?? aIdx}`}
                            >
                              <View style={{ flex: 1, gap: 2 }}>
                                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                                  {ag.role} ({ag.typeName}) · {ag.status}
                                </Text>
                                {ag.summary ? (
                                  <Text style={styles.muted} numberOfLines={2}>
                                    {ag.summary}
                                  </Text>
                                ) : null}
                              </View>
                              {ag.childConversationId ? (
                                <Text style={styles.muted}>{ag.childConversationId.slice(0, 8)} ↗</Text>
                              ) : null}
                            </Pressable>
                          ))}
                          {ph.logs.slice(0, 6).map((ln, lIdx) => (
                            <Text key={`${wf.id}-lg-${idx}-${lIdx}`} style={styles.muted} numberOfLines={3}>
                              • {ln}
                            </Text>
                          ))}
                        </View>
                      ))}
                      {wf.output ? (
                        <View style={styles.phaseBox}>
                          <Text style={styles.muted}>Output</Text>
                          <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={8}>
                            {wf.output}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}
