// Live inline Swarm Board card for Antigravity native `swarm` tool calls.
//
// Headless `agy_cli` reports `"board": "local" / "There is no live board to open here"`,
// leaving the chat timeline with only raw tool_call badges and no live board link.
// This card uses Paseo's official `addTimelineTransformer` + `addTimelineRenderer` API
// (same pattern as `client/claude-workflow-card.tsx`) to render live swarm progress,
// clickable member status chips, latest board post preview, and a 1-click "Open Board"
// button into Paseo's native `Swarm` workspace panel.
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  SWARM_LIVE_CARD_KIND,
  SWARM_LIVE_CARD_VERSION,
  SwarmLiveCardDataSchema,
  type InspectSwarmWorkflowInput,
  type InspectSwarmWorkflowOutput,
  type SwarmLiveCardData,
  type SwarmMemberSummary,
  buildSwarmLiveCardData,
  inspectSwarmWorkflowRpc,
} from "../shared/swarm-workflow-contracts";
import { isChineseLocale } from "./i18n";
import {
  maybeAutoOpenSwarmPanelForActiveRun,
  notifyWorkspaceSwarmPresence,
  openSwarmMemberConversationInPaseo,
  readSwarmWorkflowPrefs,
  requestOpenSwarmWorkspacePanel,
} from "./swarm-workflow-web";

type SwarmRpc = (input: InspectSwarmWorkflowInput) => Promise<InspectSwarmWorkflowOutput>;
type ThemeColors = PluginTimelineItemProps["theme"]["colors"];

export const swarmLiveCardStatus = {
  transformed: 0,
  mounted: 0,
  polls: 0,
  lastPollMs: null as number | null,
  lastSwarmId: null as string | null,
  lastError: null as string | null,
};

// Track which callId is the primary full-card anchor per Paseo agent session so repeated
// `swarm{action:"add"|"status"|"kill"}` tool calls in the same turn stay compact 1-line rows.
const anchorCallIdByAgent = new Map<string, string>();
const mountedCallIdsByAgent = new Map<string, Set<string>>();

function claimAnchorRole(agentId: string, data: SwarmLiveCardData): boolean {
  let set = mountedCallIdsByAgent.get(agentId);
  if (!set) {
    set = new Set<string>();
    mountedCallIdsByAgent.set(agentId, set);
  }
  set.add(data.callId);
  const current = anchorCallIdByAgent.get(agentId);
  if (!current || !set.has(current)) {
    anchorCallIdByAgent.set(agentId, data.callId);
    return true;
  }
  // Prefer a `title` call as anchor if one appears before any other card settled as anchor
  if (data.action === "title" && current !== data.callId && !current.includes(":title:")) {
    anchorCallIdByAgent.set(agentId, data.callId);
    return true;
  }
  return current === data.callId;
}

function releaseMountedCall(agentId: string, callId: string): void {
  const set = mountedCallIdsByAgent.get(agentId);
  if (!set) return;
  set.delete(callId);
  if (set.size === 0) {
    mountedCallIdsByAgent.delete(agentId);
    anchorCallIdByAgent.delete(agentId);
  } else if (anchorCallIdByAgent.get(agentId) === callId) {
    const next = set.values().next().value;
    if (next) anchorCallIdByAgent.set(agentId, next);
  }
}

function memberStatusColor(status: SwarmMemberSummary["status"], colors: ThemeColors): string {
  switch (status) {
    case "working":
      return colors.statusSuccess;
    case "killed":
      return colors.foregroundMuted;
    case "stopped":
      return colors.statusWarning;
    default:
      return colors.accent;
  }
}

function StatusDot({
  color,
  hollow,
  size = 7,
}: {
  color: string;
  hollow?: boolean;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hollow ? "transparent" : color,
        borderWidth: 1.25,
        borderColor: color,
      }}
    />
  );
}

function describeCompactAction(data: SwarmLiveCardData, isZh: boolean): string {
  const act = data.action;
  if (act === "add" && data.memberName) {
    return isZh ? `添加成员 @${data.memberName}` : `Added @${data.memberName}`;
  }
  if (act === "kill" && data.memberName) {
    return isZh ? `结束成员 @${data.memberName}` : `Retired @${data.memberName}`;
  }
  if (act === "title" && data.title) {
    return isZh ? `命名蜂群 · ${data.title}` : `Titled · ${data.title}`;
  }
  if (act === "model" && data.memberName) {
    return isZh
      ? `切换 @${data.memberName} 模型${data.model ? ` → ${data.model}` : ""}`
      : `Model @${data.memberName}${data.model ? ` → ${data.model}` : ""}`;
  }
  if (act === "status") {
    return isZh ? "检查蜂群状态" : "Checked swarm status";
  }
  if (act === "models") {
    return isZh ? "查看可用模型" : "Listed models";
  }
  return data.memberName ? `${act} @${data.memberName}` : act;
}

function createSwarmLiveCard(getRpc: () => SwarmRpc, getLocale: () => string) {
  return function SwarmLiveCard(props: PluginTimelineItemProps<SwarmLiveCardData>) {
    const { agentId, item, theme } = props;
    const colors = theme.colors;
    const data = item.data;
    const isZh = isChineseLocale(getLocale());
    const rpc = useMemo(() => getRpc(), []);

    const [isAnchor] = useState(() => claimAnchorRole(agentId, data));
    const [snapshot, setSnapshot] = useState<InspectSwarmWorkflowOutput["activeSwarmSnapshot"]>(null);

    useEffect(() => {
      swarmLiveCardStatus.mounted += 1;
      return () => {
        swarmLiveCardStatus.mounted = Math.max(0, swarmLiveCardStatus.mounted - 1);
        releaseMountedCall(agentId, data.callId);
      };
    }, [agentId, data.callId]);

    useEffect(() => {
      if (!isAnchor) return;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const mountedAt = Date.now();

      const tick = async () => {
        const hidden =
          typeof document !== "undefined" && document.visibilityState === "hidden";
        let keepPolling = false;
        if (!hidden) {
          try {
            const out = await rpc({
              action: "inspect_swarm_snapshot",
              agentId,
              limit: 20,
            });
            swarmLiveCardStatus.polls += 1;
            swarmLiveCardStatus.lastPollMs = out.durationMs;
            if (!alive) return;
            const snap = out.activeSwarmSnapshot;
            if (snap) {
              setSnapshot(snap);
              swarmLiveCardStatus.lastSwarmId = snap.swarmId;
              swarmLiveCardStatus.lastError = null;
              const activeCount =
                snap.activeCount ??
                snap.members.filter((m) => m.status === "working" && !m.killed).length;
              if (snap.paseoWorkspaceId) {
                notifyWorkspaceSwarmPresence({
                  workspaceId: snap.paseoWorkspaceId,
                  swarmId: snap.swarmId,
                  title: snap.title,
                  activeCount,
                  memberCount: snap.memberCount,
                  postCount: snap.postCount,
                });
              }
              if (data.isLiveStreaming || activeCount > 0) {
                maybeAutoOpenSwarmPanelForActiveRun({
                  swarmId: snap.swarmId,
                  workspaceId: snap.paseoWorkspaceId,
                  conversationId: snap.swarmId,
                  activeCount,
                  isLiveStreaming: data.isLiveStreaming,
                });
              }
              keepPolling = activeCount > 0 || data.isLiveStreaming;
            } else {
              // Brief retry window right after swarm creation before members.json flushes
              keepPolling = data.isLiveStreaming || Date.now() - mountedAt < 25_000;
            }
          } catch (err) {
            swarmLiveCardStatus.lastError = err instanceof Error ? err.message : String(err);
            keepPolling = Date.now() - mountedAt < 15_000;
          }
        } else {
          keepPolling = data.isLiveStreaming;
        }
        if (alive && keepPolling) {
          timer = setTimeout(tick, 3_500);
        }
      };

      void tick();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, [agentId, data.isLiveStreaming, isAnchor, rpc]);

    const openBoard = useCallback(
      (swarmTab?: string) => {
        requestOpenSwarmWorkspacePanel({
          tab: "swarm",
          conversationId: snapshot?.swarmId,
          swarmTab,
          workspaceId: snapshot?.paseoWorkspaceId ?? undefined,
        });
      },
      [snapshot?.paseoWorkspaceId, snapshot?.swarmId],
    );

    const openMember = useCallback(
      (member: SwarmMemberSummary) => {
        if (!member.conversationId) return;
        openSwarmMemberConversationInPaseo(member.conversationId, {
          workspaceId: snapshot?.paseoWorkspaceId ?? null,
          parentAgentId: agentId,
        });
      },
      [agentId, snapshot?.paseoWorkspaceId],
    );

    if (!isAnchor) {
      return (
        <View
          testID={`antigravity-swarm-row-${data.callId}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 5,
            marginVertical: 2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: colors.foregroundMuted }}>
              Swarm
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, flex: 1 }}>
              {describeCompactAction(data, isZh)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => openBoard()}
            style={{ paddingHorizontal: 6, paddingVertical: 2 }}
            testID={`antigravity-swarm-row-open-${data.callId}`}
          >
            <Text style={{ fontSize: 11, fontWeight: "600", color: colors.accent }}>
              {isZh ? "打开看板" : "Open Board"}
            </Text>
          </Pressable>
        </View>
      );
    }

    const members = snapshot?.members ?? [];
    const nonCoordMembers = members.filter((m) => m.name !== "coordinator");
    const displayMembers = nonCoordMembers.length > 0 ? nonCoordMembers : members;
    const activeCount =
      snapshot?.activeCount ??
      members.filter((m) => m.status === "working" && !m.killed).length;
    const waitingCount =
      snapshot?.waitingCount ??
      members.filter((m) => m.status === "waiting" && !m.killed).length;
    const killedCount =
      snapshot?.killedCount ?? members.filter((m) => m.killed || m.status === "killed").length;
    const isLive = activeCount > 0 || data.isLiveStreaming;
    const latestMsg =
      snapshot && snapshot.messages.length > 0
        ? snapshot.messages[snapshot.messages.length - 1]
        : null;
    const title =
      snapshot?.title ??
      data.title ??
      (data.memberName ? `Swarm · @${data.memberName}` : "Antigravity Swarm");

    const metaParts: string[] = [];
    if (snapshot) {
      metaParts.push(isZh ? `${snapshot.memberCount} 成员` : `${snapshot.memberCount} members`);
      if (activeCount > 0) {
        metaParts.push(isZh ? `${activeCount} 运行中` : `${activeCount} active`);
      } else if (waitingCount > 0) {
        metaParts.push(isZh ? `${waitingCount} 待命` : `${waitingCount} standing by`);
      }
      if (killedCount > 0) {
        metaParts.push(isZh ? `${killedCount} 已结束` : `${killedCount} retired`);
      }
      metaParts.push(isZh ? `${snapshot.postCount} 条板帖` : `${snapshot.postCount} posts`);
    } else {
      metaParts.push(describeCompactAction(data, isZh));
    }

    return (
      <View
        testID={`antigravity-swarm-card-${data.callId}`}
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          backgroundColor: colors.surface0,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 7,
          marginVertical: 4,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: colors.foregroundMuted }}>
            Swarm
          </Text>
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.foreground }}
          >
            {title}
          </Text>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
            testID="antigravity-swarm-card-status"
          >
            <StatusDot
              color={isLive ? colors.statusSuccess : colors.foregroundMuted}
              hollow={!isLive}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: "600",
                color: isLive ? colors.statusSuccess : colors.foregroundMuted,
              }}
            >
              {isLive ? "Live" : isZh ? "已就绪" : "Ready"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => openBoard("feed")}
            style={{
              paddingHorizontal: 9,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: colors.surface2,
              borderWidth: 1,
              borderColor: colors.border,
            }}
            testID="antigravity-swarm-card-open"
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.foreground }}>
              {isZh ? "打开看板 ↗" : "Open Swarm ↗"}
            </Text>
          </Pressable>
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: colors.foregroundMuted,
              fontVariant: ["tabular-nums"],
            }}
            testID="antigravity-swarm-card-meta"
          >
            {metaParts.join(" · ")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => openBoard("feed")}
              testID="antigravity-swarm-card-tab-board"
            >
              <Text style={{ fontSize: 11, color: colors.accent }}>Board</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => openBoard("members")}
              testID="antigravity-swarm-card-tab-members"
            >
              <Text style={{ fontSize: 11, color: colors.accent }}>Members</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => openBoard("graph")}
              testID="antigravity-swarm-card-tab-graph"
            >
              <Text style={{ fontSize: 11, color: colors.accent }}>Graph</Text>
            </Pressable>
          </View>
        </View>

        {displayMembers.length > 0 ? (
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
            testID="antigravity-swarm-card-members"
          >
            {displayMembers.slice(0, 10).map((m) => {
              const dotColor = memberStatusColor(m.status, colors);
              const retired = m.killed || m.status === "killed";
              return (
                <Pressable
                  key={m.name}
                  accessibilityRole="button"
                  onPress={() => openMember(m)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface1,
                    opacity: retired ? 0.6 : 1,
                  }}
                  testID={`antigravity-swarm-member-chip-${m.name}`}
                >
                  <StatusDot
                    color={dotColor}
                    hollow={m.status === "waiting"}
                    size={6}
                  />
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "500",
                      color: colors.foreground,
                      textDecorationLine: retired ? "line-through" : "none",
                    }}
                  >
                    @{m.name}
                  </Text>
                  {m.activity && m.status === "working" ? (
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 10, color: colors.foregroundMuted, maxWidth: 140 }}
                    >
                      {m.activity}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {latestMsg ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => openBoard("feed")}
            style={{
              paddingTop: 6,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
            testID="antigravity-swarm-card-latest-post"
          >
            <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foregroundMuted }}>
              {`#${latestMsg.seq} @${latestMsg.agent}: ${latestMsg.text.replace(/\s+/g, " ").trim()}`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
}

export function installSwarmLiveCard(client: PluginClientContext): () => void {
  const rpc: SwarmRpc = (input) => client.rpc(inspectSwarmWorkflowRpc, input);
  const cleanups = [
    client.addTimelineTransformer({
      id: "antigravity-swarm-live-card",
      query: { itemType: "tool_call" },
      transform: ({ item, phase }) => {
        const prefs = readSwarmWorkflowPrefs();
        if (!prefs.enableNativeSwarmBridge || !prefs.enableLiveSwarmCard) return undefined;
        const data = buildSwarmLiveCardData(item, phase);
        if (!data) return undefined;
        swarmLiveCardStatus.transformed += 1;
        return {
          items: [
            {
              type: "plugin",
              id: `antigravity-swarm-${data.callId}`,
              kind: SWARM_LIVE_CARD_KIND,
              version: SWARM_LIVE_CARD_VERSION,
              data,
            },
          ],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: SWARM_LIVE_CARD_KIND,
      version: SWARM_LIVE_CARD_VERSION,
      schema: SwarmLiveCardDataSchema,
      Component: createSwarmLiveCard(
        () => rpc,
        () => client.i18n.locale,
      ),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
