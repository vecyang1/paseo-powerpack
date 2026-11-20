import { useRpc } from "@getpaseo/plugin/client";
import { Loading, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { inspectSwarmWorkflowRpc } from "../shared/swarm-workflow-contracts";
import {
  getSwarmWorkflowClientStatus,
  readSwarmWorkflowPrefs,
  requestOpenSwarmWorkspacePanel,
  syncSwarmWorkflowPrefs,
} from "./swarm-workflow-web";

type Styles = Record<
  | "diagBox"
  | "row"
  | "btn"
  | "btnText"
  | "secondaryBtn"
  | "secondaryBtnText"
  | "label"
  | "detail",
  object
>;

export function SwarmWorkflowSettingsSection({
  isZh,
  styles,
}: {
  isZh: boolean;
  styles: Styles;
}) {
  const toast = useToast();
  const inspectSwarmWorkflow = useRpc(inspectSwarmWorkflowRpc);
  const [prefs, setPrefs] = useState(() => readSwarmWorkflowPrefs());
  const clientStatus = getSwarmWorkflowClientStatus();

  const statusQuery = useQuery({
    queryKey: ["finder.swarmWorkflowSettingsStatus"],
    queryFn: () => inspectSwarmWorkflow({ action: "status", limit: 15 }),
    staleTime: 4000,
  });

  const probeMutation = useMutation({
    mutationFn: () => inspectSwarmWorkflow({ action: "probe", limit: 15 }),
    onSuccess: (res) => {
      void statusQuery.refetch();
      toast.show(res.message, { variant: res.ok ? "success" : "error" });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const restartMutation = useMutation({
    mutationFn: () => inspectSwarmWorkflow({ action: "restart_board", limit: 15 }),
    onSuccess: (res) => {
      void statusQuery.refetch();
      toast.show(res.message, { variant: res.ok ? "success" : "error" });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const data = probeMutation.data ?? statusQuery.data;
  const probe = probeMutation.data?.probe ?? data?.probe ?? null;

  const updatePref = (key: keyof typeof prefs, value: boolean) => {
    const next = syncSwarmWorkflowPrefs({ [key]: value });
    setPrefs(next);
  };

  return (
    <SettingsSection
      title={
        isZh
          ? "Antigravity 原生 Swarm & Run-Workflow 桥接 (能读 / 能试 / 能调)"
          : "Antigravity Native Swarm & Run-Workflow Bridge"
      }
    >
      <View style={styles.diagBox as never} testID="paseo-swarm-workflow-settings-section">
        <Text style={styles.detail as never}>
          {isZh
            ? "零拷贝复用磁盘官方 swarm_board (Overview / Board / Members / Graph / Hive / GIF) 与原生 /swarm、/run-workflow 透传，免疫 Paseo 与 agy 更新。"
            : "Zero-copy bridge to Antigravity's on-disk swarm_board (Overview / Board / Members / Graph / Hive / GIF) and native /swarm + /run-workflow passthrough across Paseo & agy updates."}
        </Text>
        {statusQuery.isLoading && !data ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Loading />
            <Text style={styles.detail as never}>
              {isZh ? "正在读取本地 Swarm 状态…" : "Loading local Swarm status..."}
            </Text>
          </View>
        ) : null}
        <View style={{ gap: 8 }}>
          <Text style={styles.label as never}>
            {`agy=${data?.bridge.agyVersion ?? "unknown"} · bridge=${data?.bridge.running ? `live (${data.bridge.proxyUrl})` : "standby"} · sdk=${data?.bridge.sidecarSdkMode ?? "unavailable"}`}
          </Text>
          <Text style={styles.detail as never}>
            {`swarms=${data?.swarms.length ?? 0} · workflows=${data?.workflows.length ?? 0} · features: overview=${String(data?.bridge.features.overview ?? false)} graph=${String(data?.bridge.features.graph ?? false)} hive=${String(data?.bridge.features.hive ?? false)} gif=${String(data?.bridge.features.gifExport ?? false)}`}
          </Text>
          <Text style={styles.detail as never}>
            {`upstream=${data?.bridge.upstreamDir ?? "not found"} · intercepts: sidecar=${clientStatus.interceptedSidecarClicks} /swarm-board=${clientStatus.interceptedBoardCommands} · autoOpen=${clientStatus.autoOpenedSwarmPanels} · nativeTabs=${clientStatus.openedMemberNativeTabs}`}
          </Text>

          <View style={styles.row as never}>
            <Pressable
              accessibilityRole="button"
              onPress={() => probeMutation.mutate()}
              style={styles.btn as never}
              testID="paseo-swarm-settings-probe-btn"
            >
              <Text style={styles.btnText as never}>
                {probeMutation.isPending
                  ? isZh
                    ? "探测中…"
                    : "Probing..."
                  : isZh
                    ? "运行实盘探测"
                    : "Run Live Probe"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => restartMutation.mutate()}
              style={styles.secondaryBtn as never}
              testID="paseo-swarm-settings-restart-btn"
            >
              <Text style={styles.secondaryBtnText as never}>
                {isZh ? "重载官方 Board" : "Reload Official Board"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => requestOpenSwarmWorkspacePanel({ tab: "swarm" })}
              style={styles.secondaryBtn as never}
            >
              <Text style={styles.secondaryBtnText as never}>
                {isZh ? "打开 Swarm 面板" : "Open Swarm Panel"}
              </Text>
            </Pressable>
          </View>

          <SettingsSwitch
            label={
              isZh
                ? "在对话时间线内联渲染实时 Swarm 进度卡片与一键打开看板按钮"
                : "Render inline live Swarm progress card and Open Board button in chat timeline"
            }
            value={prefs.enableLiveSwarmCard}
            onValueChange={(v) => updatePref("enableLiveSwarmCard", v)}
          />
          <SettingsSwitch
            label={
              isZh
                ? "启动新 Swarm 时自动在工作区打开 Swarm 实时看板标签页（每个蜂群仅自动打开一次）"
                : "Auto-open Swarm workspace tab once when a live Swarm starts"
            }
            value={prefs.autoOpenSwarmTabOnStart}
            onValueChange={(v) => updatePref("autoOpenSwarmTabOnStart", v)}
          />
          <SettingsSwitch
            label={
              isZh
                ? "拦截聊天中 sidecar://swarm/swarm_board 链接直开 Swarm 面板"
                : "Intercept sidecar://swarm/swarm_board chat links into Swarm panel"
            }
            value={prefs.interceptSidecarLinks}
            onValueChange={(v) => updatePref("interceptSidecarLinks", v)}
          />
          <SettingsSwitch
            label={
              isZh
                ? "拦截裸 /swarm board 指令直开 Swarm 面板（不消耗 LLM 回合）"
                : "Intercept bare /swarm board command to open Swarm panel (zero LLM spend)"
            }
            value={prefs.interceptSwarmBoardCommand}
            onValueChange={(v) => updatePref("interceptSwarmBoardCommand", v)}
          />

          {probe ? (
            <View style={{ gap: 4 }} testID="paseo-swarm-settings-probe-result">
              {probe.checks.map((c) => (
                <Text key={c.name} style={styles.detail as never}>
                  {`${c.ok ? "[PASS]" : "[FAIL]"} ${c.name}: ${c.detail}`}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}
