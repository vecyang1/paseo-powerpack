import type { RpcInput } from "@getpaseo/plugin";
import { execCommand, type PluginHandlerContext } from "@getpaseo/plugin/server";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentHistoryTargetReceipt,
  BadTimelineEntry,
  CustomizeItem,
  FlatSubagentNode,
  PaseoRecoveryAgentItem,
  SessionLineageNode,
  SessionRelationKind,
  SlashDryRunResolution,
  SubagentAgentTree,
  SubagentTimelineItem,
  SubagentTimerOrTaskNode,
  WritebackReplayEvent,
  manageAgentHistoryRpc,
  manageHarnessCatalogsRpc,
  managePeerAgentsRpc,
  manageRelayHealthRpc,
  manageSessionLineageRpc,
  manageSlashSkillsRpc,
  manageSubagentsRpc,
  manageWritebackHookRpc,
  reconcilePaseoRecoveryRpc,
} from "../shared/contracts";
import { getRecentActionLogs } from "./handlers";
import { collectPeerPresence } from "./peer-presence";
import { nonSubagentRelation } from "../shared/sidebar-child-sessions";

const APP_SESSION_TS =
  "/Applications/Paseo.app/Contents/Resources/builtin-plugins/antigravity-provider/server/internal/session.ts";
const CLI_SESSION_TS =
  "/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/builtin-plugins/antigravity-provider/server/internal/session.ts";
const ANTIGRAVITY_OPS_BIN = path.join(os.homedir(), ".local", "bin", "antigravity-ops");
const WEBHOOK_HUB_BIN =
  process.env.WEBHOOK_HUB_BIN || path.join(os.homedir(), ".local", "bin", "webhook-hub");

interface RawWorkspaceRecord {
  workspaceId?: string;
  id?: string;
  name?: string;
  title?: string | null;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  background?: boolean;
  updatedAt?: string | null;
}

interface RawAgentRecord {
  id?: string;
  workspaceId?: string;
  provider?: string;
  title?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  persistence?: {
    sessionId?: string;
  };
  config?: {
    systemPrompt?: string;
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(targetPath: string): Promise<number> {
  try {
    const st = await fs.stat(targetPath);
    return st.size;
  } catch {
    return 0;
  }
}

function extractConversationId(record: RawAgentRecord): string | null {
  const sid = record.persistence?.sessionId ?? "";
  if (!sid.startsWith("plugin:")) return null;
  try {
    const parsed = JSON.parse(sid.slice("plugin:".length)) as {
      data?: { conversationId?: string };
    };
    const cid = parsed.data?.conversationId?.trim();
    return cid && /^[A-Za-z0-9-]+$/.test(cid) ? cid : null;
  } catch {
    return null;
  }
}

async function inspectSessionPatchFiles(): Promise<{
  ok: boolean;
  appPatched: boolean;
  cliPatched: boolean;
  configSummary: string;
  details: string;
}> {
  const checkFile = async (
    fpath: string,
  ): Promise<{ patched: boolean; compactExitGuard: boolean }> => {
    try {
      const content = await fs.readFile(fpath, "utf8");
      const patched =
        content.includes("vec-patch:session") &&
        content.includes("vecReplayHistory") &&
        content.includes("vecPrepareConversation") &&
        content.includes("vecReadTranscript") &&
        content.includes("vecGlobalSlashSkills") &&
        content.includes("vecFinalizeDriverPrompt");
      const compactExitGuard =
        content.includes("vecParseAgyError") && content.includes("vecConsumeSettledDriver");
      return { patched, compactExitGuard };
    } catch {
      return { patched: false, compactExitGuard: false };
    }
  };
  const [appRes, cliRes] = await Promise.all([
    checkFile(APP_SESSION_TS),
    checkFile(CLI_SESSION_TS),
  ]);
  const appPatched = appRes.patched;
  const cliPatched = cliRes.patched;
  const cfgPath = path.join(os.homedir(), ".config", "vec", "paseo-patches.json");
  let configSummary =
    "history_replay=on · settle_answered_errors=once · slash=on (inline+global+compact-guard)";
  try {
    const rawCfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
    configSummary = `history_replay=${String(rawCfg.history_replay ?? "on")} · settle=${String(
      rawCfg.settle_answered_errors ?? "on",
    )} · slash=${String(rawCfg.slash_commands ?? "on")} (global+inline+compact-guard) · max=${String(
      rawCfg.max_replay_messages ?? 400,
    )}`;
  } catch {
    // Use default summary
  }
  const ok = appPatched && cliPatched;
  const fmtCopy = (res: { patched: boolean; compactExitGuard: boolean }) =>
    res.patched
      ? `PATCHED (v2+vault+slash-skills${res.compactExitGuard ? "+compact-exit-guard" : ""})`
      : "UNPATCHED";
  return {
    ok,
    appPatched,
    cliPatched,
    configSummary,
    details: `App=${fmtCopy(appRes)} · CLI=${fmtCopy(cliRes)}`,
  };
}

export async function handleManageAgentHistory(
  input: RpcInput<typeof manageAgentHistoryRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "inspect";
  const home = os.homedir();
  const paseoDir = path.join(home, ".paseo");
  const cliBase = path.join(home, ".gemini", "antigravity-cli");
  const actionsTaken: string[] = [];

  // 1. Read active workspaces from ~/.paseo/projects/workspaces.json
  const workspacesPath = path.join(paseoDir, "projects", "workspaces.json");
  const activeWsMap = new Map<string, RawWorkspaceRecord>();
  try {
    const parsed = JSON.parse(await fs.readFile(workspacesPath, "utf8")) as unknown;
    const items: RawWorkspaceRecord[] = Array.isArray(parsed)
      ? (parsed as RawWorkspaceRecord[])
      : Array.isArray((parsed as { workspaces?: unknown })?.workspaces)
        ? ((parsed as { workspaces: RawWorkspaceRecord[] }).workspaces ?? [])
        : [];
    for (const w of items) {
      const wsId = (w.workspaceId ?? w.id ?? "").trim();
      if (!wsId) continue;
      if ((!w.archivedAt || w.pinnedAt) && !w.background) {
        activeWsMap.set(wsId, w);
      }
    }
  } catch {
    // Ignore unreadable workspaces.json
  }

  // 2. Scan ~/.paseo/agents/*/*.json for antigravity agents
  const agentsRoot = path.join(paseoDir, "agents");
  const agentRecords: { record: RawAgentRecord; cid: string; filePath: string }[] = [];
  try {
    const buckets = await fs.readdir(agentsRoot, { withFileTypes: true });
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const bPath = path.join(agentsRoot, bucket.name);
      const files = await fs.readdir(bPath);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const fullPath = path.join(bPath, f);
        try {
          const rec = JSON.parse(await fs.readFile(fullPath, "utf8")) as RawAgentRecord;
          if (rec.provider !== "antigravity") continue;
          const sysPrompt = rec.config?.systemPrompt ?? "";
          if (sysPrompt.includes("Generates a short title for a coding workspace")) continue;
          const cid = extractConversationId(rec);
          if (!cid) continue;
          agentRecords.push({ record: rec, cid, filePath: fullPath });
        } catch {
          // Ignore malformed agent json
        }
      }
    }
  } catch {
    // Ignore missing agents directory
  }

  // Sort by updatedAt descending
  agentRecords.sort((a, b) => {
    const ta = Date.parse(a.record.updatedAt ?? a.record.lastActivityAt ?? "") || 0;
    const tb = Date.parse(b.record.updatedAt ?? b.record.lastActivityAt ?? "") || 0;
    return tb - ta;
  });

  // 3. Compute Vault Stats across active workspace agents
  let antigravityAgentsCount = 0;
  let healthyConversationsCount = 0;
  let missingDbCount = 0;
  let missingTranscriptCount = 0;
  let shelvedTranscriptCount = 0;
  const missingCids: string[] = [];

  for (const item of agentRecords) {
    const wsId = item.record.workspaceId ?? "";
    if (!activeWsMap.has(wsId)) continue;
    antigravityAgentsCount += 1;
    const cid = item.cid;
    const dbPath = path.join(cliBase, "conversations", `${cid}.db`);
    const brainTp = path.join(
      cliBase,
      "brain",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const shelfTp = path.join(
      cliBase,
      "conversation_vault",
      "transcript_shelf",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    let [hasDb, hasBrainTp, hasShelfTp] = await Promise.all([
      fileExists(dbPath),
      fileExists(brainTp),
      fileExists(shelfTp),
    ]);
    if (!hasDb) {
      const localVaultCandidates = [
        path.join(
          cliBase,
          "conversation_vault",
          "pinned_conversations",
          "conversations",
          `${cid}.db`,
        ),
        path.join(cliBase, "conversation_vault", "conversations", `${cid}.db`),
        path.join(home, ".gemini", "antigravity", "conversations", `${cid}.db`),
      ];
      for (const cand of localVaultCandidates) {
        if (await fileExists(cand)) {
          try {
            await fs.mkdir(path.dirname(dbPath), { recursive: true });
            await fs.copyFile(cand, dbPath);
            hasDb = true;
            actionsTaken.push(`Auto-restored ${cid.slice(0, 8)}.db from local vault armor`);
          } catch {
            // Ignore
          }
          break;
        }
      }
    }
    if (!hasBrainTp && !hasShelfTp && hasDb) {
      try {
        await fs.mkdir(path.dirname(brainTp), { recursive: true });
        const seedTitle = (item.record.title ?? "").trim();
        const seedLine = seedTitle
          ? `${JSON.stringify({
              step_index: 0,
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              created_at: item.record.updatedAt ?? new Date().toISOString(),
              content: seedTitle,
            })}\n`
          : "";
        await fs.writeFile(brainTp, seedLine, "utf8");
        hasBrainTp = true;
        actionsTaken.push(`Auto-seeded transcript.jsonl armor for ${cid.slice(0, 8)}`);
      } catch {
        // Ignore
      }
    }
    if (hasShelfTp) shelvedTranscriptCount += 1;
    if (!hasDb) {
      missingDbCount += 1;
      missingCids.push(cid);
    }
    if (!hasBrainTp && !hasShelfTp) {
      missingTranscriptCount += 1;
    }
    if (hasDb && (hasBrainTp || hasShelfTp)) {
      healthyConversationsCount += 1;
    }
  }

  // 4. Resolve target agent for inspection / probe / heal
  const qWs = (input.workspaceId ?? "").trim();
  const qAgent = (input.agentId ?? "").trim();
  const qCid = (input.conversationId ?? "").trim();

  let matched =
    agentRecords.find(
      (x) =>
        (qCid && x.cid === qCid) ||
        (qAgent && (x.record.id === qAgent || (x.record.id ?? "").startsWith(qAgent))) ||
        (qWs &&
          (x.record.workspaceId === qWs ||
            (activeWsMap.get(x.record.workspaceId ?? "")?.name ?? "")
              .toLowerCase()
              .includes(qWs.toLowerCase()))),
    ) ??
    agentRecords.find((x) => activeWsMap.has(x.record.workspaceId ?? "")) ??
    agentRecords[0] ??
    null;

  // 5. If action === "heal", execute self-healing across local vault, GDrive restore, and antigravity-ops doctor --fix
  if (action === "heal") {
    const cidsToHeal = new Set<string>(missingCids);
    if (matched?.cid) cidsToHeal.add(matched.cid);
    if (qCid && /^[A-Za-z0-9-]+$/.test(qCid)) cidsToHeal.add(qCid);

    for (const cid of cidsToHeal) {
      const targetDb = path.join(cliBase, "conversations", `${cid}.db`);
      if (!(await fileExists(targetDb))) {
        const localCandidates = [
          path.join(
            cliBase,
            "conversation_vault",
            "pinned_conversations",
            "conversations",
            `${cid}.db`,
          ),
          path.join(cliBase, "conversation_vault", "conversations", `${cid}.db`),
          path.join(home, ".gemini", "antigravity", "conversations", `${cid}.db`),
        ];
        let copied = false;
        for (const cand of localCandidates) {
          if (await fileExists(cand)) {
            await fs.mkdir(path.dirname(targetDb), { recursive: true });
            await fs.copyFile(cand, targetDb);
            actionsTaken.push(`Restored ${cid.slice(0, 8)}.db from local vault armor`);
            copied = true;
            break;
          }
        }
        if (!copied && (await fileExists(WEBHOOK_HUB_BIN))) {
          try {
            await execCommand(
              WEBHOOK_HUB_BIN,
              ["antigravity", "restore", cid, "--root", "cli"],
              { timeout: 45_000 },
            );
            if (await fileExists(targetDb)) {
              actionsTaken.push(`Restored ${cid.slice(0, 8)}.db from Google Drive vault`);
            }
          } catch {
            // Continue
          }
        }
      }

      // Ensure transcript_shelf copy is also mirrored into brain/<cid>/.system_generated/logs/
      const brainLogs = path.join(cliBase, "brain", cid, ".system_generated", "logs");
      const shelfLogs = path.join(
        cliBase,
        "conversation_vault",
        "transcript_shelf",
        cid,
        ".system_generated",
        "logs",
      );
      if (
        !(await fileExists(path.join(brainLogs, "transcript.jsonl"))) &&
        (await fileExists(path.join(shelfLogs, "transcript.jsonl")))
      ) {
        await fs.mkdir(brainLogs, { recursive: true });
        await fs.copyFile(
          path.join(shelfLogs, "transcript.jsonl"),
          path.join(brainLogs, "transcript.jsonl"),
        );
        if (await fileExists(path.join(shelfLogs, "transcript_full.jsonl"))) {
          await fs.copyFile(
            path.join(shelfLogs, "transcript_full.jsonl"),
            path.join(brainLogs, "transcript_full.jsonl"),
          );
        }
        actionsTaken.push(`Synced shelved transcript.jsonl for ${cid.slice(0, 8)}`);
      }
    }

    // Run antigravity-ops red-dot --apply & doctor --fix (with VEC_PASEO_NO_RESTART=1)
    if (await fileExists(ANTIGRAVITY_OPS_BIN)) {
      try {
        await execCommand(ANTIGRAVITY_OPS_BIN, ["red-dot", "--apply"], {
          timeout: 25_000,
          env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
        });
        actionsTaken.push("Settled stale answered-turn error dots (red-dot --apply)");
      } catch {
        // Ignore
      }
      try {
        await execCommand(ANTIGRAVITY_OPS_BIN, ["slash", "sync", "--json"], {
          timeout: 30_000,
          env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
        });
        actionsTaken.push(
          "Synced global/workspace slash skills, synced/*/* symlinks & inline /skill expansion (slash sync)",
        );
      } catch {
        // Ignore
      }
      try {
        await execCommand(ANTIGRAVITY_OPS_BIN, ["doctor", "--fix"], {
          timeout: 45_000,
          env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
        });
        actionsTaken.push(
          "Verified & applied Paseo session.ts history replay + vault resume guards (doctor --fix)",
        );
      } catch {
        // Ignore
      }
    }
  }

  let slashProbeDetail = "";
  if (qWs.includes("/") && (await fileExists(ANTIGRAVITY_OPS_BIN))) {
    try {
      const slashRes = await execCommand(
        ANTIGRAVITY_OPS_BIN,
        ["slash", "test", qWs, "--json"],
        { timeout: 15_000, env: { ...process.env, VEC_PASEO_NO_RESTART: "1" } },
      );
      const parsedSlash = JSON.parse(slashRes.stdout || "{}") as {
        summary?: { total_advertised?: number; inline_autocomplete_count?: number };
        dry_run?: { detected_tokens?: string[]; expanded_count?: number; total_injected_chars?: number };
      };
      const adv = parsedSlash.summary?.total_advertised ?? 0;
      const inl = parsedSlash.summary?.inline_autocomplete_count ?? 0;
      const toks = (parsedSlash.dry_run?.detected_tokens ?? []).join(", ");
      const exp = parsedSlash.dry_run?.expanded_count ?? 0;
      const chars = parsedSlash.dry_run?.total_injected_chars ?? 0;
      slashProbeDetail = ` · slashProbe=[${toks} -> ${exp} expanded (${chars} chars) | catalog=${adv} (${inl} inline)]`;
      actionsTaken.push(
        `Slash Skill Dry-Run: ${toks || "(none)"} -> ${exp} expanded (${chars} chars injected, ${adv} skills in catalog)`,
      );
    } catch {
      // Ignore
    }
  }

  // Re-evaluate session patches & target agent after potential heal
  const sessionPatches = await inspectSessionPatchFiles();
  let targetReceipt: AgentHistoryTargetReceipt | null = null;
  if (matched) {
    const cid = matched.cid;
    const wsId = matched.record.workspaceId ?? null;
    const wsObj = wsId ? activeWsMap.get(wsId) : undefined;
    const dbPath = path.join(cliBase, "conversations", `${cid}.db`);
    const brainTp = path.join(
      cliBase,
      "brain",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const shelfTp = path.join(
      cliBase,
      "conversation_vault",
      "transcript_shelf",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const [dbExists, dbBytes, brainTranscriptExists, shelfTranscriptExists] =
      await Promise.all([
        fileExists(dbPath),
        fileSize(dbPath),
        fileExists(brainTp),
        fileExists(shelfTp),
      ]);
    let transcriptLines = 0;
    const tpToRead = brainTranscriptExists ? brainTp : shelfTranscriptExists ? shelfTp : null;
    if (tpToRead) {
      try {
        const rawTp = await fs.readFile(tpToRead, "utf8");
        transcriptLines = rawTp.split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        transcriptLines = 0;
      }
    }
    const healable = !dbExists || !brainTranscriptExists || !sessionPatches.ok;
    targetReceipt = {
      workspaceId: wsId,
      workspaceName: (wsObj?.title ?? wsObj?.name ?? matched.record.title ?? null) as
        | string
        | null,
      agentId: matched.record.id ?? null,
      conversationId: cid,
      status: matched.record.lastStatus ?? "idle",
      lastError: matched.record.lastError ?? null,
      dbExists,
      dbSizeFormatted: formatBytes(dbBytes),
      brainTranscriptExists,
      shelfTranscriptExists,
      transcriptLines,
      healable,
      healed: action === "heal" && dbExists && (brainTranscriptExists || shelfTranscriptExists),
      detail: `db=${dbExists ? formatBytes(dbBytes) : "MISSING"} · brain_tp=${
        brainTranscriptExists ? "OK" : "MISSING"
      } · shelf_tp=${shelfTranscriptExists ? "OK" : "MISSING"} · lines=${transcriptLines}${slashProbeDetail}`,
    };
  }

  const durationMs = Date.now() - startMs;
  const ok =
    sessionPatches.ok &&
    (targetReceipt
      ? targetReceipt.dbExists &&
        (targetReceipt.brainTranscriptExists || targetReceipt.shelfTranscriptExists)
      : missingDbCount === 0);

  const message =
    action === "heal"
      ? `Self-healed Agent History (${actionsTaken.length} actions) · Patches=${sessionPatches.details}`
      : `Agent History Reconciler: ${healthyConversationsCount}/${antigravityAgentsCount} active workspaces healthy · ${sessionPatches.details}`;

  return {
    ok,
    action,
    sessionPatches,
    vaultStats: {
      activeWorkspacesCount: activeWsMap.size,
      antigravityAgentsCount,
      healthyConversationsCount,
      missingDbCount,
      missingTranscriptCount,
      shelvedTranscriptCount,
    },
    targetAgent: targetReceipt,
    actionsTaken,
    message,
    durationMs,
    recentActions: getRecentActionLogs().slice(0, 8),
  };
}

function normalizePaseoRecoveryAgentItem(raw: unknown): PaseoRecoveryAgentItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const agentId = typeof r.agentId === "string" ? r.agentId : "";
  if (!agentId) return null;
  const qcRaw =
    r.quotaCooldown && typeof r.quotaCooldown === "object"
      ? (r.quotaCooldown as Record<string, unknown>)
      : null;
  return {
    agentId,
    provider: typeof r.provider === "string" ? r.provider : "antigravity",
    workspaceId: typeof r.workspaceId === "string" ? r.workspaceId : null,
    title: typeof r.title === "string" ? r.title : "(untitled)",
    cwd: typeof r.cwd === "string" ? r.cwd : null,
    status: typeof r.status === "string" ? r.status : "unknown",
    persistedStatus: typeof r.persistedStatus === "string" ? r.persistedStatus : null,
    conversationId: typeof r.conversationId === "string" ? r.conversationId : "",
    turnState: typeof r.turnState === "string" ? r.turnState : null,
    epochs: typeof r.epochs === "number" && Number.isFinite(r.epochs) ? r.epochs : 1,
    totalSteps: typeof r.totalSteps === "number" && Number.isFinite(r.totalSteps) ? r.totalSteps : 0,
    lastStepIndex:
      typeof r.lastStepIndex === "number" && Number.isFinite(r.lastStepIndex) ? r.lastStepIndex : 0,
    lastStepType: typeof r.lastStepType === "string" ? r.lastStepType : String(r.turnState ?? ""),
    shellCallsInTurn:
      typeof r.shellCallsInTurn === "number" && Number.isFinite(r.shellCallsInTurn)
        ? r.shellCallsInTurn
        : 0,
    otherToolCallsInTurn:
      typeof r.otherToolCallsInTurn === "number" && Number.isFinite(r.otherToolCallsInTurn)
        ? r.otherToolCallsInTurn
        : 0,
    toolSummary: typeof r.toolSummary === "string" ? r.toolSummary : "",
    wasStartupRecoveryFailed: Boolean(r.wasStartupRecoveryFailed),
    lastErrorText: typeof r.lastErrorText === "string" ? r.lastErrorText : null,
    ageHours: typeof r.ageHours === "number" && Number.isFinite(r.ageHours) ? r.ageHours : 0,
    classification: typeof r.classification === "string" ? r.classification : "UNKNOWN",
    needsPullUp: Boolean(r.needsPullUp),
    reason: typeof r.reason === "string" ? r.reason : "",
    attemptsAtCurrentStep:
      typeof r.attemptsAtCurrentStep === "number" && Number.isFinite(r.attemptsAtCurrentStep)
        ? r.attemptsAtCurrentStep
        : 0,
    healed: Boolean(r.healed),
    healError: typeof r.healError === "string" ? r.healError : null,
    quotaCooldown: qcRaw
      ? {
          waitSecs: typeof qcRaw.waitSecs === "number" && Number.isFinite(qcRaw.waitSecs) ? qcRaw.waitSecs : null,
          remainingSecs:
            typeof qcRaw.remainingSecs === "number" && Number.isFinite(qcRaw.remainingSecs)
              ? qcRaw.remainingSecs
              : null,
          resumeAt: typeof qcRaw.resumeAt === "string" ? qcRaw.resumeAt : null,
          deferred: Boolean(qcRaw.deferred),
        }
      : null,
  };
}

export async function handleManageRelayHealth(
  input: RpcInput<typeof manageRelayHealthRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  const args = ["relay", action, "--json"];
  try {
    let stdoutText = "";
    try {
      const res = await execCommand(ANTIGRAVITY_OPS_BIN, args, {
        timeout: action === "probe" ? 30_000 : 20_000,
        env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
      });
      stdoutText = res.stdout || "";
    } catch (execErr) {
      const maybeStdout = (execErr as { stdout?: string })?.stdout ?? "";
      if (maybeStdout.trim().startsWith("{")) {
        stdoutText = maybeStdout;
      } else {
        throw execErr;
      }
    }
    const parsed = JSON.parse(stdoutText || "{}") as Record<string, unknown>;
    const durationMs = Date.now() - startMs;
    const badTimelines: BadTimelineEntry[] = Array.isArray(parsed.badTimelines)
      ? parsed.badTimelines
          .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
          .map((x) => ({
            id: String(x.id ?? ""),
            status: String(x.status ?? "unknown"),
            provider: String(x.provider ?? "unknown"),
            title: String(x.title ?? ""),
            error: String(x.error ?? ""),
          }))
      : [];
    return {
      ok: Boolean(parsed.ok),
      action,
      relayOk: Boolean(parsed.relayOk ?? true),
      relayEnabled: Boolean(parsed.relayEnabled ?? true),
      controlState: String(parsed.controlState ?? "unknown"),
      clashRoute: String(parsed.clashRoute ?? "unverified"),
      lastMobileClientId:
        typeof parsed.lastMobileClientId === "string" ? parsed.lastMobileClientId : null,
      lastMobileHelloAt:
        typeof parsed.lastMobileHelloAt === "string" ? parsed.lastMobileHelloAt : null,
      recentRelayErrors15m: Number(parsed.recentRelayErrors15m ?? 0),
      recentLeaseDrops15m: Number(parsed.recentLeaseDrops15m ?? 0),
      checkedTimelines: Number(parsed.checkedTimelines ?? 0),
      badTimelines,
      e2eeOk: typeof parsed.e2eeOk === "boolean" ? parsed.e2eeOk : null,
      e2eeConnectMs: typeof parsed.e2eeConnectMs === "number" ? parsed.e2eeConnectMs : null,
      e2eeStatusMs: typeof parsed.e2eeStatusMs === "number" ? parsed.e2eeStatusMs : null,
      e2eeError: typeof parsed.e2eeError === "string" ? parsed.e2eeError : null,
      actions: Array.isArray(parsed.actions) ? parsed.actions.map(String) : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      details: String(parsed.details ?? ""),
      message: String(parsed.message ?? parsed.details ?? ""),
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      relayOk: false,
      relayEnabled: true,
      controlState: "error",
      clashRoute: "unverified",
      lastMobileClientId: null,
      lastMobileHelloAt: null,
      recentRelayErrors15m: 0,
      recentLeaseDrops15m: 0,
      checkedTimelines: 0,
      badTimelines: [] as BadTimelineEntry[],
      e2eeOk: null,
      e2eeConnectMs: null,
      e2eeStatusMs: null,
      e2eeError: errMsg,
      actions: [] as string[],
      issues: [errMsg],
      details: errMsg,
      message: errMsg,
      durationMs,
    };
  }
}

export async function handleManageHarnessCatalogs(
  input: RpcInput<typeof manageHarnessCatalogsRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  const args = ["catalog", action, "--json"];
  try {
    let stdoutText = "";
    try {
      const res = await execCommand(ANTIGRAVITY_OPS_BIN, args, {
        timeout: 35_000,
        env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
      });
      stdoutText = res.stdout || "";
    } catch (execErr) {
      const maybeStdout = (execErr as { stdout?: string })?.stdout ?? "";
      if (maybeStdout.trim().startsWith("{")) {
        stdoutText = maybeStdout;
      } else {
        throw execErr;
      }
    }
    const parsed = JSON.parse(stdoutText || "{}") as Record<string, unknown>;
    const agObj = (parsed.antigravity ?? {}) as Record<string, unknown>;
    const harnessesMap = (parsed.harnesses ?? {}) as Record<string, Record<string, unknown>>;
    const harnesses = Object.entries(harnessesMap).map(([prov, hv]) => ({
      provider: prov,
      paseoModelCount: Number(hv?.paseo_model_count ?? 0),
      upstreamCount: typeof hv?.upstream_count === "number" ? hv.upstream_count : null,
      inSync: Boolean(hv?.in_sync),
      topModels: Array.isArray(hv?.paseo_top_models) ? hv.paseo_top_models.map(String) : [],
      missingInPaseo: Array.isArray(hv?.missing_in_paseo) ? hv.missing_in_paseo.map(String) : [],
    }));
    const actions = Array.isArray(parsed.actions) ? parsed.actions.map(String) : [];
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
    const agModels = Array.isArray(agObj.models) ? agObj.models.length : 0;
    const nativeIds = Array.isArray(agObj.native_ids) ? agObj.native_ids.length : 0;
    const bridgeIds = Array.isArray(agObj.non_native_ids) ? agObj.non_native_ids.length : 0;
    const ok = Boolean(parsed.ok);
    const durationMs = Date.now() - startMs;
    const summaryMsg =
      actions[0] ||
      issues[0] ||
      (ok
        ? `Catalog synced (${harnesses.length} providers, ${agModels} Antigravity models)`
        : "Catalog drift detected");
    return {
      ok,
      action,
      catalogSignature: String(parsed.catalog_signature ?? ""),
      syncedAt: String(parsed.synced_at ?? new Date().toISOString()),
      antigravityTotal: agModels,
      nativeEffortCount: nativeIds,
      bridgeCount: bridgeIds,
      harnesses,
      actions,
      issues,
      message: summaryMsg,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      catalogSignature: "",
      syncedAt: new Date().toISOString(),
      antigravityTotal: 0,
      nativeEffortCount: 0,
      bridgeCount: 0,
      harnesses: [],
      actions: [] as string[],
      issues: [errMsg],
      message: errMsg,
      durationMs,
    };
  }
}

export async function handleReconcilePaseoRecovery(
  input: RpcInput<typeof reconcilePaseoRecoveryRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  const args = ["paseo-recovery", action, "--json"];
  if (input.agentId && input.agentId.trim()) {
    args.push("--agent", input.agentId.trim());
  }
  if (typeof input.maxAgeHours === "number" && Number.isFinite(input.maxAgeHours)) {
    args.push("--max-age-hours", String(input.maxAgeHours));
  }
  if (input.prompt && input.prompt.trim()) {
    args.push("--prompt", input.prompt.trim());
  }

  try {
    let stdoutText = "";
    try {
      const res = await execCommand(ANTIGRAVITY_OPS_BIN, args, {
        timeout: 45_000,
        env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
      });
      stdoutText = res.stdout || "";
    } catch (execErr) {
      const maybeStdout = (execErr as { stdout?: string })?.stdout ?? "";
      if (maybeStdout.trim().startsWith("{")) {
        stdoutText = maybeStdout;
      } else {
        throw execErr;
      }
    }
    const parsed = JSON.parse(stdoutText || "{}") as Record<string, unknown>;
    const durationMs = Date.now() - startMs;
    const ok = Boolean(parsed.ok);
    const interruptedCount = Number(parsed.interruptedCount ?? 0);
    const healedCount = Number(parsed.healedCount ?? 0);
    const totalScanned = Number(parsed.totalScanned ?? 0);
    const message =
      action === "heal"
        ? `Auto-pulled up ${healedCount}/${interruptedCount} interrupted Paseo agent(s) (${totalScanned} scanned)`
        : action === "reset"
          ? `Reset Paseo auto-pull-up circuit breaker (${totalScanned} active agents scanned)`
          : `Startup Recovery Reconciler: ${interruptedCount} interrupted · ${healedCount} healed · ${totalScanned} scanned`;

    return {
      ok,
      action,
      resumeOnStartup: Boolean(parsed.resumeOnStartup ?? true),
      versionCacheOk: Boolean(parsed.versionCacheOk ?? true),
      catalogSingleflightOk: Boolean(parsed.catalogSingleflightOk ?? true),
      proxyHealthy: Boolean(parsed.proxyHealthy ?? true),
      daemonRunning: Boolean(parsed.daemonRunning ?? true),
      daemonStartupFailedCount: Number(parsed.daemonStartupFailedCount ?? 0),
      interruptedCount,
      healedCount,
      unhealedCount: Number(parsed.unhealedCount ?? 0),
      circuitBreakerCount: Number(parsed.circuitBreakerCount ?? 0),
      totalScanned,
      agents: Array.isArray(parsed.agents)
        ? parsed.agents
            .slice(0, 20)
            .map(normalizePaseoRecoveryAgentItem)
            .filter((x): x is PaseoRecoveryAgentItem => x !== null)
        : [],
      interruptedAgents: Array.isArray(parsed.interruptedAgents)
        ? parsed.interruptedAgents
            .map(normalizePaseoRecoveryAgentItem)
            .filter((x): x is PaseoRecoveryAgentItem => x !== null)
        : [],
      healedAgents: Array.isArray(parsed.healedAgents)
        ? parsed.healedAgents
            .map(normalizePaseoRecoveryAgentItem)
            .filter((x): x is PaseoRecoveryAgentItem => x !== null)
        : [],
      actions: Array.isArray(parsed.actions) ? (parsed.actions as string[]) : [],
      issues: Array.isArray(parsed.issues) ? (parsed.issues as string[]) : [],
      message,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      resumeOnStartup: true,
      versionCacheOk: true,
      catalogSingleflightOk: true,
      proxyHealthy: false,
      daemonRunning: false,
      daemonStartupFailedCount: 0,
      interruptedCount: 0,
      healedCount: 0,
      unhealedCount: 0,
      circuitBreakerCount: 0,
      totalScanned: 0,
      agents: [] as PaseoRecoveryAgentItem[],
      interruptedAgents: [] as PaseoRecoveryAgentItem[],
      healedAgents: [] as PaseoRecoveryAgentItem[],
      actions: [] as string[],
      issues: [errMsg],
      message: `Paseo recovery reconciler failed: ${errMsg}`,
      durationMs,
    };
  }
}

export async function handleManageSlashSkills(
  input: RpcInput<typeof manageSlashSkillsRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  const args = ["slash", action, "--json"];
  if (input.samplePrompt && input.samplePrompt.trim()) {
    args.push(input.samplePrompt.trim());
  }
  if (input.slug && input.slug.trim()) {
    args.push("--slug", input.slug.trim());
  }
  if (input.category && input.category !== "all") {
    args.push("--category", input.category);
  }
  if (input.scope && input.scope !== "all") {
    args.push("--scope", input.scope);
  }
  if (input.query && input.query.trim()) {
    args.push("--query", input.query.trim());
  }
  if (input.cwd && input.cwd.trim()) {
    args.push("--cwd", input.cwd.trim());
  }
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    args.push("--limit", String(Math.min(1000, Math.max(1, Math.floor(input.limit)))));
  } else {
    args.push("--limit", "150");
  }

  try {
    const res = await execCommand(ANTIGRAVITY_OPS_BIN, args, {
      timeout: 35_000,
      env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
    });
    const parsed = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
    const summary = (parsed.summary ?? {}) as Record<string, unknown>;
    const synced = (parsed.synced_skills ?? {}) as Record<string, unknown>;
    const counts = (parsed.customize_counts ?? {}) as Record<string, unknown>;
    const dryRun = (parsed.dry_run ?? {}) as Record<string, unknown>;
    const actions = Array.isArray(parsed.actions) ? (parsed.actions as string[]) : [];
    const totalAdvertised = Number(summary.total_advertised ?? 0);
    const inlineCount = Number(summary.inline_autocomplete_count ?? 0);
    const pinnedCount = Number(summary.pinned_count ?? 0);
    const durationMs = Date.now() - startMs;

    const message =
      actions.length > 0
        ? `Customize: ${actions.join(" · ")} (${totalAdvertised} active · ${pinnedCount} pinned)`
        : `Customize Inventory: ${totalAdvertised} slash commands & skills active (${inlineCount} inline /skill ready · ${pinnedCount} pinned)`;

    const clientBridge = (parsed.client_bridge ?? {}) as Record<string, unknown>;
    return {
      ok:
        Boolean(parsed.ok) ||
        (totalAdvertised > 0 && Boolean(clientBridge.ok ?? true)),
      action,
      slashCommandsMode: String(parsed.slash_commands_mode ?? "on"),
      configSource: String(parsed.config_source ?? "defaults"),
      pinnedSlashCommands: Array.isArray(parsed.pinned_slash_commands)
        ? (parsed.pinned_slash_commands as string[])
        : [],
      disabledSlashCommands: Array.isArray(parsed.disabled_slash_commands)
        ? (parsed.disabled_slash_commands as string[])
        : [],
      totalAdvertised,
      builtinCount: Number(summary.builtin_count ?? 12),
      skillCount: Number(summary.skill_count ?? 0),
      inlineAutocompleteCount: inlineCount,
      pinnedCount,
      disabledCount: Number(summary.disabled_count ?? 0),
      syncedSkillsCount: Number(synced.count ?? 0),
      syncedSkillsAllLinked: Boolean(synced.all_linked ?? true),
      customizeCounts: {
        all: Number(counts.all ?? 0),
        commands: Number(counts.commands ?? 0),
        skills: Number(counts.skills ?? 0),
        rules: Number(counts.rules ?? 0),
        subagents: Number(counts.subagents ?? 0),
        mcps: Number(counts.mcps ?? 0),
        plugins: Number(counts.plugins ?? 0),
        pinned: Number(counts.pinned ?? 0),
        disabled: Number(counts.disabled ?? 0),
        workspace: Number(counts.workspace ?? 0),
      },
      customizeItems: Array.isArray(parsed.customize_items)
        ? (parsed.customize_items.map((raw) => {
            const r = (raw ?? {}) as Record<string, unknown>;
            return {
              name: String(r.name ?? ""),
              category: String(r.category ?? "skills"),
              kind: String(r.kind ?? "skill"),
              scope: String(r.scope ?? "user"),
              source: String(r.source ?? "global"),
              path: typeof r.path === "string" ? r.path : null,
              description: String(r.description ?? ""),
              pinned: Boolean(r.pinned),
              enabled: Boolean(r.enabled ?? true),
              inline_autocomplete: Boolean(r.inline_autocomplete),
            };
          }) as CustomizeItem[])
        : [],
      dryRun: {
        samplePrompt: String(dryRun.sample_prompt ?? ""),
        detectedTokens: Array.isArray(dryRun.detected_tokens)
          ? (dryRun.detected_tokens as string[])
          : [],
        expandedCount: Number(dryRun.expanded_count ?? 0),
        totalInjectedChars: Number(dryRun.total_injected_chars ?? 0),
        budgetCapChars: Number(dryRun.budget_cap_chars ?? 48000),
        perSkillBudgetChars: Number(dryRun.per_skill_budget_chars ?? 6000),
        resolutions: Array.isArray(dryRun.resolutions)
          ? (dryRun.resolutions.map((raw) => {
              const r = (raw ?? {}) as Record<string, unknown>;
              return {
                token: String(r.token ?? ""),
                slug: String(r.slug ?? ""),
                status: String(r.status ?? ""),
                mode: String(r.mode ?? ""),
                path: typeof r.path === "string" ? r.path : null,
                injected_chars: Number(r.injected_chars ?? 0),
              };
            }) as SlashDryRunResolution[])
          : [],
      },
      actions,
      message,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      slashCommandsMode: "on",
      configSource: "error",
      pinnedSlashCommands: [],
      disabledSlashCommands: [],
      totalAdvertised: 0,
      builtinCount: 0,
      skillCount: 0,
      inlineAutocompleteCount: 0,
      pinnedCount: 0,
      disabledCount: 0,
      syncedSkillsCount: 0,
      syncedSkillsAllLinked: false,
      customizeCounts: {
        all: 0,
        commands: 0,
        skills: 0,
        rules: 0,
        subagents: 0,
        mcps: 0,
        plugins: 0,
        pinned: 0,
        disabled: 0,
        workspace: 0,
      },
      customizeItems: [],
      dryRun: {
        samplePrompt: "",
        detectedTokens: [],
        expandedCount: 0,
        totalInjectedChars: 0,
        budgetCapChars: 48000,
        perSkillBudgetChars: 6000,
        resolutions: [],
      },
      actions: [],
      message: `Customize reconciler error: ${errMsg}`,
      durationMs,
    };
  }
}

export async function handleManageWritebackHook(
  input: RpcInput<typeof manageWritebackHookRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";

  try {
    let statusRaw: Record<string, unknown> = {};
    let replayData: {
      conversationId: string;
      totalStopPoints: number;
      legacyV1BlockCount: number;
      v2BlockCount: number;
      falseBlocksEliminated: number;
      events: WritebackReplayEvent[];
    } | null = null;

    if (action === "tune") {
      const tuneArgs = ["writeback-hook", "tune", "--json"];
      if (typeof input.enabled === "boolean") {
        tuneArgs.push("--enabled", String(input.enabled));
      }
      if (typeof input.maxBlocksPerTurn === "number") {
        tuneArgs.push("--max-blocks-per-turn", String(input.maxBlocksPerTurn));
      }
      if (typeof input.requireFullyIdle === "boolean") {
        tuneArgs.push("--require-fully-idle", String(input.requireFullyIdle));
      }
      if (typeof input.transcriptTailFallback === "boolean") {
        tuneArgs.push("--transcript-tail-fallback", String(input.transcriptTailFallback));
      }
      const res = await execCommand(ANTIGRAVITY_OPS_BIN, tuneArgs, { timeout: 15_000 });
      statusRaw = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
    } else if (action === "reset") {
      const resetArgs = ["writeback-hook", "reset", "--json"];
      if (input.clearMarkers !== false) {
        resetArgs.push("--clear-markers");
      }
      if (input.clearAudit) {
        resetArgs.push("--clear-audit");
      }
      const res = await execCommand(ANTIGRAVITY_OPS_BIN, resetArgs, { timeout: 15_000 });
      statusRaw = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
    } else {
      const res = await execCommand(
        ANTIGRAVITY_OPS_BIN,
        ["writeback-hook", "status", "--json", "--limit", "30"],
        { timeout: 15_000 },
      );
      statusRaw = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
    }

    if (action === "simulate" || (input.conversationId && input.conversationId.trim())) {
      const cid = (input.conversationId || "4886f126-34b5-4dea-b6dd-01685971fb77").trim();
      const simRes = await execCommand(
        ANTIGRAVITY_OPS_BIN,
        [
          "writeback-hook",
          "simulate",
          "--conversation-id",
          cid,
          "--replay-transcript",
          "--json",
        ],
        { timeout: 20_000 },
      );
      const simParsed = JSON.parse(simRes.stdout || "{}") as Record<string, unknown>;
      if (simParsed.mode === "replay_transcript") {
        const rawEvents = Array.isArray(simParsed.events) ? simParsed.events : [];
        replayData = {
          conversationId: String(simParsed.conversation_id ?? cid),
          totalStopPoints: Number(simParsed.total_stop_points ?? rawEvents.length),
          legacyV1BlockCount: Number(simParsed.legacy_v1_block_count ?? 0),
          v2BlockCount: Number(simParsed.v2_block_count ?? 0),
          falseBlocksEliminated: Number(simParsed.false_blocks_eliminated ?? 0),
          events: rawEvents.map((ev) => {
            const r = (ev ?? {}) as Record<string, unknown>;
            return {
              line: Number(r.line ?? 0),
              stepIndex: typeof r.step_index === "number" ? r.step_index : null,
              fullyIdle: Boolean(r.fully_idle ?? true),
              executionNum: Number(r.execution_num ?? 1),
              hasWritebackLine: Boolean(r.has_writeback_line ?? false),
              recordedHookBlockedInTranscript: Boolean(
                r.recorded_hook_blocked_in_transcript ?? false,
              ),
              legacyV1Decision: String(r.legacy_v1_decision ?? "allow"),
              legacyV1Reason: String(r.legacy_v1_reason ?? ""),
              v2Decision: String(r.v2_decision ?? "allow"),
              v2Reason: String(r.v2_reason ?? ""),
              preview: String(r.preview ?? ""),
            };
          }),
        };
      }
    }

    const cfg = (statusRaw.config ?? {}) as Record<string, unknown>;
    const hooksJson = (statusRaw.hooks_json ?? {}) as Record<string, unknown>;
    const stats = (statusRaw.stats ?? {}) as Record<string, unknown>;
    const activeMarkers = Array.isArray(statusRaw.active_markers)
      ? statusRaw.active_markers
      : [];
    const byReasonRaw = (stats.by_reason_code ?? {}) as Record<string, unknown>;
    const auditByReason: Record<string, number> = {};
    for (const [k, v] of Object.entries(byReasonRaw)) {
      auditByReason[k] = Number(v ?? 0);
    }

    const durationMs = Date.now() - startMs;
    const msg = replayData
      ? `Stop Hook v${String(statusRaw.hook_version ?? "2.0.0")} replay (${replayData.conversationId.slice(0, 8)}): v1 blocked ${replayData.legacyV1BlockCount}x → v2 blocked ${replayData.v2BlockCount}x (${replayData.falseBlocksEliminated} false blocks eliminated)`
      : `Stop Hook v${String(statusRaw.hook_version ?? "2.0.0")} (${String(cfg.source ?? "default")}): enabled=${String(cfg.enabled ?? true)} · maxBlocks=${String(cfg.max_blocks_per_turn ?? 1)} · fullyIdleGuard=${String(cfg.require_fully_idle ?? true)} · tailFallback=${String(cfg.transcript_tail_fallback ?? true)}`;

    return {
      ok: Boolean(statusRaw.ok ?? true),
      action,
      hookVersion: String(statusRaw.hook_version ?? "2.0.0"),
      configSource: String(cfg.source ?? "default"),
      enabled: Boolean(cfg.enabled ?? true),
      maxBlocksPerTurn: Number(cfg.max_blocks_per_turn ?? 1),
      requireFullyIdle: Boolean(cfg.require_fully_idle ?? true),
      transcriptTailFallback: Boolean(cfg.transcript_tail_fallback ?? true),
      stopHookEnabledInHooksJson: Boolean(hooksJson.stop_enabled ?? true),
      turnMarkerEnabledInHooksJson: Boolean(hooksJson.turn_marker_enabled ?? true),
      activeMarkersCount: activeMarkers.length,
      auditSampleSize: Number(stats.sample_size ?? 0),
      auditAllowCount: Number(stats.allow_count ?? 0),
      auditBlockCount: Number(stats.block_count ?? 0),
      auditByReason,
      replay: replayData,
      message: msg,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      hookVersion: "2.0.0",
      configSource: "error",
      enabled: true,
      maxBlocksPerTurn: 1,
      requireFullyIdle: true,
      transcriptTailFallback: true,
      stopHookEnabledInHooksJson: true,
      turnMarkerEnabledInHooksJson: true,
      activeMarkersCount: 0,
      auditSampleSize: 0,
      auditAllowCount: 0,
      auditBlockCount: 0,
      auditByReason: {},
      replay: null,
      message: `Writeback hook reconciler error: ${errMsg}`,
      durationMs,
    };
  }
}

function normalizeTimelineItems(rawItems: unknown): SubagentTimelineItem[] {
  if (!Array.isArray(rawItems)) return [];
  const out: SubagentTimelineItem[] = [];
  for (const r of rawItems) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const rawType = String(obj.type ?? "assistant_message");
    const type: "user_message" | "assistant_message" | "tool_call" =
      rawType === "user_message" || rawType === "tool_call" ? rawType : "assistant_message";
    out.push({
      id: String(obj.id ?? ""),
      stepIndex: Number(obj.stepIndex ?? 0),
      type,
      name: typeof obj.name === "string" ? obj.name : undefined,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      text: typeof obj.text === "string" ? obj.text : undefined,
      sender: typeof obj.sender === "string" ? obj.sender : undefined,
      childConversationId:
        typeof obj.childConversationId === "string" ? obj.childConversationId : null,
      subAgentType: typeof obj.subAgentType === "string" ? obj.subAgentType : null,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
    });
  }
  return out;
}

function normalizeTimersAndTasks(rawItems: unknown): SubagentTimerOrTaskNode[] {
  if (!Array.isArray(rawItems)) return [];
  const out: SubagentTimerOrTaskNode[] = [];
  for (const r of rawItems) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const rawKind = String(obj.kind ?? "timer");
    const kind: "timer" | "background_task" =
      rawKind === "background_task" ? "background_task" : "timer";
    const rawSt = String(obj.status ?? "completed");
    const status: "running" | "completed" | "canceled" =
      rawSt === "running" || rawSt === "canceled" ? rawSt : "completed";
    out.push({
      id: String(obj.id ?? ""),
      taskId: String(obj.taskId ?? ""),
      kind,
      stepIndex: Number(obj.stepIndex ?? 0),
      durationSeconds: typeof obj.durationSeconds === "number" ? obj.durationSeconds : null,
      cronExpression: typeof obj.cronExpression === "string" ? obj.cronExpression : null,
      timerCondition: typeof obj.timerCondition === "string" ? obj.timerCondition : null,
      prompt: String(obj.prompt ?? ""),
      status,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
    });
  }
  return out;
}

function normalizeFlatSubagentNode(raw: unknown): FlatSubagentNode | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const rawStatus = String(n.status ?? "completed");
  const status: "running" | "completed" | "failed" =
    rawStatus === "running" || rawStatus === "failed" ? rawStatus : "completed";
  return {
    conversationId: String(n.conversationId ?? ""),
    parentConversationId: String(n.parentConversationId ?? ""),
    depth: Number(n.depth ?? 1),
    toolCallId: typeof n.toolCallId === "string" ? n.toolCallId : null,
    stepIndex: typeof n.stepIndex === "number" ? n.stepIndex : null,
    subAgentType: String(n.subAgentType ?? "subagent"),
    role: String(n.role ?? ""),
    promptPreview: String(n.promptPreview ?? n.firstPromptPreview ?? ""),
    status,
    badge: String(n.badge ?? `[${status === "running" ? "Running" : status === "failed" ? "Failed" : "Done"}]`),
    stepCount: Number(n.stepCount ?? 0),
    toolCallCount: Number(n.toolCallCount ?? 0),
    lastToolName: String(n.lastToolName ?? ""),
    lastMessagePreview: String(n.lastMessagePreview ?? ""),
    lastErrorText: String(n.lastErrorText ?? ""),
    updatedAt: String(n.updatedAt ?? ""),
    mtimeAgeSeconds: Number(n.mtimeAgeSeconds ?? 0),
    transcriptPath: String(n.transcriptPath ?? ""),
    nestedSubagentCount: Number(n.nestedSubagentCount ?? 0),
    nestedRunningCount: Number(n.nestedRunningCount ?? 0),
    timersAndTasks: normalizeTimersAndTasks(n.timersAndTasks),
    timeline: normalizeTimelineItems(n.timeline),
  };
}

interface AgentSubagentIndexEntry {
  agentId: string;
  workspaceId: string;
  provider: string;
  conversationId: string | null;
}

let AGENT_SUBAGENT_INDEX_CACHE: {
  builtAtMs: number;
  byAgentId: Map<string, AgentSubagentIndexEntry>;
  byWorkspaceId: Map<string, AgentSubagentIndexEntry[]>;
} | null = null;

const TRANSCRIPT_ACTIVITY_CACHE = new Map<
  string,
  { mtimeMs: number; size: number; hasActivity: boolean }
>();

const SUBAGENT_RPC_CACHE = new Map<
  string,
  {
    fetchedAtMs: number;
    hasRunning: boolean;
    payload: Awaited<ReturnType<typeof executeManageSubagentsCli>>;
    inFlight?: Promise<Awaited<ReturnType<typeof executeManageSubagentsCli>>>;
  }
>();

function normalizeServerWorkspaceKey(raw?: string | null): string {
  return (raw ?? "").trim().replace(/^[^:]+:/, "").trim();
}

let AGENT_SUBAGENT_INDEX_IN_FLIGHT: Promise<{
  byAgentId: Map<string, AgentSubagentIndexEntry>;
  byWorkspaceId: Map<string, AgentSubagentIndexEntry[]>;
}> | null = null;

async function buildAgentSubagentIndex(): Promise<{
  byAgentId: Map<string, AgentSubagentIndexEntry>;
  byWorkspaceId: Map<string, AgentSubagentIndexEntry[]>;
}> {
  const byAgentId = new Map<string, AgentSubagentIndexEntry>();
  const byWorkspaceId = new Map<string, AgentSubagentIndexEntry[]>();
  const agentsRoot = path.join(os.homedir(), ".paseo", "agents");
  try {
    const buckets = await fs.readdir(agentsRoot, { withFileTypes: true });
    await Promise.all(
      buckets.map(async (bucket) => {
        if (!bucket.isDirectory() || bucket.name === "archived") return;
        const bPath = path.join(agentsRoot, bucket.name);
        let files: string[] = [];
        try {
          files = await fs.readdir(bPath);
        } catch {
          return;
        }
        await Promise.all(
          files.map(async (f) => {
            if (!f.endsWith(".json")) return;
            try {
              const rec = JSON.parse(
                await fs.readFile(path.join(bPath, f), "utf8"),
              ) as FullRawAgentRecord;
              const aid = (rec.id ?? "").trim();
              if (!aid || rec.archivedAt) return;
              const wsKey = normalizeServerWorkspaceKey(rec.workspaceId);
              const cid = extractProviderSessionId(rec);
              const entry: AgentSubagentIndexEntry = {
                agentId: aid,
                workspaceId: wsKey,
                provider: String(rec.provider ?? ""),
                conversationId: cid,
              };
              byAgentId.set(aid, entry);
              if (wsKey) {
                const list = byWorkspaceId.get(wsKey) ?? [];
                list.push(entry);
                byWorkspaceId.set(wsKey, list);
              }
            } catch {
              // ignore
            }
          }),
        );
      }),
    );
  } catch {
    // ignore
  }
  AGENT_SUBAGENT_INDEX_CACHE = { builtAtMs: Date.now(), byAgentId, byWorkspaceId };
  return AGENT_SUBAGENT_INDEX_CACHE;
}

async function getAgentSubagentIndex(): Promise<{
  byAgentId: Map<string, AgentSubagentIndexEntry>;
  byWorkspaceId: Map<string, AgentSubagentIndexEntry[]>;
}> {
  const now = Date.now();
  if (AGENT_SUBAGENT_INDEX_CACHE) {
    if (now - AGENT_SUBAGENT_INDEX_CACHE.builtAtMs >= 15_000 && !AGENT_SUBAGENT_INDEX_IN_FLIGHT) {
      AGENT_SUBAGENT_INDEX_IN_FLIGHT = buildAgentSubagentIndex().finally(() => {
        AGENT_SUBAGENT_INDEX_IN_FLIGHT = null;
      });
    }
    return AGENT_SUBAGENT_INDEX_CACHE;
  }
  if (!AGENT_SUBAGENT_INDEX_IN_FLIGHT) {
    AGENT_SUBAGENT_INDEX_IN_FLIGHT = buildAgentSubagentIndex().finally(() => {
      AGENT_SUBAGENT_INDEX_IN_FLIGHT = null;
    });
  }
  return AGENT_SUBAGENT_INDEX_IN_FLIGHT;
}

async function hasTranscriptSubagentOrTimerActivity(conversationId: string): Promise<boolean> {
  const cid = conversationId.trim();
  if (!cid || !/^[A-Za-z0-9-]+$/.test(cid)) return false;
  const home = os.homedir();
  const candidates = [
    path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    path.join(
      home,
      ".gemini",
      "antigravity",
      "brain",
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
  ];
  for (const tPath of candidates) {
    try {
      const st = await fs.stat(tPath);
      const cached = TRANSCRIPT_ACTIVITY_CACHE.get(tPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        if (cached.hasActivity) return true;
        continue;
      }
      const raw = await fs.readFile(tPath, "utf8");
      const swarmMembersPath = path.join(path.dirname(path.dirname(tPath)), "swarm", "members.json");
      let hasSwarmMembers = false;
      try {
        await fs.access(swarmMembersPath);
        hasSwarmMembers = true;
      } catch {
        hasSwarmMembers = false;
      }
      const hasActivity =
        hasSwarmMembers || /"name"\s*:\s*"(?:invoke_subagent|swarm)"/.test(raw);
      TRANSCRIPT_ACTIVITY_CACHE.set(tPath, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        hasActivity,
      });
      if (hasActivity) return true;
    } catch {
      // file does not exist
    }
  }
  return false;
}

async function canSmartSkipSubagentCli(input: RpcInput<typeof manageSubagentsRpc>): Promise<boolean> {
  const action = input.action ?? "status";
  if (action !== "tree" && action !== "status") return false;
  if (input.conversationId && input.conversationId.trim()) return false;
  const reqAgent = (input.agentId ?? "").trim();
  const reqWs = normalizeServerWorkspaceKey(input.workspaceId);
  if (!reqAgent && !reqWs) return false;

  const idx = await getAgentSubagentIndex();
  const candidates: AgentSubagentIndexEntry[] = [];
  if (reqAgent) {
    const exact = idx.byAgentId.get(reqAgent);
    if (exact) {
      candidates.push(exact);
    } else {
      for (const entry of idx.byAgentId.values()) {
        if (entry.agentId.startsWith(reqAgent)) candidates.push(entry);
      }
    }
  }
  if (reqWs) {
    const wsEntries = idx.byWorkspaceId.get(reqWs) ?? [];
    for (const entry of wsEntries) {
      if (!candidates.some((c) => c.agentId === entry.agentId)) {
        candidates.push(entry);
      }
    }
  }
  if (reqAgent.startsWith("vec-subagent:")) {
    const subCid = reqAgent.slice("vec-subagent:".length).trim();
    if (subCid && (await hasTranscriptSubagentOrTimerActivity(subCid))) {
      return false;
    }
    if (!reqWs) return true;
  }
  if (candidates.length === 0) {
    if (reqWs) return true;
    return false;
  }
  for (const cand of candidates) {
    if (!cand.conversationId) continue;
    if (await hasTranscriptSubagentOrTimerActivity(cand.conversationId)) {
      return false;
    }
  }
  return true;
}

async function executeManageSubagentsCli(
  input: RpcInput<typeof manageSubagentsRpc>,
  startMs: number,
) {
  const action = input.action ?? "status";
  const cliArgs = ["subagents", action, "--json"];
  if (input.agentId && input.agentId.trim()) {
    cliArgs.push("--agent", input.agentId.trim());
  }
  if (input.workspaceId && input.workspaceId.trim()) {
    cliArgs.push("--workspace", input.workspaceId.trim());
  }
  if (input.conversationId && input.conversationId.trim()) {
    cliArgs.push("--cid", input.conversationId.trim());
  }
  if (input.includeTimeline || action === "inspect" || action === "timeline") {
    cliArgs.push("--timeline");
  }
  if (typeof input.limit === "number") {
    cliArgs.push("--limit", String(input.limit));
  }

  const res = await execCommand(ANTIGRAVITY_OPS_BIN, cliArgs, { timeout: 20_000 });
  const parsed = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
  const summaryRaw = (parsed.summary ?? {}) as Record<string, unknown>;
  const rawTrees = Array.isArray(parsed.trees) ? parsed.trees : [];
  const trees: SubagentAgentTree[] = rawTrees.map((t) => {
    const tr = (t ?? {}) as Record<string, unknown>;
    const subSum = (tr.subagentSummary ?? {}) as Record<string, unknown>;
    const rawFlat = Array.isArray(tr.flatSubagents) ? tr.flatSubagents : [];
    const flatSubagents: FlatSubagentNode[] = [];
    for (const item of rawFlat) {
      const norm = normalizeFlatSubagentNode(item);
      if (norm) flatSubagents.push(norm);
    }
    return {
      agentId: String(tr.agentId ?? ""),
      workspaceId: String(tr.workspaceId ?? ""),
      workspaceName: String(tr.workspaceName ?? ""),
      title: String(tr.title ?? ""),
      cwd: String(tr.cwd ?? ""),
      model: String(tr.model ?? "default"),
      agentStatus: String(tr.agentStatus ?? "idle"),
      archived: Boolean(tr.archived ?? false),
      rootConversationId: String(tr.rootConversationId ?? ""),
      rootStepCount: Number(tr.rootStepCount ?? 0),
      rootToolCallCount: Number(tr.rootToolCallCount ?? 0),
      rootLastMessagePreview: String(tr.rootLastMessagePreview ?? ""),
      rootTimersAndTasks: normalizeTimersAndTasks(tr.rootTimersAndTasks),
      updatedAt: String(tr.updatedAt ?? ""),
      subagentSummary: {
        total: Number(subSum.total ?? flatSubagents.length),
        running: Number(subSum.running ?? 0),
        completed: Number(subSum.completed ?? 0),
        failed: Number(subSum.failed ?? 0),
        maxDepth: Number(subSum.maxDepth ?? 0),
        totalSubagentSteps: Number(subSum.totalSubagentSteps ?? 0),
      },
      flatSubagents,
      rootTimeline: normalizeTimelineItems(tr.rootTimeline),
    };
  });

  const singleConversation = normalizeFlatSubagentNode(
    parsed.singleConversation ?? parsed.focusedConversation,
  );
  const totalSubagents = Number(summaryRaw.totalSubagents ?? 0);
  const runningSubagents = Number(summaryRaw.runningSubagents ?? 0);
  const completedSubagents = Number(summaryRaw.completedSubagents ?? 0);
  const failedSubagents = Number(summaryRaw.failedSubagents ?? 0);
  const durationMs = Date.now() - startMs;

  return {
    ok: Boolean(parsed.ok ?? true),
    action,
    targetAgentId: typeof parsed.targetAgentId === "string" ? parsed.targetAgentId : null,
    targetWorkspaceId:
      typeof parsed.targetWorkspaceId === "string" ? parsed.targetWorkspaceId : null,
    targetConversationId:
      typeof parsed.targetConversationId === "string" ? parsed.targetConversationId : null,
    summary: {
      agentsWithSubagents: Number(summaryRaw.agentsWithSubagents ?? trees.length),
      totalSubagents,
      runningSubagents,
      completedSubagents,
      failedSubagents,
    },
    trees,
    singleConversation,
    message: `Subagent Tree: ${trees.length} session(s) · ${totalSubagents} subagents (Running=${runningSubagents}, Done=${completedSubagents}, Failed=${failedSubagents})`,
    durationMs,
  };
}

export async function handleManageSubagents(
  input: RpcInput<typeof manageSubagentsRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  try {
    // Pattern #6 Smart Skip: if querying `tree` or `status` for a specific workspace/agent whose
    // transcript has zero `invoke_subagent` / `schedule` calls, return empty in <1ms without spawning Python.
    if (await canSmartSkipSubagentCli(input)) {
      const durationMs = Date.now() - startMs;
      return {
        ok: true,
        action,
        targetAgentId: input.agentId ?? null,
        targetWorkspaceId: input.workspaceId ?? null,
        targetConversationId: input.conversationId ?? null,
        summary: {
          agentsWithSubagents: 0,
          totalSubagents: 0,
          runningSubagents: 0,
          completedSubagents: 0,
          failedSubagents: 0,
        },
        trees: [],
        singleConversation: null,
        message: "Subagent Tree: 0 session(s) · 0 subagents (Smart-Skipped in <1ms)",
        durationMs,
      };
    }

    const cacheKey = `${action}:${(input.agentId ?? "").trim()}:${normalizeServerWorkspaceKey(
      input.workspaceId,
    )}:${(input.conversationId ?? "").trim()}:${Boolean(input.includeTimeline)}:${input.limit ?? ""}`;
    const now = Date.now();
    const cached = SUBAGENT_RPC_CACHE.get(cacheKey);
    const isBatchTree =
      action === "tree" && !input.agentId && !input.workspaceId && !input.conversationId;
    const ttlMs = cached?.hasRunning ? (isBatchTree ? 8_000 : 5_000) : 30_000;
    if (cached && now - cached.fetchedAtMs < ttlMs) {
      return {
        ...cached.payload,
        durationMs: Date.now() - startMs,
      };
    }
    if (cached?.inFlight) {
      return await cached.inFlight;
    }

    const inFlight = executeManageSubagentsCli(input, startMs).then((payload) => {
      const finishedAt = Date.now();
      SUBAGENT_RPC_CACHE.set(cacheKey, {
        fetchedAtMs: finishedAt,
        hasRunning: payload.summary.runningSubagents > 0,
        payload,
      });
      // When a batch tree call completes without timeline, pre-populate per-workspace and per-agent cache keys
      if (
        action === "tree" &&
        !input.includeTimeline &&
        !input.agentId &&
        !input.workspaceId &&
        !input.conversationId
      ) {
        for (const tr of payload.trees) {
          const singlePayload = {
            ...payload,
            targetAgentId: tr.agentId,
            targetWorkspaceId: tr.workspaceId,
            summary: {
              agentsWithSubagents: 1,
              totalSubagents: tr.subagentSummary.total,
              runningSubagents: tr.subagentSummary.running,
              completedSubagents: tr.subagentSummary.completed,
              failedSubagents: tr.subagentSummary.failed,
            },
            trees: [tr],
          };
          const wsKey = normalizeServerWorkspaceKey(tr.workspaceId);
          for (const lim of ["", "5", "20"]) {
            if (tr.agentId) {
              SUBAGENT_RPC_CACHE.set(`tree:${tr.agentId}::false:${lim}`, {
                fetchedAtMs: finishedAt,
                hasRunning: tr.subagentSummary.running > 0,
                payload: singlePayload,
              });
            }
            if (wsKey) {
              SUBAGENT_RPC_CACHE.set(`tree::${wsKey}::false:${lim}`, {
                fetchedAtMs: finishedAt,
                hasRunning: tr.subagentSummary.running > 0,
                payload: singlePayload,
              });
            }
            if (tr.agentId && wsKey) {
              SUBAGENT_RPC_CACHE.set(`tree:${tr.agentId}:${wsKey}::false:${lim}`, {
                fetchedAtMs: finishedAt,
                hasRunning: tr.subagentSummary.running > 0,
                payload: singlePayload,
              });
            }
          }
        }
      }
      return payload;
    });

    SUBAGENT_RPC_CACHE.set(cacheKey, {
      fetchedAtMs: cached?.fetchedAtMs ?? 0,
      hasRunning: cached?.hasRunning ?? false,
      payload:
        cached?.payload ?? {
          ok: true,
          action,
          targetAgentId: input.agentId ?? null,
          targetWorkspaceId: input.workspaceId ?? null,
          targetConversationId: input.conversationId ?? null,
          summary: {
            agentsWithSubagents: 0,
            totalSubagents: 0,
            runningSubagents: 0,
            completedSubagents: 0,
            failedSubagents: 0,
          },
          trees: [],
          singleConversation: null,
          message: "",
          durationMs: 0,
        },
      inFlight,
    });

    return await inFlight;
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      targetAgentId: input.agentId ?? null,
      targetWorkspaceId: input.workspaceId ?? null,
      targetConversationId: input.conversationId ?? null,
      summary: {
        agentsWithSubagents: 0,
        totalSubagents: 0,
        runningSubagents: 0,
        completedSubagents: 0,
        failedSubagents: 0,
      },
      trees: [],
      singleConversation: null,
      message: `Subagent inspector error: ${errMsg}`,
      durationMs,
    };
  }
}

interface FullRawWorkspaceRecord {
  workspaceId?: string;
  id?: string;
  projectId?: string;
  title?: string | null;
  displayName?: string | null;
  cwd?: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  background?: boolean;
}

interface FullRawProjectRecord {
  projectId?: string;
  displayName?: string;
  customName?: string | null;
  rootPath?: string;
  archivedAt?: string | null;
}

interface FullRawAgentRecord {
  id?: string;
  workspaceId?: string;
  provider?: string;
  title?: string | null;
  cwd?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  lastStatus?: string | null;
  labels?: Record<string, string>;
  config?: {
    model?: string;
    systemPrompt?: string;
  };
  persistence?: {
    sessionId?: string | null;
    metadata?: {
      pluginProviderPersistence?: {
        data?: {
          conversationId?: string | null;
        };
      };
    };
  };
}

function extractProviderSessionId(rec: FullRawAgentRecord): string | null {
  const convId = rec.persistence?.metadata?.pluginProviderPersistence?.data?.conversationId;
  if (typeof convId === "string" && convId.trim()) {
    return convId.trim();
  }
  const rawSid = rec.persistence?.sessionId;
  if (typeof rawSid === "string" && rawSid.trim()) {
    const trimmed = rawSid.trim();
    if (trimmed.startsWith("plugin:")) {
      try {
        const parsed = JSON.parse(trimmed.slice("plugin:".length)) as {
          data?: { conversationId?: string };
        };
        if (parsed?.data?.conversationId) {
          return String(parsed.data.conversationId).trim();
        }
      } catch {
        // Ignore
      }
    }
    return trimmed;
  }
  return null;
}

interface IntakeTaskStateEntry {
  page_id?: string;
  title?: string;
  brief?: string;
  report?: string;
  agent_id?: string;
  state?: string;
}

export async function handleManageSessionLineage(
  input: RpcInput<typeof manageSessionLineageRpc>,
  context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "inspect";
  const autoFixTitles = input.autoFixTitles ?? true;
  const home = os.homedir();
  const paseoDir = path.join(home, ".paseo");

  try {
    // If explicit reconcile requested: for background lineage-bar polling, trigger CLI reconciler non-blocking
    // so the UI renders in <20ms; for Settings/explicit diagnostic calls, await the full CLI summary.
    let cliReconcileRaw: Record<string, unknown> | null = null;
    if (action === "reconcile") {
      if (input.source === "lineage-bar") {
        void execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "reconcile", "--json"], {
          timeout: 25_000,
        }).catch(() => {});
      } else {
        try {
          const res = await execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "reconcile", "--json"], {
            timeout: 25_000,
          });
          cliReconcileRaw = JSON.parse(res.stdout || "{}") as Record<string, unknown>;
        } catch {
          // Continue with in-process inspection & title reconciliation
        }
      }
    }

    // 1. Load projects.json & workspaces.json
    const projectsById = new Map<string, FullRawProjectRecord>();
    try {
      const projRaw = JSON.parse(
        await fs.readFile(path.join(paseoDir, "projects", "projects.json"), "utf8"),
      ) as unknown;
      if (Array.isArray(projRaw)) {
        for (const p of projRaw as FullRawProjectRecord[]) {
          if (p.projectId) projectsById.set(p.projectId, p);
        }
      }
    } catch {
      // Ignore
    }

    const workspacesById = new Map<string, FullRawWorkspaceRecord>();
    try {
      const wsRaw = JSON.parse(
        await fs.readFile(path.join(paseoDir, "projects", "workspaces.json"), "utf8"),
      ) as unknown;
      if (Array.isArray(wsRaw)) {
        for (const w of wsRaw as FullRawWorkspaceRecord[]) {
          const wsId = (w.workspaceId ?? w.id ?? "").trim();
          if (wsId) workspacesById.set(wsId, w);
        }
      }
    } catch {
      // Ignore
    }

    // 2. Load Intake state.json for brief/report/Notion links
    const intakeByAgentId = new Map<string, IntakeTaskStateEntry>();
    const intakeByBriefStem = new Map<string, IntakeTaskStateEntry>();
    const intakeByPageSuffix = new Map<string, IntakeTaskStateEntry>();
    try {
      const stateRaw = JSON.parse(
        await fs.readFile(path.join(paseoDir, "vec-intake", "state.json"), "utf8"),
      ) as { tasks?: Record<string, IntakeTaskStateEntry> };
      for (const [pageId, entry] of Object.entries(stateRaw.tasks ?? {})) {
        const fullPageId = (entry.page_id ?? pageId).trim();
        const enriched: IntakeTaskStateEntry = { ...entry, page_id: fullPageId };
        const cleanHex = fullPageId.replace(/-/g, "").toLowerCase();
        if (cleanHex.length >= 8) {
          intakeByPageSuffix.set(cleanHex.slice(-8), enriched);
          intakeByPageSuffix.set(cleanHex.slice(0, 8), enriched);
        }
        if (entry.agent_id) {
          intakeByAgentId.set(entry.agent_id, enriched);
          intakeByAgentId.set(entry.agent_id.slice(0, 8), enriched);
        }
        if (entry.brief) {
          const stem = path.basename(entry.brief, path.extname(entry.brief));
          intakeByBriefStem.set(stem, enriched);
        }
      }
    } catch {
      // Ignore
    }

    // 3. Scan ~/.paseo/agents/*/*.json
    const agentsRoot = path.join(paseoDir, "agents");
    const agentsById = new Map<string, FullRawAgentRecord>();
    const agentsByShortId = new Map<string, FullRawAgentRecord[]>();
    const agentsByWorkspaceId = new Map<string, FullRawAgentRecord[]>();

    try {
      const buckets = await fs.readdir(agentsRoot, { withFileTypes: true });
      for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue;
        const bPath = path.join(agentsRoot, bucket.name);
        const files = await fs.readdir(bPath);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          try {
            const rec = JSON.parse(
              await fs.readFile(path.join(bPath, f), "utf8"),
            ) as FullRawAgentRecord;
            const aid = (rec.id ?? "").trim();
            if (!aid) continue;
            if (bucket.name === "archived" && !rec.archivedAt) {
              rec.archivedAt = rec.updatedAt ?? "archived";
            }
            if (rec.labels?.["paseo.internal"] === "true") continue;
            const sysPrompt = rec.config?.systemPrompt ?? "";
            if (sysPrompt.includes("Generates a short title for a coding workspace")) continue;
            agentsById.set(aid, rec);
            const sid = aid.slice(0, 8);
            const shortList = agentsByShortId.get(sid) ?? [];
            shortList.push(rec);
            agentsByShortId.set(sid, shortList);
            if (!rec.archivedAt && rec.workspaceId) {
              const wsList = agentsByWorkspaceId.get(rec.workspaceId) ?? [];
              wsList.push(rec);
              agentsByWorkspaceId.set(rec.workspaceId, wsList);
            }
          } catch {
            // Ignore malformed agent json
          }
        }
      }
    } catch {
      // Ignore
    }

    // 4. Auto-reconcile any active workspace whose title is null/empty ('main') using its primary agent's title
    const renamedWorkspaces: Array<{
      workspaceId: string;
      oldDisplayName: string;
      newTitle: string;
      agentId: string;
    }> = [];
    let untitledFound = 0;

    for (const [wsId, ws] of workspacesById.entries()) {
      if (ws.archivedAt) continue;
      const curTitle = (ws.title ?? "").trim();
      if (curTitle) continue;
      const wsAgents = [...(agentsByWorkspaceId.get(wsId) ?? [])].sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      );
      const titledAgent = wsAgents.find((a) => Boolean((a.title ?? "").trim()));
      if (!titledAgent || !titledAgent.id) continue;
      untitledFound += 1;
      const nextTitle = String(titledAgent.title ?? "").trim().slice(0, 80);
      if (autoFixTitles || action === "reconcile") {
        try {
          await context.paseo.workspaces.ref(wsId).setTitle(nextTitle);
          ws.title = nextTitle;
          ws.displayName = nextTitle;
          renamedWorkspaces.push({
            workspaceId: wsId,
            oldDisplayName: String(ws.displayName ?? "main"),
            newTitle: nextTitle,
            agentId: titledAgent.id,
          });
        } catch {
          // Ignore if workspace ref fails
        }
      }
    }

    if (cliReconcileRaw && Array.isArray(cliReconcileRaw.renamed_workspaces)) {
      for (const item of cliReconcileRaw.renamed_workspaces as Array<Record<string, unknown>>) {
        const wsId = String(item.workspace_id ?? "");
        if (wsId && !renamedWorkspaces.some((r) => r.workspaceId === wsId)) {
          renamedWorkspaces.push({
            workspaceId: wsId,
            oldDisplayName: String(item.old_display_name ?? "main"),
            newTitle: String(item.new_title ?? ""),
            agentId: String(item.agent_id ?? ""),
          });
        }
      }
    }

    const resolveAgentByIdOrPrefix = (idOrPrefix?: string | null): FullRawAgentRecord | null => {
      const needle = (idOrPrefix ?? "").trim().replace(/^#/, "");
      if (!needle) return null;
      const exact = agentsById.get(needle);
      if (exact) return exact;
      const byShort = agentsByShortId.get(needle.slice(0, 8));
      if (byShort && byShort.length === 1) return byShort[0];
      for (const [id, rec] of agentsById.entries()) {
        if (id.startsWith(needle)) return rec;
        const pSid = extractProviderSessionId(rec);
        if (pSid && (pSid === needle || pSid.startsWith(needle))) return rec;
      }
      return null;
    };

    const isIntakeOrRoutedAgent = (rec: FullRawAgentRecord): boolean =>
      nonSubagentRelation(rec) === "intake-routed";

    const isColleagueLabeledAgent = (rec: FullRawAgentRecord): boolean =>
      nonSubagentRelation(rec) === "colleague";

    // Only genuine spawned subagents (not Intake queue tasks, not colleague sessions, and not referenced sessions) have a Subagent parent
    const resolveParentOfAgent = (rec: FullRawAgentRecord): FullRawAgentRecord | null => {
      if (nonSubagentRelation(rec) !== null) {
        return null;
      }
      const labels = rec.labels ?? {};
      const parentLabel = (labels["paseo.parent-agent-id"] ?? "").trim();
      if (parentLabel) {
        const found = resolveAgentByIdOrPrefix(parentLabel);
        if (found && found.id !== rec.id) return found;
      }
      const spawnedBy = (labels["spawned-by"] ?? "").trim();
      if (spawnedBy && spawnedBy !== "outside-paseo") {
        const found = resolveAgentByIdOrPrefix(spawnedBy);
        if (found && found.id !== rec.id) return found;
      }
      const parentWsId = (labels["parent-workspace"] ?? "").trim();
      if (parentWsId && parentWsId !== rec.workspaceId) {
        const parentWsAgents = [...(agentsByWorkspaceId.get(parentWsId) ?? [])].sort((a, b) =>
          String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
        );
        if (parentWsAgents[0] && parentWsAgents[0].id !== rec.id) {
          return parentWsAgents[0];
        }
      }
      return null;
    };

    // For Intake-routed or Colleague sessions, resolve the triggering / initiating colleague session
    const resolveRoutedOriginOfAgent = (rec: FullRawAgentRecord): FullRawAgentRecord | null => {
      if (!isIntakeOrRoutedAgent(rec) && !isColleagueLabeledAgent(rec)) {
        return null;
      }
      const labels = rec.labels ?? {};
      const candidates = [
        labels["routed-by-agent-id"],
        labels["colleague-of"],
        labels["routed-by"],
        labels["paseo.parent-agent-id"],
        labels["spawned-by"],
      ];
      for (const raw of candidates) {
        const cleaned = (raw ?? "").trim();
        if (!cleaned || cleaned === "outside-paseo") continue;
        const found = resolveAgentByIdOrPrefix(cleaned);
        if (found && found.id !== rec.id) return found;
      }

      if (isIntakeOrRoutedAgent(rec)) {
        // Fallback 1: check if another intake-routed session already points to a valid coordinator
        for (const other of agentsById.values()) {
          if (!other.id || other.id === rec.id) continue;
          const otherOriginId = (other.labels?.["routed-by-agent-id"] ?? "").trim();
          if (otherOriginId && otherOriginId !== "outside-paseo") {
            const found = resolveAgentByIdOrPrefix(otherOriginId);
            if (found && found.id !== rec.id) return found;
          }
        }
        // Fallback 2: explicit Cowork intake coordinator if present
        const preferred = agentsById.get("3e907bec-8da9-4d52-a28c-3fa4b4b121a5");
        if (preferred && preferred.id !== rec.id && !preferred.archivedAt) {
          return preferred;
        }
        // Fallback 3: most recent non-Intake root session in the same cwd/project
        const recCwd = (rec.cwd ?? "").trim();
        const sameProjectRoots = Array.from(agentsById.values()).filter(
          (cand) =>
            cand.id &&
            cand.id !== rec.id &&
            !cand.archivedAt &&
            !isIntakeOrRoutedAgent(cand) &&
            !isColleagueLabeledAgent(cand) &&
            (recCwd ? (cand.cwd ?? "").trim() === recCwd : true),
        );
        if (sameProjectRoots.length > 0) {
          sameProjectRoots.sort((a, b) =>
            String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
              String(a.updatedAt ?? a.createdAt ?? ""),
            ),
          );
          return sameProjectRoots[0];
        }
      }
      return null;
    };

    // Load peer message outbox (`~/Library/Application Support/com.vec.paseo-peers/outbox/*.json`)
    // to identify genuine message-exchanged Colleague sessions (`from` <-> `to`)
    const peerExchangedByAgentId = new Map<string, Set<string>>();
    const addPeerExchange = (aId: string, bId: string) => {
      if (!aId || !bId || aId === bId) return;
      const setA = peerExchangedByAgentId.get(aId) ?? new Set<string>();
      setA.add(bId);
      peerExchangedByAgentId.set(aId, setA);
      const setB = peerExchangedByAgentId.get(bId) ?? new Set<string>();
      setB.add(aId);
      peerExchangedByAgentId.set(bId, setB);
    };
    try {
      const peersHome = process.env.PASEO_PEERS_USER_HOME || home;
      const outboxDir = path.join(
        peersHome,
        "Library",
        "Application Support",
        "com.vec.paseo-peers",
        "outbox",
      );
      const outboxFiles = await fs.readdir(outboxDir);
      for (const fn of outboxFiles) {
        if (!fn.endsWith(".json")) continue;
        try {
          const msgRec = JSON.parse(
            await fs.readFile(path.join(outboxDir, fn), "utf8"),
          ) as { from?: string | null; to?: string | null; status?: string | null };
          const fromAg = resolveAgentByIdOrPrefix(msgRec.from);
          const toAg = resolveAgentByIdOrPrefix(msgRec.to);
          if (fromAg?.id && toAg?.id && fromAg.id !== toAg.id) {
            addPeerExchange(fromAg.id, toAg.id);
          }
        } catch {
          // Ignore malformed outbox json
        }
      }
    } catch {
      // Ignore missing outbox directory
    }

    const resolveNotionTaskIdForRecord = (
      rec: FullRawAgentRecord,
      intakeEntry?: IntakeTaskStateEntry,
    ): string | null => {
      if (intakeEntry?.page_id) {
        return intakeEntry.page_id;
      }
      const briefStem = (rec.labels?.brief ?? "").trim();
      const match = briefStem.match(/^intake-\d+-\d+-([0-9a-f]{8})-/i);
      if (match?.[1]) {
        const suffix = match[1].toLowerCase();
        const suffixHit = intakeByPageSuffix.get(suffix);
        if (suffixHit?.page_id) {
          return suffixHit.page_id;
        }
        return suffix;
      }
      return null;
    };

    const resolveEffectiveAgentStatus = (
      rec: FullRawAgentRecord,
      ws?: FullRawWorkspaceRecord,
    ): string => {
      if (rec.archivedAt || (ws?.archivedAt && !ws?.pinnedAt)) {
        return "archived";
      }
      const rawStatus = String(rec.lastStatus ?? "idle")
        .trim()
        .toLowerCase();
      if (rawStatus === "running" || rawStatus === "starting") {
        const updatedMs = Date.parse(rec.updatedAt ?? rec.createdAt ?? "") || 0;
        if (updatedMs > 0 && Date.now() - updatedMs > 120_000) {
          return "done";
        }
        return "running";
      }
      if (rawStatus === "failed" || rawStatus === "error") {
        return "failed";
      }
      if (rawStatus === "idle" || rawStatus === "closed" || rawStatus === "completed") {
        return "done";
      }
      return rawStatus || "done";
    };

    const toLineageNode = async (rec: FullRawAgentRecord): Promise<SessionLineageNode> => {
      const aid = String(rec.id ?? "");
      const wsId = String(rec.workspaceId ?? "");
      const ws = workspacesById.get(wsId);
      const proj = ws?.projectId ? projectsById.get(ws.projectId) : undefined;
      const agentTitle = String(rec.title ?? "").trim() || aid.slice(0, 8);
      const workspaceTitle =
        String(ws?.title ?? "").trim() ||
        (ws?.displayName && ws.displayName !== "main" ? String(ws.displayName) : agentTitle);
      const projectName = proj
        ? String(proj.customName ?? proj.displayName ?? "").trim() || null
        : null;

      const labels = rec.labels ?? {};
      const briefStem = (labels.brief ?? "").trim();
      const intakeEntry =
        intakeByAgentId.get(aid) ??
        intakeByAgentId.get(aid.slice(0, 8)) ??
        (briefStem ? intakeByBriefStem.get(briefStem) : undefined);

      let briefPath: string | null = intakeEntry?.brief ?? null;
      let reportPath: string | null = intakeEntry?.report ?? null;
      const cwdDir = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : "";
      if (!briefPath && briefStem) {
        const briefCandidates = [
          path.join(paseoDir, "vec-intake", "briefs", `${briefStem}.md`),
          ...(cwdDir
            ? [
                path.join(cwdDir, "docs", "strategy", `${briefStem}.md`),
                path.join(cwdDir, "docs", `${briefStem}.md`),
                path.join(cwdDir, "tasks", `${briefStem}.md`),
                path.join(cwdDir, `${briefStem}.md`),
              ]
            : []),
        ];
        for (const cand of briefCandidates) {
          if (await fileExists(cand)) {
            briefPath = cand;
            break;
          }
        }
      }
      if (!reportPath && briefStem) {
        const reportCandidates = [
          path.join(paseoDir, "vec-intake", "reports", `${briefStem}.report.md`),
          ...(briefPath ? [briefPath.replace(/\.md$/i, ".report.md")] : []),
          ...(cwdDir
            ? [
                path.join(cwdDir, "docs", "strategy", `${briefStem}.report.md`),
                path.join(cwdDir, "docs", `${briefStem}.report.md`),
                path.join(cwdDir, "tasks", `${briefStem}.report.md`),
                path.join(cwdDir, `${briefStem}.report.md`),
              ]
            : []),
        ];
        for (const cand of reportCandidates) {
          if (await fileExists(cand)) {
            reportPath = cand;
            break;
          }
        }
      }
      const reportExists = reportPath ? await fileExists(reportPath) : false;
      const notionTaskId = resolveNotionTaskIdForRecord(rec, intakeEntry);
      const notionUrl =
        notionTaskId && notionTaskId.length >= 32
          ? `https://www.notion.so/${notionTaskId.replace(/-/g, "")}`
          : null;
      const originRec = resolveRoutedOriginOfAgent(rec);
      const defaultRelKind: SessionRelationKind = isIntakeOrRoutedAgent(rec)
        ? "intake-routed"
        : isColleagueLabeledAgent(rec)
          ? "colleague"
          : resolveParentOfAgent(rec)
            ? "subagent"
            : "self";

      return {
        agentId: aid,
        shortId: aid.slice(0, 8),
        agentTitle,
        workspaceId: wsId,
        workspaceTitle,
        projectId: ws?.projectId ?? null,
        projectName,
        status: resolveEffectiveAgentStatus(rec, ws),
        provider: String(rec.provider ?? "antigravity"),
        model: String(rec.config?.model ?? "default"),
        providerSessionId: extractProviderSessionId(rec),
        relationKind: defaultRelKind,
        routedByAgentId: originRec?.id ?? null,
        createdAt: rec.createdAt ?? null,
        updatedAt: rec.updatedAt ?? null,
        briefPath,
        reportPath,
        reportExists,
        notionUrl,
        notionTaskId,
      };
    };

    const toLightDirectoryNode = (rec: FullRawAgentRecord): SessionLineageNode => {
      const aid = String(rec.id ?? "");
      const wsId = String(rec.workspaceId ?? "");
      const ws = workspacesById.get(wsId);
      const proj = ws?.projectId ? projectsById.get(ws.projectId) : undefined;
      const agentTitle = String(rec.title ?? "").trim() || aid.slice(0, 8);
      const workspaceTitle =
        String(ws?.title ?? "").trim() ||
        (ws?.displayName && ws.displayName !== "main" ? String(ws.displayName) : agentTitle);
      const projectName = proj
        ? String(proj.customName ?? proj.displayName ?? "").trim() || null
        : null;
      const briefStem = (rec.labels?.brief ?? "").trim();
      const intakeEntry =
        intakeByAgentId.get(aid) ??
        intakeByAgentId.get(aid.slice(0, 8)) ??
        (briefStem ? intakeByBriefStem.get(briefStem) : undefined);
      const notionTaskId = resolveNotionTaskIdForRecord(rec, intakeEntry);
      const notionUrl =
        notionTaskId && notionTaskId.length >= 32
          ? `https://www.notion.so/${notionTaskId.replace(/-/g, "")}`
          : null;
      const defaultRelKind: SessionRelationKind = isIntakeOrRoutedAgent(rec)
        ? "intake-routed"
        : isColleagueLabeledAgent(rec)
          ? "colleague"
          : resolveParentOfAgent(rec)
            ? "subagent"
            : "project-peer";
      return {
        agentId: aid,
        shortId: aid.slice(0, 8),
        agentTitle,
        workspaceId: wsId,
        workspaceTitle,
        projectId: ws?.projectId ?? null,
        projectName,
        status: resolveEffectiveAgentStatus(rec, ws),
        provider: String(rec.provider ?? "antigravity"),
        model: String(rec.config?.model ?? "default"),
        providerSessionId: extractProviderSessionId(rec),
        relationKind: defaultRelKind,
        routedByAgentId: null,
        createdAt: rec.createdAt ?? null,
        updatedAt: rec.updatedAt ?? null,
        briefPath: intakeEntry?.brief ?? null,
        reportPath: intakeEntry?.report ?? null,
        reportExists: false,
        notionUrl,
        notionTaskId,
      };
    };

    // 5. Resolve target current agent
    let currentAgent: FullRawAgentRecord | null = null;
    const targetWs = input.workspaceId
      ? input.workspaceId.replace(/^[^:]+:/, "").trim()
      : "";
    if (input.agentId && input.agentId.trim()) {
      const candidate = resolveAgentByIdOrPrefix(input.agentId.trim());
      if (
        candidate &&
        (!targetWs || !candidate.workspaceId || candidate.workspaceId === targetWs)
      ) {
        currentAgent = candidate;
      }
    }
    if (!currentAgent && targetWs) {
      const wsAgents = [...(agentsByWorkspaceId.get(targetWs) ?? [])].sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      );
      currentAgent =
        wsAgents.find((a) => {
          const p = resolveParentOfAgent(a);
          return Boolean(p && p.workspaceId && p.workspaceId !== targetWs);
        }) ??
        wsAgents[0] ??
        null;
    }

    let currentNode: SessionLineageNode | null = null;
    let parentNode: SessionLineageNode | null = null;
    let routedOriginNode: SessionLineageNode | null = null;
    const childNodes: SessionLineageNode[] = [];
    const colleagueNodes: SessionLineageNode[] = [];
    const siblingNodes: SessionLineageNode[] = [];
    const projectPeerNodes: SessionLineageNode[] = [];

    if (currentAgent && currentAgent.id) {
      currentNode = await toLineageNode(currentAgent);
      const parentRec = resolveParentOfAgent(currentAgent);
      if (parentRec) {
        parentNode = { ...(await toLineageNode(parentRec)), relationKind: "parent" };
      } else {
        const originRec = resolveRoutedOriginOfAgent(currentAgent);
        if (originRec) {
          routedOriginNode = {
            ...(await toLineageNode(originRec)),
            relationKind: isIntakeOrRoutedAgent(currentAgent) ? "intake-routed" : "colleague",
          };
        }
      }

      const curId = currentAgent.id;
      const curWsId = currentAgent.workspaceId ?? "";
      const curWs = curWsId ? workspacesById.get(curWsId) : undefined;
      const curProjectId = curWs?.projectId ?? null;
      const curCwd = (currentAgent.cwd ?? "").trim();
      const exchangedPeerIds = peerExchangedByAgentId.get(curId) ?? new Set<string>();
      const rawChildren: FullRawAgentRecord[] = [];
      const rawColleagues: FullRawAgentRecord[] = [];
      const rawSiblings: FullRawAgentRecord[] = [];
      const rawProjectPeers: FullRawAgentRecord[] = [];

      for (const candidate of agentsById.values()) {
        if (!candidate.id || candidate.id === curId) continue;
        const candWs = candidate.workspaceId ? workspacesById.get(candidate.workspaceId) : undefined;
        const isArchivedCandidate = Boolean(
          candidate.archivedAt || (candWs?.archivedAt && !candWs?.pinnedAt),
        );

        const candParent = resolveParentOfAgent(candidate);
        const candParentWs = (candidate.labels?.["parent-workspace"] ?? "").trim();
        const isGenuineSubagentChild =
          !isIntakeOrRoutedAgent(candidate) &&
          !isColleagueLabeledAgent(candidate) &&
          Boolean(
            (candParent &&
              (candParent.id === curId ||
                (curWsId && candParent.workspaceId === curWsId && candidate.workspaceId !== curWsId))) ||
              (curWsId && candParentWs === curWsId && candidate.workspaceId !== curWsId),
          );

        const candOrigin = resolveRoutedOriginOfAgent(candidate);
        const isColleagueOfCurrent =
          exchangedPeerIds.has(candidate.id) ||
          (isColleagueLabeledAgent(candidate) && candOrigin?.id === curId) ||
          (isColleagueLabeledAgent(currentAgent) &&
            resolveRoutedOriginOfAgent(currentAgent)?.id === candidate.id);

        if (isGenuineSubagentChild) {
          rawChildren.push(candidate);
        } else if (isColleagueOfCurrent) {
          rawColleagues.push(candidate);
        } else if (
          !isArchivedCandidate &&
          parentRec &&
          candParent &&
          candParent.id === parentRec.id
        ) {
          rawSiblings.push(candidate);
        } else if (!isArchivedCandidate) {
          const sameProject =
            (curProjectId && candWs?.projectId === curProjectId) ||
            (curCwd && (candidate.cwd ?? "").trim() === curCwd);
          if (sameProject) {
            rawProjectPeers.push(candidate);
          }
        }
      }

      rawChildren.sort((a, b) =>
        String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
          String(a.updatedAt ?? a.createdAt ?? ""),
        ),
      );
      rawColleagues.sort((a, b) =>
        String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
          String(a.updatedAt ?? a.createdAt ?? ""),
        ),
      );
      rawSiblings.sort((a, b) =>
        String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
          String(a.updatedAt ?? a.createdAt ?? ""),
        ),
      );
      rawProjectPeers.sort((a, b) => {
        const aWs = a.workspaceId ? workspacesById.get(a.workspaceId) : undefined;
        const bWs = b.workspaceId ? workspacesById.get(b.workspaceId) : undefined;
        const aRun = resolveEffectiveAgentStatus(a, aWs) === "running" ? 1 : 0;
        const bRun = resolveEffectiveAgentStatus(b, bWs) === "running" ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
          String(a.updatedAt ?? a.createdAt ?? ""),
        );
      });

      for (const ch of rawChildren.slice(0, 24)) {
        childNodes.push({ ...(await toLineageNode(ch)), relationKind: "subagent" });
      }
      for (const col of rawColleagues.slice(0, 24)) {
        colleagueNodes.push({ ...(await toLineageNode(col)), relationKind: "colleague" });
      }
      for (const sb of rawSiblings.slice(0, 12)) {
        siblingNodes.push({ ...(await toLineageNode(sb)), relationKind: "subagent" });
      }
      for (const pp of rawProjectPeers.slice(0, 16)) {
        projectPeerNodes.push({ ...toLightDirectoryNode(pp), relationKind: "project-peer" });
      }
    }

    const activeDirectoryRecords = Array.from(agentsById.values()).filter((a) => Boolean(a.id));
    activeDirectoryRecords.sort((a, b) => {
      const aWs = a.workspaceId ? workspacesById.get(a.workspaceId) : undefined;
      const bWs = b.workspaceId ? workspacesById.get(b.workspaceId) : undefined;
      const aSt = resolveEffectiveAgentStatus(a, aWs);
      const bSt = resolveEffectiveAgentStatus(b, bWs);
      const aArch = aSt === "archived" ? 1 : 0;
      const bArch = bSt === "archived" ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      const aRun = aSt === "running" ? 1 : 0;
      const bRun = bSt === "running" ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
        String(a.updatedAt ?? a.createdAt ?? ""),
      );
    });
    const directoryNodes = activeDirectoryRecords.slice(0, 260).map(toLightDirectoryNode);

    const durationMs = Date.now() - startMs;
    const unlinkedFound = Number(cliReconcileRaw?.unlinked_found ?? 0);
    const linkedCount = Number(cliReconcileRaw?.linked_count ?? 0);
    const detachedCount = Number(cliReconcileRaw?.detached_count ?? 0);

    return {
      ok: true,
      action,
      current: currentNode,
      parent: parentNode,
      routedOrigin: routedOriginNode,
      siblings: siblingNodes,
      children: childNodes,
      colleagues: colleagueNodes,
      projectPeers: projectPeerNodes,
      directory: directoryNodes,
      reconcileSummary: {
        untitledFound: Math.max(untitledFound, renamedWorkspaces.length),
        renamedCount: renamedWorkspaces.length,
        unlinkedFound,
        linkedCount,
        detachedCount,
        renamedWorkspaces,
      },
      message:
        renamedWorkspaces.length > 0 || linkedCount > 0 || detachedCount > 0
          ? `已同步 ${renamedWorkspaces.length} 个侧边栏工作区标题，关联 ${linkedCount} 个子会话，剥离 ${detachedCount} 个误挂靠队列任务`
          : currentNode
            ? `会话血缘: 父智能体=${parentNode ? parentNode.workspaceTitle : "无"} · 派生子智能体=${childNodes.length} · 协作同伴=${colleagueNodes.length} · 同项目同伴=${projectPeerNodes.length}`
            : "会话血缘检查完成",
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      current: null,
      parent: null,
      siblings: [],
      children: [],
      reconcileSummary: {
        untitledFound: 0,
        renamedCount: 0,
        unlinkedFound: 0,
        linkedCount: 0,
        renamedWorkspaces: [],
      },
      message: `Session lineage error: ${errMsg}`,
      durationMs,
    };
  }
}

export async function handleManagePeerAgents(
  input: RpcInput<typeof managePeerAgentsRpc>,
  _context: PluginHandlerContext,
) {
  const startMs = Date.now();
  const action = input.action ?? "status";
  // Shared files on `status`, the recording check on `verify_presence` (server/peer-presence.ts).
  // Runs beside the status call and never rejects: a failed run comes back as null (unknown).
  const presencePending = collectPeerPresence(
    action,
    (args) => execCommand(ANTIGRAVITY_OPS_BIN, args, { timeout: 20_000 }),
    { home: os.homedir() },
  );
  try {
    if (action === "enable_all") {
      await execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "enable", "--json"], {
        timeout: 20_000,
      });
    } else if (action === "heal_outbox") {
      await execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "outbox", "--heal", "--json"], {
        timeout: 20_000,
      });
      await execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "reconcile", "--json"], {
        timeout: 20_000,
      });
    }

    const statusArgs = ["peers", "status", "--json"];
    if (input.cwd && input.cwd.trim()) {
      statusArgs.push("--cwd", input.cwd.trim());
    }
    const { stdout: statusStdout } = await execCommand(ANTIGRAVITY_OPS_BIN, statusArgs, {
      timeout: 15_000,
    });
    const statusJson = JSON.parse(statusStdout.trim() || "{}") as Record<string, unknown>;
    const blockVersion = Number(statusJson.block_version ?? 5);
    const antigravityChannel = String(statusJson.antigravity_channel ?? "cli-fallback");

    const rawSurfaces = Array.isArray(statusJson.surfaces) ? statusJson.surfaces : [];
    const surfaces = rawSurfaces.map((s) => {
      const obj = (s ?? {}) as Record<string, unknown>;
      return {
        name: String(obj.name ?? ""),
        state: String(obj.state ?? "unknown"),
        version: typeof obj.version === "number" ? obj.version : null,
        covers: String(obj.covers ?? ""),
        target: String(obj.target ?? obj.note ?? ""),
      };
    });

    const rawProfiles = Array.isArray(statusJson.profiles) ? statusJson.profiles : [];
    const profiles = rawProfiles.map((p) => {
      const obj = (p ?? {}) as Record<string, unknown>;
      const provider = String(obj.provider ?? "");
      const model = String(obj.model ?? "");
      return {
        id: String(obj.id ?? ""),
        name: String(obj.name ?? ""),
        provider,
        model,
        launchFlags: provider && model ? `--provider ${provider}/${model}` : "",
      };
    });

    const rawPeers = Array.isArray(statusJson.peers) ? statusJson.peers : [];
    let activePeersCount = 0;
    let closedPeersCount = 0;
    for (const p of rawPeers) {
      const st = String((p as Record<string, unknown>)?.status ?? "");
      if (st === "running" || st === "idle") activePeersCount += 1;
      else closedPeersCount += 1;
    }

    let outboxSummary = "outbox: ok";
    try {
      const { stdout: obOut } = await execCommand(ANTIGRAVITY_OPS_BIN, ["peers", "outbox"], {
        timeout: 10_000,
      });
      const firstLine = (obOut.trim().split("\n")[0] ?? "").trim();
      if (firstLine) outboxSummary = firstLine;
    } catch {
      // Ignore
    }

    let resolvedPreview: {
      query: string;
      matchedProfiles: string[];
      sampleReviewCommand: string;
    } | null = null;

    if (action === "test_resolve" || (input.profileQuery && input.profileQuery.trim())) {
      const q = (input.profileQuery || "gemini4, opus 5.5").trim();
      const parts = q
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const revArgs = ["peers", "review"];
      for (const part of parts.length > 0 ? parts : ["gemini4", "opus 5.5"]) {
        revArgs.push("--profile", part);
      }
      revArgs.push("--prompt", "Cross-critique and improve the current design", "--dry-run", "--json");
      const { stdout: revOut } = await execCommand(ANTIGRAVITY_OPS_BIN, revArgs, {
        timeout: 15_000,
      });
      const revJson = JSON.parse(revOut.trim() || "{}") as Record<string, unknown>;
      const matched = Array.isArray(revJson.profiles)
        ? revJson.profiles.map((x) => String(x))
        : [];
      const flags = matched.map((m) => `--profile "${m}"`).join(" ");
      resolvedPreview = {
        query: q,
        matchedProfiles: matched,
        sampleReviewCommand: `antigravity-ops peers review ${flags} --prompt "<task>"`,
      };
    }

    const presenceFields = await presencePending;
    const durationMs = Date.now() - startMs;
    const enabledCount = surfaces.filter((s) => s.state === "enabled").length;
    const message = resolvedPreview
      ? `Resolved "${resolvedPreview.query}" -> [${resolvedPreview.matchedProfiles.join(", ")}] · Command: ${resolvedPreview.sampleReviewCommand}`
      : `Peer Block v${blockVersion} (${enabledCount}/4 auto surfaces enabled) · Profiles=${profiles.length} · Active Peers=${activePeersCount} (Closed=${closedPeersCount} folded)`;

    return {
      ok: true,
      action,
      blockVersion,
      antigravityChannel,
      surfaces,
      profiles,
      activePeersCount,
      closedPeersCount,
      outboxSummary,
      resolvedPreview,
      ...presenceFields,
      message,
      durationMs,
    };
  } catch (err) {
    const presenceFields = await presencePending;
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      action,
      blockVersion: 5,
      antigravityChannel: "cli-fallback",
      surfaces: [],
      profiles: [],
      activePeersCount: 0,
      closedPeersCount: 0,
      outboxSummary: "outbox: unknown",
      resolvedPreview: null,
      ...presenceFields,
      message: `Peer agents reconciler error: ${errMsg}`,
      durationMs,
    };
  }
}
