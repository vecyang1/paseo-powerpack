import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsSelect,
  SettingsSection,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RpcOutput } from "@getpaseo/plugin";
import { manageMultiModelRaceRpc } from "../shared/multi-model-race-contracts";
import { openMultiModelRaceModal } from "./multi-model-race-web";

type RaceSnapshot = RpcOutput<typeof manageMultiModelRaceRpc>;

type Styles = Record<
  | "diagBox"
  | "row"
  | "input"
  | "btn"
  | "btnText"
  | "secondaryBtn"
  | "secondaryBtnText"
  | "label"
  | "detail",
  object
>;

const ISOLATION_OPTIONS_ZH = [
  { value: "worktree", label: "独立 Git Worktree" },
  { value: "local", label: "本地目录" },
];

const ISOLATION_OPTIONS_EN = [
  { value: "worktree", label: "Isolated Git Worktree" },
  { value: "local", label: "Local Directory" },
];

const MAX_CONTENDER_OPTIONS = [
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "6", label: "6" },
  { value: "8", label: "8" },
];

export function MultiModelRaceSettingsSection({
  isZh,
  styles,
  openWorkspace,
}: {
  isZh: boolean;
  styles: Styles;
  openWorkspace?: (workspaceId: string) => void;
}) {
  const toast = useToast();
  const callRace = useRpc(manageMultiModelRaceRpc);
  const [snap, setSnap] = useState<RaceSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void callRace({ action: "status" })
      .then((res) => {
        if (alive) setSnap(res);
      })
      .catch(() => {
        // Ignore silent initial fetch error
      });
    return () => {
      alive = false;
    };
  }, [callRace]);

  const invoke = (payload: Parameters<typeof callRace>[0], okMessage?: string) => {
    if (busy) return;
    setBusy(true);
    void callRace(payload)
      .then((res) => {
        setSnap(res);
        if (!res.ok) {
          toast.show(res.error || (isZh ? "赛马配置执行失败" : "Multi-model race request failed"), {
            variant: "error",
          });
        } else if (okMessage) {
          toast.show(okMessage, { variant: "success" });
        }
      })
      .catch((err) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const runDryRunProbe = () => {
    const profs = snap?.profiles ?? [];
    if (profs.length < 2) {
      toast.show(
        isZh
          ? "至少需要 2 个已配置 Agent Profile 才能预演"
          : "Need at least 2 configured Agent Profiles to dry-run",
        { variant: "error" },
      );
      return;
    }
    const first = profs[0];
    const second = profs.find((p) => p.provider !== first.provider) || profs[1];
    invoke(
      {
        action: "dry_run",
        prompt: "Dry-run probe: verify parallel worktree branch plan",
        title: "probe",
        contenders: [
          {
            profileId: first.id,
            profile: first.name,
            provider: first.provider,
            model: first.model,
            thinking: first.thinking,
            mode: first.mode,
          },
          {
            profileId: second.id,
            profile: second.name,
            provider: second.provider,
            model: second.model,
            thinking: second.thinking,
            mode: second.mode,
          },
        ],
      },
      isZh ? "实测预演通过：分支与隔离策略校验正常" : "Live dry-run passed: branches and isolation verified",
    );
  };

  const cfg = snap?.config;
  const isoValue = cfg?.defaultIsolation ?? "worktree";
  const maxValue = String(cfg?.maxContenders ?? 6);
  const showTrigger = cfg?.showNewWorkspaceTrigger ?? true;

  return (
    <SettingsSection
      title={isZh ? "多模型并行 Worktree 赛马" : "Multi-Model Parallel Worktree Race"}
    >
      <View style={styles.diagBox} testID="multi-model-race-settings-card">
        <Text style={styles.label}>
          {isZh
            ? "单条提示词同时派发给多个模型/配置在独立 Worktree 并行实现，持久化台账存于 ~/.paseo/vec-races/races.json（⇧⌘M / /race）。"
            : "Dispatch one prompt across multiple models or profiles in isolated worktrees, persisted in ~/.paseo/vec-races/races.json (⇧⌘M / /race)."}
        </Text>
        <Text style={styles.detail}>
          {snap
            ? isZh
              ? `可用配置 ${snap.profiles.length} 个 · 注册项目 ${snap.projects.length} 个 · 历史赛马 ${snap.totalRaces} 次（活跃 ${snap.activeRaces}） · 台账 ${snap.ledgerPath}`
              : `Profiles: ${snap.profiles.length} · Projects: ${snap.projects.length} · Races: ${snap.totalRaces} (${snap.activeRaces} active) · Ledger: ${snap.ledgerPath}`
            : isZh
              ? "正在读取台账与配置..."
              : "Loading race ledger and profiles..."}
        </Text>
        {snap?.preview ? (
          <Text style={styles.detail}>
            {isZh
              ? `最近预演：${snap.preview.isolation} · ${snap.preview.contenders.map((c) => `${c.profile} -> ${c.branch || "local"}`).join(" | ")}`
              : `Last dry-run: ${snap.preview.isolation} · ${snap.preview.contenders.map((c) => `${c.profile} -> ${c.branch || "local"}`).join(" | ")}`}
          </Text>
        ) : null}

        <View style={styles.row}>
          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() => {
              void openMultiModelRaceModal({
                call: (input) => callRace(input),
                getLocale: () => (isZh ? "zh-CN" : "en"),
                showToast: (msg, o) => {
                  toast.show(msg, { variant: o?.variant === "error" ? "error" : "success" });
                },
                openWorkspace,
              });
            }}
          >
            <Text style={styles.btnText}>
              {isZh ? "打开并行发起器" : "Open Race Launcher"}
            </Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} disabled={busy} onPress={runDryRunProbe}>
            <Text style={styles.secondaryBtnText}>
              {isZh ? "实测预演" : "Dry-Run Probe"}
            </Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={() => invoke({ action: "reset" }, isZh ? "已恢复赛马默认策略" : "Restored default race settings")}
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "恢复默认" : "Restore Defaults"}
            </Text>
          </Pressable>
        </View>
      </View>

      <SettingsSelect
        label={isZh ? "默认隔离模式" : "Default isolation"}
        value={isoValue}
        options={isZh ? ISOLATION_OPTIONS_ZH : ISOLATION_OPTIONS_EN}
        onValueChange={(v) =>
          invoke(
            { action: "configure", config: { defaultIsolation: v === "local" ? "local" : "worktree" } },
            isZh ? "已更新默认隔离模式" : "Updated default isolation",
          )
        }
      />

      <SettingsSelect
        label={isZh ? "单次最大并发模型数" : "Max parallel contenders"}
        value={maxValue}
        options={MAX_CONTENDER_OPTIONS}
        onValueChange={(v) =>
          invoke(
            { action: "configure", config: { maxContenders: Number.parseInt(v, 10) || 6 } },
            isZh ? "已更新并发上限" : "Updated max contenders",
          )
        }
      />

      <SettingsSwitch
        label={isZh ? "在 New Workspace 页面显示「多模型并行」入口" : "Show Multi-Model Race button on New Workspace"}
        value={showTrigger}
        onValueChange={(val) =>
          invoke(
            { action: "configure", config: { showNewWorkspaceTrigger: val } },
            isZh ? "已更新入口显示开关" : "Updated New Workspace trigger setting",
          )
        }
      />
    </SettingsSection>
  );
}
