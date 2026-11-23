import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RpcOutput } from "@getpaseo/plugin";
import { manageIntakeDecisionsRpc } from "../shared/intake-decisions-contracts";
import {
  openIntakeDecisionsDrawer,
  readIntakeDecisionsPrefs,
  writeIntakeDecisionsPrefs,
} from "./intake-decisions-web";
import { getWebWindow } from "./web";

type DecisionsSnapshot = RpcOutput<typeof manageIntakeDecisionsRpc>;

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

export function IntakeDecisionsSettingsSection({
  isZh,
  styles,
}: {
  isZh: boolean;
  styles: Styles;
}) {
  const toast = useToast();
  const callDecisions = useRpc(manageIntakeDecisionsRpc);
  const [snap, setSnap] = useState<DecisionsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortcutEnabled, setShortcutEnabled] = useState<boolean>(() =>
    readIntakeDecisionsPrefs(getWebWindow()).enableShortcut,
  );

  useEffect(() => {
    let alive = true;
    void callDecisions({ action: "list" })
      .then((res) => {
        if (alive) setSnap(res);
      })
      .catch(() => {
        // Ignore background initial fetch errors
      });
    return () => {
      alive = false;
    };
  }, [callDecisions]);

  const refreshQueue = () => {
    if (busy) return;
    setBusy(true);
    void callDecisions({ action: "list", refresh: true })
      .then((res) => {
        setSnap(res);
        toast.show(res.message);
      })
      .catch((err: unknown) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => setBusy(false));
  };

  const previewTopItem = () => {
    if (busy) return;
    const first = snap?.items[0];
    if (!first) {
      toast.show(isZh ? "当前队列没有待拍板项" : "No pending decision items");
      return;
    }
    const recChoice = (first.options.find((o) => o.recommended) ?? first.options[0])?.index;
    setBusy(true);
    void callDecisions({
      action: "preview_answer",
      taskId: first.shortId,
      choice: recChoice,
      text: recChoice === undefined ? "Approve and continue" : undefined,
    })
      .then((res) => {
        setSnap(res);
        toast.show(res.message);
      })
      .catch((err: unknown) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => setBusy(false));
  };

  const resetConfigDefaults = () => {
    if (busy) return;
    setBusy(true);
    void callDecisions({ action: "tune_config", configAction: "reset" })
      .then((res) => {
        setSnap(res);
        const nextPrefs = { enableShortcut: true };
        writeIntakeDecisionsPrefs(nextPrefs, getWebWindow());
        setShortcutEnabled(true);
        toast.show(isZh ? "已恢复默认路由与拍板参数" : "Restored default decision queue parameters");
      })
      .catch((err: unknown) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => setBusy(false));
  };

  const toggleExternalScan = () => {
    if (busy) return;
    const next = !(snap?.externalScanEnabled ?? true);
    setBusy(true);
    void callDecisions({
      action: "tune_config",
      configAction: "set",
      configKey: "external_scan_enabled",
      configValue: next ? "true" : "false",
    })
      .then((res) => {
        setSnap(res);
        toast.show(
          isZh
            ? next
              ? "已开启邮件与 GitHub 自动扫描修复"
              : "已暂停邮件与 GitHub 自动扫描修复"
            : next
              ? "Enabled automatic email and GitHub scanning"
              : "Paused automatic email and GitHub scanning",
        );
      })
      .catch((err: unknown) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => setBusy(false));
  };

  const runExternalScan = (dryRun: boolean, sources: string) => {
    if (busy) return;
    setBusy(true);
    void callDecisions({
      action: "scan_external",
      dryRun,
      sources,
      force: true,
    })
      .then((res) => {
        setSnap(res);
        toast.show(res.message);
      })
      .catch((err: unknown) => {
        toast.show(err instanceof Error ? err.message : String(err), { variant: "error" });
      })
      .finally(() => setBusy(false));
  };

  const toggleShortcut = () => {
    const next = !shortcutEnabled;
    writeIntakeDecisionsPrefs({ enableShortcut: next }, getWebWindow());
    setShortcutEnabled(next);
    toast.show(
      isZh
        ? next
          ? "已启用快捷键 Ctrl+Cmd+D"
          : "已停用快捷键 Ctrl+Cmd+D"
        : next
          ? "Enabled Ctrl+Cmd+D shortcut"
          : "Disabled Ctrl+Cmd+D shortcut",
    );
  };

  const externalEnabled = snap?.externalScanEnabled ?? true;
  const sourcesSummary = (snap?.includeSources ?? []).join(" / ") || "-";

  return (
    <SettingsSection
      title={isZh ? "任务拍板与邮件 GitHub 自动修复队列" : "Task Decisions & Auto Email/GitHub Intake"}
    >
      <View style={styles.diagBox} testID="intake-decisions-settings-card">
        <Text style={styles.label}>
          {isZh
            ? "自动扫描邮件、GitHub 评论、PR 评审与构建失败并派发修复；遇到扣款、税务、删除或对外发信节点则汇总至拍板队列，一键确认后原会话续跑。"
            : "Automatically scans emails, GitHub comments, PR reviews, and CI failures for autonomous fixes, while gating spend, tax, deletion, or human outreach in the 1-click decision queue."}
        </Text>

        <Text style={styles.detail}>
          {isZh
            ? `待拍板：${snap?.actionableBlockedCount ?? 0} 项 · 已完成：${snap?.doneCount ?? 0} 项 · 带关注完成：${snap?.concernsCount ?? 0} 项 · 已折叠重复项：${snap?.supersededDuplicateCount ?? 0} 项`
            : `Pending decisions: ${snap?.actionableBlockedCount ?? 0} · Completed: ${snap?.doneCount ?? 0} · Concerns: ${snap?.concernsCount ?? 0} · Folded duplicates: ${snap?.supersededDuplicateCount ?? 0}`}
        </Text>

        <Text style={styles.detail} testID="intake-external-scan-status">
          {isZh
            ? `邮件与 GitHub 自动扫描：${externalEnabled ? "已开启" : "已暂停"} · 周期：GitHub 每 ${snap?.githubScanIntervalMinutes ?? 15} 分钟 / 邮件每 ${snap?.emailScanIntervalMinutes ?? 120} 分钟 · 最近扫描：${snap?.lastExternalScanAt ?? "尚未运行"}`
            : `Auto email & GitHub scan: ${externalEnabled ? "enabled" : "paused"} · Cadence: GitHub every ${snap?.githubScanIntervalMinutes ?? 15}m / Email every ${snap?.emailScanIntervalMinutes ?? 120}m · Last scan: ${snap?.lastExternalScanAt ?? "never"}`}
        </Text>

        <Text style={styles.detail}>
          {isZh
            ? `纳入来源：${sourcesSummary} · 跳数熔断上限：${snap?.maxDecisionRounds ?? 8} 轮 · 并发上限：${snap?.maxConcurrent ?? 4} · 快捷键 Ctrl+Cmd+D：${shortcutEnabled ? "已开启" : "已关闭"}`
            : `Included sources: ${sourcesSummary} · Hop breaker ceiling: ${snap?.maxDecisionRounds ?? 8} rounds · Max concurrent: ${snap?.maxConcurrent ?? 4} · Shortcut Ctrl+Cmd+D: ${shortcutEnabled ? "enabled" : "disabled"}`}
        </Text>

        {snap?.externalScan ? (
          <Text style={styles.detail} testID="intake-external-scan-preview">
            {isZh
              ? `${snap.externalScan.dryRun ? "干跑扫描结果" : "实跑扫描结果"}：GitHub 通知 ${snap.externalScan.githubNotifications} 条（待建 ${snap.externalScan.githubCreated} / 自动结案 ${snap.externalScan.githubAutoResolved} / 跳过 ${snap.externalScan.githubSkipped}）· 邮件扫描 ${snap.externalScan.emailScanned} 封（高优 ${snap.externalScan.emailTier1} / 派单 ${snap.externalScan.emailSpawned}）`
              : `${snap.externalScan.dryRun ? "Dry-run scan" : "Live scan"}: GitHub ${snap.externalScan.githubNotifications} notifications (+${snap.externalScan.githubCreated} / auto-resolved ${snap.externalScan.githubAutoResolved} / skipped ${snap.externalScan.githubSkipped}) · Email ${snap.externalScan.emailScanned} scanned (tier1 ${snap.externalScan.emailTier1} / spawned ${snap.externalScan.emailSpawned})`}
          </Text>
        ) : null}

        {snap?.preview ? (
          <Text style={styles.detail} testID="intake-decisions-settings-preview">
            {isZh
              ? `干跑预演结果：${snap.preview.shortId} -> 模式 ${snap.preview.mode} · 目标会话 ${(snap.preview.agentId ?? "-").slice(0, 8)} (${snap.preview.agentStatus ?? "-"}) · 第 ${snap.preview.round ?? 1}/${snap.preview.maxDecisionRounds ?? 8} 轮`
              : `Dry-run preview: ${snap.preview.shortId} -> ${snap.preview.mode} · agent ${(snap.preview.agentId ?? "-").slice(0, 8)} (${snap.preview.agentStatus ?? "-"}) · round ${snap.preview.round ?? 1}/${snap.preview.maxDecisionRounds ?? 8}`}
          </Text>
        ) : null}

        <View style={styles.row}>
          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() => {
              void openIntakeDecisionsDrawer((input) => callDecisions(input));
            }}
            testID="intake-decisions-open-btn"
          >
            <Text style={styles.btnText}>
              {isZh ? "打开拍板队列 (Ctrl+Cmd+D)" : "Open Decisions Queue (Ctrl+Cmd+D)"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={() => runExternalScan(true, "github")}
            testID="intake-external-dryrun-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "预演扫描 GitHub" : "Dry-Run GitHub Scan"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={() => runExternalScan(false, "github,email")}
            testID="intake-external-live-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "立即扫描邮件与 GitHub" : "Scan Email & GitHub Now"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={toggleExternalScan}
            testID="intake-external-toggle-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh
                ? externalEnabled
                  ? "暂停自动扫描"
                  : "开启自动扫描"
                : externalEnabled
                  ? "Pause Auto Scan"
                  : "Enable Auto Scan"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={previewTopItem}
            testID="intake-decisions-dryrun-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "预演首项续接" : "Dry-Run Top Item"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={refreshQueue}
            testID="intake-decisions-refresh-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "刷新对账" : "Refresh"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={toggleShortcut}
            testID="intake-decisions-shortcut-toggle"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh
                ? shortcutEnabled
                  ? "停用快捷键"
                  : "启用快捷键"
                : shortcutEnabled
                  ? "Disable Shortcut"
                  : "Enable Shortcut"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            disabled={busy}
            onPress={resetConfigDefaults}
            testID="intake-decisions-reset-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {isZh ? "恢复默认" : "Restore Defaults"}
            </Text>
          </Pressable>
        </View>
      </View>
    </SettingsSection>
  );
}
