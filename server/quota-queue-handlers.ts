import type { RpcInput } from "@getpaseo/plugin";
import { execCommand, type PluginHandlerContext } from "@getpaseo/plugin/server";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  QUOTA_QUEUE_STORAGE_VERSION,
  pruneDrainedLedger,
  type QuotaQueueAgentEntry,
  type QuotaQueueDrainedEntry,
  type QuotaQueueItem,
  type QuotaQueueReceipt,
  type manageQuotaQueueRpc,
} from "../shared/quota-queue-contracts";

const ANTIGRAVITY_OPS_BIN = path.join(os.homedir(), ".local", "bin", "antigravity-ops");
const PASEO_BIN = path.join(os.homedir(), ".local", "bin", "paseo");
const MAX_RECEIPTS = 30;
const CHECK_CACHE_TTL_MS = 10_000;

export function defaultQuotaQueueStatePath(): string {
  const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  return path.join(home, "vec-patches", "quota-queued-messages.json");
}

export interface PersistedQuotaQueueStore {
  version: number;
  agents: Record<string, QuotaQueueAgentEntry>;
  receipts: QuotaQueueReceipt[];
  /** Ids already sent per agent, shared with the headless drainer in `antigravity_account_ops.py`. */
  drainedMessages?: Record<string, QuotaQueueDrainedEntry[]>;
}

export interface QuotaQueueHandlerDeps {
  stateFile?: string;
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { timeout?: number; env?: Record<string, string | undefined> },
  ) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  nowFn?: () => number;
}

const recoveryCheckCache = new Map<
  string,
  {
    atMs: number;
    quotaRefreshed: boolean | null;
    previousTurnCompleted: boolean | null;
    readyToDrain: boolean;
    resumeAtIso: string | null;
    holdReason: string;
    classification: string;
  }
>();

export async function readQuotaQueueStore(stateFile: string): Promise<PersistedQuotaQueueStore> {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedQuotaQueueStore>;
    const agents: Record<string, QuotaQueueAgentEntry> = {};
    if (parsed.agents && typeof parsed.agents === "object") {
      for (const [k, v] of Object.entries(parsed.agents)) {
        if (v && typeof v === "object" && typeof v.agentId === "string") {
          agents[k] = v;
        }
      }
    }
    const receipts = Array.isArray(parsed.receipts) ? parsed.receipts.slice(0, MAX_RECEIPTS) : [];
    const drainedMessages =
      parsed.drainedMessages && typeof parsed.drainedMessages === "object" ? parsed.drainedMessages : {};
    return { version: QUOTA_QUEUE_STORAGE_VERSION, agents, receipts, drainedMessages };
  } catch {
    return { version: QUOTA_QUEUE_STORAGE_VERSION, agents: {}, receipts: [] };
  }
}

const stateFileQueue = new Map<string, Promise<unknown>>();

function serializeStateFileOp<T>(stateFile: string, fn: () => Promise<T>): Promise<T> {
  const prev = stateFileQueue.get(stateFile) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  stateFileQueue.set(stateFile, next);
  return next;
}

export async function writeQuotaQueueStore(
  stateFile: string,
  store: PersistedQuotaQueueStore,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const payload = JSON.stringify(
    {
      version: QUOTA_QUEUE_STORAGE_VERSION,
      agents: store.agents,
      receipts: store.receipts.slice(0, MAX_RECEIPTS),
      drainedMessages: store.drainedMessages ?? {},
    },
    null,
    2,
  );
  await fs.writeFile(tmp, payload + "\n", "utf8");
  await fs.rename(tmp, stateFile);
}

function recordDrained(
  store: PersistedQuotaQueueStore,
  agentId: string,
  ids: readonly string[],
  at: string,
  by: string,
): boolean {
  const ledger = (store.drainedMessages ??= {});
  const list = ledger[agentId] ?? [];
  const known = new Set(list.map((e) => e.id));
  const fresh = ids.filter((id) => id && !known.has(id)).map((id) => ({ id, at, by }));
  if (fresh.length === 0) return false;
  ledger[agentId] = [...fresh, ...list];
  return true;
}

function drainedIdsFor(store: PersistedQuotaQueueStore, agentId: string): Set<string> {
  return new Set((store.drainedMessages?.[agentId] ?? []).map((e) => e.id));
}

function appendReceipt(
  store: PersistedQuotaQueueStore,
  receipt: QuotaQueueReceipt,
): void {
  store.receipts = [receipt, ...store.receipts].slice(0, MAX_RECEIPTS);
}

interface RecoveryProbeResult {
  quotaRefreshed: boolean | null;
  previousTurnCompleted: boolean | null;
  readyToDrain: boolean;
  resumeAtIso: string | null;
  holdReason: string;
  classification: string;
}

async function probeAgentRecoveryState(
  agentId: string,
  triggerRecoveryIfReady: boolean,
  deps: QuotaQueueHandlerDeps,
  bypassCache: boolean,
): Promise<RecoveryProbeResult> {
  const nowMs = deps.nowFn ? deps.nowFn() : Date.now();
  const cacheKey = `${agentId}:${triggerRecoveryIfReady ? "heal" : "status"}`;
  if (!bypassCache) {
    const cached = recoveryCheckCache.get(cacheKey);
    if (cached && nowMs - cached.atMs < CHECK_CACHE_TTL_MS) {
      return {
        quotaRefreshed: cached.quotaRefreshed,
        previousTurnCompleted: cached.previousTurnCompleted,
        readyToDrain: cached.readyToDrain,
        resumeAtIso: cached.resumeAtIso,
        holdReason: cached.holdReason,
        classification: cached.classification,
      };
    }
  }

  const exec = deps.execFn ?? execCommand;
  const runOps = async (subAction: "status" | "heal"): Promise<Record<string, unknown> | null> => {
    try {
      const res = await exec(
        ANTIGRAVITY_OPS_BIN,
        ["paseo-recovery", subAction, "--agent", agentId, "--json"],
        {
          timeout: subAction === "heal" ? 45_000 : 25_000,
          env: { ...process.env, VEC_PASEO_NO_RESTART: "1" },
        },
      );
      const out = (res.stdout || "").trim();
      if (out.startsWith("{")) return JSON.parse(out) as Record<string, unknown>;
    } catch (err) {
      const maybeOut = ((err as { stdout?: string })?.stdout || "").trim();
      if (maybeOut.startsWith("{")) {
        try {
          return JSON.parse(maybeOut) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  let parsed = await runOps("status");
  if (!parsed) {
    return {
      quotaRefreshed: null,
      previousTurnCompleted: null,
      readyToDrain: false,
      resumeAtIso: null,
      holdReason: "Unable to query antigravity-ops recovery state; keeping queue safe",
      classification: "UNKNOWN",
    };
  }

  const agents = Array.isArray(parsed.agents) ? (parsed.agents as Array<Record<string, unknown>>) : [];
  let item = agents.find((a) => String(a.agentId ?? "") === agentId || String(a.agentId ?? "").startsWith(agentId));

  // If status didn't list it (for example non-Antigravity/non-Claude provider like Codex/Cursor),
  // check whether proxy is healthy and fall back safely.
  if (!item) {
    const res: RecoveryProbeResult = {
      quotaRefreshed: parsed.proxyHealthy === false ? false : true,
      previousTurnCompleted: true,
      readyToDrain: parsed.proxyHealthy !== false,
      resumeAtIso: null,
      holdReason: parsed.proxyHealthy === false ? "Local proxy (:8045) is offline" : "",
      classification: "NOT_IN_RECOVERY_SCOPE",
    };
    recoveryCheckCache.set(cacheKey, { atMs: nowMs, ...res });
    return res;
  }

  let cls = String(item.classification ?? "");
  let qcd = (item.quotaCooldown && typeof item.quotaCooldown === "object"
    ? (item.quotaCooldown as Record<string, unknown>)
    : null);
  let reason = String(item.reason ?? "");

  // When cooldown expired or early recovery is eligible (`INTERRUPTED_NEEDS_PULLUP`), or when
  // `QUOTA_COOLDOWN_DEFERRED` has ready accounts (`earlyRecovered` / elapsed), run `heal` so the
  // canonical probe/pull-up executes for Turn 0 BEFORE any queued message is allowed to drain.
  if (
    triggerRecoveryIfReady &&
    (cls === "INTERRUPTED_NEEDS_PULLUP" ||
      (cls === "QUOTA_COOLDOWN_DEFERRED" &&
        (qcd?.deferred === false ||
          qcd?.earlyRecovered === true ||
          (typeof qcd?.remainingSecs === "number" && qcd.remainingSecs <= 0) ||
          reason.includes("运行 heal 将自动探针确认") ||
          (bypassCache && reason.includes("等待冷却探测")))) ||
      cls === "CREDIT_BLOCKED")
  ) {
    const healedParsed = await runOps("heal");
    if (healedParsed && Array.isArray(healedParsed.agents)) {
      parsed = healedParsed;
      const healedItem = (healedParsed.agents as Array<Record<string, unknown>>).find(
        (a) => String(a.agentId ?? "") === agentId || String(a.agentId ?? "").startsWith(agentId),
      );
      if (healedItem) {
        item = healedItem;
        cls = String(item.classification ?? "");
        qcd =
          item.quotaCooldown && typeof item.quotaCooldown === "object"
            ? (item.quotaCooldown as Record<string, unknown>)
            : null;
        reason = String(item.reason ?? "");
      }
    }
  }

  const liveStatus = String(item.status ?? "").toLowerCase();
  const resumeAtIso =
    qcd && typeof qcd.resumeAt === "string" && qcd.resumeAt.trim() ? qcd.resumeAt.trim() : null;

  let result: RecoveryProbeResult;
  if (cls === "QUOTA_COOLDOWN_DEFERRED" || cls === "CREDIT_BLOCKED") {
    result = {
      quotaRefreshed: false,
      previousTurnCompleted: false,
      readyToDrain: false,
      resumeAtIso,
      holdReason: reason || "Waiting for quota refresh",
      classification: cls,
    };
  } else if (cls === "INTERRUPTED_NEEDS_PULLUP" || liveStatus === "running" || cls === "RUNNING_ACTIVE" || cls === "WAITING_ON_SUBAGENT") {
    result = {
      quotaRefreshed: true,
      previousTurnCompleted: false,
      readyToDrain: false,
      resumeAtIso: null,
      holdReason:
        liveStatus === "running" || cls === "RUNNING_ACTIVE"
          ? "Previous/current turn is still running; queued messages wait for completion"
          : reason || "Waiting for previous interrupted turn to complete recovery",
      classification: cls,
    };
  } else if (cls === "CIRCUIT_BREAKER_SKIPPED" || cls === "NEEDS_HUMAN") {
    result = {
      quotaRefreshed: false,
      previousTurnCompleted: false,
      readyToDrain: false,
      resumeAtIso: null,
      holdReason: reason || "Previous turn needs recovery/human intervention before queued messages",
      classification: cls,
    };
  } else {
    // HEALTHY_COMPLETED or USER_CANCELLED and not running
    result = {
      quotaRefreshed: true,
      previousTurnCompleted: true,
      readyToDrain: true,
      resumeAtIso: null,
      holdReason: "",
      classification: cls || "HEALTHY_COMPLETED",
    };
  }

  recoveryCheckCache.set(cacheKey, { atMs: nowMs, ...result });
  return result;
}

export async function handleManageQuotaQueue(
  input: RpcInput<typeof manageQuotaQueueRpc>,
  _context?: PluginHandlerContext,
  deps: QuotaQueueHandlerDeps = {},
) {
  const stateFile = deps.stateFile ?? defaultQuotaQueueStatePath();
  return serializeStateFileOp(stateFile, () => handleManageQuotaQueueUnlocked(input, _context, deps, stateFile));
}

async function handleManageQuotaQueueUnlocked(
  input: RpcInput<typeof manageQuotaQueueRpc>,
  _context: PluginHandlerContext | undefined,
  deps: QuotaQueueHandlerDeps,
  stateFile: string,
) {
  const startMs = Date.now();
  const nowMs = deps.nowFn ? deps.nowFn() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const action = input.action ?? "status";
  const agentId = (input.agentId ?? "").trim();
  const store = await readQuotaQueueStore(stateFile);
  const ledgerBefore = JSON.stringify(store.drainedMessages ?? {});
  store.drainedMessages = pruneDrainedLedger(store.drainedMessages, nowMs);
  let ledgerDirty = JSON.stringify(store.drainedMessages) !== ledgerBefore;
  let drainedMessageIds: string[] = [];

  let readyToDrain = false;
  let quotaRefreshed: boolean | null = null;
  let previousTurnCompleted: boolean | null = null;
  let resumeAtIso: string | null = null;
  let holdReason = "";
  let message = "";

  if (action === "reset") {
    store.agents = {};
    store.receipts = [];
    recoveryCheckCache.clear();
    await writeQuotaQueueStore(stateFile, store);
    message = "Cleared persisted quota-held message queue state";
  } else if (action === "clear_agent" && agentId) {
    delete store.agents[agentId];
    recoveryCheckCache.delete(`${agentId}:status`);
    recoveryCheckCache.delete(`${agentId}:heal`);
    await writeQuotaQueueStore(stateFile, store);
    message = `Cleared held queue for agent ${agentId.slice(0, 8)}`;
  } else if (action === "release" && agentId) {
    const existing = store.agents[agentId];
    if (existing) {
      store.agents[agentId] = {
        ...existing,
        held: false,
        reasonCode: "released",
        holdReason: "",
        readyToDrain: true,
        updatedAtIso: nowIso,
      };
      appendReceipt(store, {
        at: nowIso,
        agentId,
        action: "released",
        queuedCount: existing.queuedMessages.length,
        detail: "Manually released quota queue hold",
      });
      await writeQuotaQueueStore(stateFile, store);
    }
    readyToDrain = true;
    quotaRefreshed = true;
    previousTurnCompleted = true;
    message = `Released queue hold for agent ${agentId.slice(0, 8)}`;
  } else if (action === "sync" && agentId) {
    if (recordDrained(store, agentId, input.dispatchedMessageIds ?? [], nowIso, "desktop")) {
      ledgerDirty = true;
    }
    const alreadySent = drainedIdsFor(store, agentId);
    const incoming = input.queuedMessages ?? [];
    drainedMessageIds = incoming.filter((q) => alreadySent.has(q.id)).map((q) => q.id);
    const queued: QuotaQueueItem[] = incoming
      .filter((q) => !alreadySent.has(q.id))
      .map((q) => ({
        id: q.id,
        text: q.text,
        attachments: Array.isArray(q.attachments) ? q.attachments : [],
      }));
    const prev = store.agents[agentId];
    const nextResumeIso =
      typeof input.resumeAtMs === "number" && Number.isFinite(input.resumeAtMs)
        ? new Date(input.resumeAtMs).toISOString()
        : (prev?.resumeAtIso ?? null);

    if (queued.length === 0 && !input.held) {
      if (prev || ledgerDirty) {
        delete store.agents[agentId];
        await writeQuotaQueueStore(stateFile, store);
        ledgerDirty = false;
      }
      readyToDrain = true;
      message = `Synced empty queue for ${agentId.slice(0, 8)}`;
    } else {
      const heldFlag = Boolean(input.held);
      const entry: QuotaQueueAgentEntry = {
        agentId,
        serverId: input.serverId ?? prev?.serverId ?? "local",
        provider: input.provider ?? prev?.provider ?? "",
        model: input.model ?? prev?.model ?? "",
        title: input.title ?? prev?.title ?? "",
        held: heldFlag,
        reasonCode: input.reasonCode ?? prev?.reasonCode ?? "",
        holdReason: input.holdReason ?? prev?.holdReason ?? "",
        quotaRefreshed: heldFlag ? false : (prev?.quotaRefreshed ?? null),
        previousTurnCompleted: heldFlag ? false : (prev?.previousTurnCompleted ?? null),
        readyToDrain: !heldFlag,
        resumeAtIso: nextResumeIso,
        lastErrorText:
          input.lastErrorText !== undefined ? input.lastErrorText : (prev?.lastErrorText ?? null),
        queuedCount: queued.length,
        queuedMessages: queued,
        updatedAtIso: nowIso,
        lastClientHeartbeatIso: nowIso,
      };
      const wasHeld = Boolean(prev?.held);
      store.agents[agentId] = entry;
      if (heldFlag && (!wasHeld || prev?.queuedCount !== queued.length)) {
        appendReceipt(store, {
          at: nowIso,
          agentId,
          action: "held",
          queuedCount: queued.length,
          detail: entry.holdReason || "Held queued messages on 429/quota cooldown",
        });
      }
      await writeQuotaQueueStore(stateFile, store);
      ledgerDirty = false;
      readyToDrain = !heldFlag;
      holdReason = entry.holdReason;
      resumeAtIso = entry.resumeAtIso ?? null;
      message = heldFlag
        ? `Held ${queued.length} queued message(s) for ${agentId.slice(0, 8)}`
        : `Synced ${queued.length} queued message(s) for ${agentId.slice(0, 8)}`;
    }
  } else if (action === "check" && agentId) {
    const bypassCache = input.source !== "runtime-guard";
    const probe = await probeAgentRecoveryState(
      agentId,
      Boolean(input.triggerRecoveryIfReady),
      deps,
      bypassCache,
    );
    quotaRefreshed = probe.quotaRefreshed;
    previousTurnCompleted = probe.previousTurnCompleted;
    readyToDrain = probe.readyToDrain;
    const existing = store.agents[agentId];
    resumeAtIso = probe.quotaRefreshed === true ? null : (probe.resumeAtIso ?? existing?.resumeAtIso ?? null);
    holdReason = probe.holdReason;

    if (existing) {
      const nextReasonCode = probe.readyToDrain
        ? "ok"
        : probe.quotaRefreshed === true
          ? (probe.classification === "RUNNING_ACTIVE" ? "agent_running" : "previous_turn_incomplete")
          : "quota_error_hold";
      store.agents[agentId] = {
        ...existing,
        held: !probe.readyToDrain,
        reasonCode: nextReasonCode,
        quotaRefreshed: probe.quotaRefreshed,
        previousTurnCompleted: probe.previousTurnCompleted,
        readyToDrain: probe.readyToDrain,
        resumeAtIso,
        lastErrorText: probe.quotaRefreshed === true ? null : existing.lastErrorText,
        holdReason: probe.holdReason,
        updatedAtIso: nowIso,
        lastClientHeartbeatIso:
          input.source === "runtime-guard" ? nowIso : existing.lastClientHeartbeatIso,
      };
      appendReceipt(store, {
        at: nowIso,
        agentId,
        action: "checked",
        queuedCount: existing.queuedMessages.length,
        detail: probe.readyToDrain
          ? `Ready (${probe.classification})`
          : probe.holdReason || `Held (${probe.classification})`,
      });
      await writeQuotaQueueStore(stateFile, store);
    }
    message = probe.readyToDrain
      ? `Agent ${agentId.slice(0, 8)} quota refreshed and previous turn completed; ready to drain 1 message`
      : `Agent ${agentId.slice(0, 8)} waiting: ${probe.holdReason || probe.classification}`;
  } else if (action === "drain_one" && agentId) {
    const existing = store.agents[agentId];
    if (!existing || existing.queuedMessages.length === 0) {
      readyToDrain = false;
      holdReason = "No queued messages for this agent";
      message = holdReason;
    } else {
      const probe = await probeAgentRecoveryState(agentId, true, deps, true);
      quotaRefreshed = probe.quotaRefreshed;
      previousTurnCompleted = probe.previousTurnCompleted;
      readyToDrain = probe.readyToDrain;
      resumeAtIso = probe.resumeAtIso;
      holdReason = probe.holdReason;

      if (!probe.readyToDrain) {
        store.agents[agentId] = {
          ...existing,
          held: true,
          quotaRefreshed: probe.quotaRefreshed,
          previousTurnCompleted: probe.previousTurnCompleted,
          readyToDrain: false,
          resumeAtIso: probe.resumeAtIso ?? existing.resumeAtIso ?? null,
          holdReason: probe.holdReason,
          updatedAtIso: nowIso,
        };
        await writeQuotaQueueStore(stateFile, store);
        message = `Still holding ${existing.queuedMessages.length} message(s) for ${agentId.slice(0, 8)}: ${probe.holdReason}`;
      } else {
        const nextMsg = existing.queuedMessages[0];
        const exec = deps.execFn ?? execCommand;
        const sendRes = (await exec(
          PASEO_BIN,
          ["send", "--no-wait", "--json", agentId, nextMsg.text],
          { timeout: 60_000 },
        )) as { stdout?: string; stderr?: string; exitCode?: number };
        const exitCode = typeof sendRes.exitCode === "number" ? sendRes.exitCode : 0;
        if (exitCode !== 0) {
          throw new Error((sendRes.stderr || sendRes.stdout || `paseo send exited ${exitCode}`).trim());
        }
        const remaining = existing.queuedMessages.slice(1);
        recordDrained(store, agentId, [nextMsg.id], nowIso, "server-drain_one");
        if (remaining.length === 0) {
          delete store.agents[agentId];
        } else {
          store.agents[agentId] = {
            ...existing,
            held: false,
            readyToDrain: false,
            holdReason: "Sent 1 queued message; waiting for turn completion before next",
            queuedCount: remaining.length,
            queuedMessages: remaining,
            updatedAtIso: nowIso,
          };
        }
        appendReceipt(store, {
          at: nowIso,
          agentId,
          action: "drained",
          queuedCount: remaining.length,
          detail: `Sent 1 queued message (${nextMsg.text.slice(0, 60)}); ${remaining.length} remaining`,
          messageIds: [nextMsg.id],
        });
        await writeQuotaQueueStore(stateFile, store);
        message = `Dispatched 1 queued message to ${agentId.slice(0, 8)} (${remaining.length} remaining)`;
      }
    }
  } else {
    // status
    const entries = Object.values(store.agents);
    const heldCount = entries.filter((e) => e.held).length;
    const totalQueued = entries.reduce((acc, e) => acc + e.queuedMessages.length, 0);
    if (agentId && store.agents[agentId]) {
      const target = store.agents[agentId];
      readyToDrain = target.readyToDrain;
      quotaRefreshed = target.quotaRefreshed ?? null;
      previousTurnCompleted = target.previousTurnCompleted ?? null;
      resumeAtIso = target.resumeAtIso ?? null;
      holdReason = target.holdReason;
    }
    message = `Quota Queue Guard: ${heldCount} held agent(s), ${totalQueued} queued message(s)`;
  }

  if (ledgerDirty) {
    // Pruning or a newly recorded id with no other write in this action.
    await writeQuotaQueueStore(stateFile, store);
  }

  const entries = Object.values(store.agents).sort((a, b) =>
    b.updatedAtIso.localeCompare(a.updatedAtIso),
  );
  const heldCount = entries.filter((e) => e.held).length;
  const totalQueuedMessages = entries.reduce((acc, e) => acc + e.queuedMessages.length, 0);

  return {
    ok: true,
    action,
    stateFile,
    heldCount,
    totalQueuedMessages,
    readyToDrain,
    quotaRefreshed,
    previousTurnCompleted,
    resumeAtIso,
    holdReason,
    entries,
    receipts: store.receipts.slice(0, MAX_RECEIPTS),
    drainedMessageIds,
    message:
      message ||
      `Quota Queue Guard: ${heldCount} held agent(s), ${totalQueuedMessages} queued message(s)`,
    durationMs: Date.now() - startMs,
  };
}
