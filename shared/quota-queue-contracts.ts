import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const QUOTA_QUEUE_STORAGE_VERSION = 1;
export const QUOTA_QUEUE_CLIENT_LEASE_TTL_MS = 90_000;
export const QUOTA_QUEUE_DEFAULT_COOLDOWN_FLOOR_MS = 900_000;
export const QUOTA_QUEUE_SERIAL_SETTLE_MS = 1_200;
// Ids of queued messages already sent, by either drainer (desktop guard or headless
// `antigravity-ops paseo-recovery`). Kept a day so a stale snapshot cannot resend them.
export const QUOTA_QUEUE_DRAINED_LEDGER_TTL_MS = 24 * 3_600_000;
export const QUOTA_QUEUE_DRAINED_LEDGER_MAX_PER_AGENT = 50;

export const QuotaErrorSignalPatterns: readonly RegExp[] = [
  /all accounts rate-limited/i,
  /cooldown wait\s*\d+/i,
  /individual quota reached/i,
  /resource_exhausted/i,
  /quota_exhausted/i,
  /quota exhausted/i,
  /quota_exceeded/i,
  /quota exceeded/i,
  /exhausted your capacity on this model/i,
  /insufficient_g1_credits_balance/i,
  /ai credits balance is too low/i,
  /resource has been exhausted/i,
  /usage_limit_reached/i,
  /billing_error/i,
  /\b(?:5-hour|five[- ]hour|weekly|monthly spend|usage)\s+limit\b/i,
  /\bcredit balance is too low\b/i,
  /\bout of extra usage\b/i,
  /\bhit your\b.*\blimit\b/i,
  /\berror\s*429\b/i,
  /\bstatus(?:\s*code)?\s*[:=]?\s*429\b/i,
  /\bhttp\s*429\b/i,
  /\btoo many requests\b/i,
  /\brate[-_ ]limit(?:ed|ing|_error)?\b/i,
];

export function isQuotaOrRateLimitErrorText(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return QuotaErrorSignalPatterns.some((re) => re.test(trimmed));
}

export function parseQuotaCooldownMs(text: unknown, nowMs: number = Date.now()): number | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const poolMatch = /cooldown wait\s*([0-9]+(?:\.[0-9]+)?)\s*s/i.exec(trimmed);
  if (poolMatch?.[1]) {
    const secs = Number(poolMatch[1]);
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  }

  const retryAfterMatch = /retry[-_ ]after\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*s?/i.exec(trimmed);
  if (retryAfterMatch?.[1]) {
    const secs = Number(retryAfterMatch[1]);
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  }

  const resetDurMatch =
    /(?:resets in|quotaResetDelay["\s:]+)\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:([0-9]+(?:\.[0-9]+)?)\s*s)?/i.exec(
      trimmed,
    );
  if (resetDurMatch && (resetDurMatch[1] || resetDurMatch[2] || resetDurMatch[3] || resetDurMatch[4])) {
    const days = Number(resetDurMatch[1] || 0);
    const hours = Number(resetDurMatch[2] || 0);
    const mins = Number(resetDurMatch[3] || 0);
    const secs = Number(resetDurMatch[4] || 0);
    const totalMs = Math.round(((days * 86400) + (hours * 3600) + (mins * 60) + secs) * 1000);
    if (Number.isFinite(totalMs) && totalMs > 0) return totalMs;
  }

  const clockMatch =
    /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+|UTC)\))?/i.exec(
      trimmed,
    );
  if (clockMatch) {
    try {
      let hr = Number(clockMatch[1]);
      const mn = Number(clockMatch[2] || 0);
      const ampm = clockMatch[3].toLowerCase();
      const tzName = clockMatch[4] || undefined;
      if (ampm === "pm" && hr !== 12) hr += 12;
      else if (ampm === "am" && hr === 12) hr = 0;

      const ref = new Date(nowMs);
      if (!tzName || tzName === "UTC") {
        const target = new Date(nowMs);
        if (tzName === "UTC") {
          target.setUTCHours(hr, mn, 0, 0);
          if (target.getTime() <= ref.getTime()) target.setUTCDate(target.getUTCDate() + 1);
        } else {
          target.setHours(hr, mn, 0, 0);
          if (target.getTime() <= ref.getTime()) target.setDate(target.getDate() + 1);
        }
        const delta = target.getTime() - nowMs;
        if (delta > 0) return delta;
      } else {
        // Approximate using Intl offset for named IANA timezones
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tzName,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        const parts = Object.fromEntries(fmt.formatToParts(ref).map((p) => [p.type, p.value]));
        const tzHour = Number(parts.hour === "24" ? 0 : parts.hour);
        const tzMin = Number(parts.minute);
        const tzSec = Number(parts.second);
        const curSecOfDay = tzHour * 3600 + tzMin * 60 + tzSec;
        const targetSecOfDay = hr * 3600 + mn * 60;
        let diffSec = targetSecOfDay - curSecOfDay;
        if (diffSec <= 0) diffSec += 86400;
        return diffSec * 1000;
      }
    } catch {
      // Ignore invalid timezone string
    }
  }

  return null;
}

export interface TimelineItemLike {
  kind?: unknown;
  sourceType?: unknown;
  level?: unknown;
  message?: unknown;
  text?: unknown;
  status?: unknown;
  error?: unknown;
  timestamp?: unknown;
}

export interface AgentSnapshotLike {
  id?: unknown;
  provider?: unknown;
  model?: unknown;
  status?: unknown;
  lastError?: unknown;
  attentionReason?: unknown;
  turn?: { phase?: unknown; turnId?: unknown } | null;
  runtimeInfo?: { model?: unknown; provider?: unknown } | null;
}

export interface LatestTurnQuotaSignal {
  hasQuotaError: boolean;
  hasAnyError: boolean;
  errorText: string | null;
  errorTimestampMs: number | null;
  cooldownMs: number | null;
  previousTurnIncomplete: boolean;
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function extractLatestTurnQuotaSignal(
  agent: AgentSnapshotLike | null | undefined,
  timelineItems: readonly TimelineItemLike[] = [],
  nowMs: number = Date.now(),
): LatestTurnQuotaSignal {
  let lastUserIdx = -1;
  let lastReplyIdx = -1;
  let lastCompactionDoneIdx = -1;
  let lastQuotaErrIdx = -1;
  let lastQuotaErrText: string | null = null;
  let lastQuotaErrTs: number | null = null;
  let lastAnyErrIdx = -1;
  let lastAnyErrText: string | null = null;

  for (let i = 0; i < timelineItems.length; i += 1) {
    const item = timelineItems[i];
    if (!item || typeof item !== "object") continue;
    const kind = String(item.kind ?? "");
    if (kind === "user_message") {
      lastUserIdx = i;
      continue;
    }
    if (kind === "assistant_message") {
      const txt = typeof item.text === "string" ? item.text.trim() : "";
      if (txt.length > 0) {
        lastReplyIdx = i;
      }
      continue;
    }
    if (kind === "compaction" && String(item.status ?? "") === "completed") {
      lastCompactionDoneIdx = i;
      continue;
    }
    const isErrorNotification =
      kind === "notification" &&
      (String(item.level ?? "") === "error" || String(item.sourceType ?? "") === "error");
    const isErrorKind = kind === "error";
    if (isErrorNotification || isErrorKind) {
      const msg =
        (typeof item.message === "string" && item.message.trim()) ||
        (typeof item.text === "string" && item.text.trim()) ||
        (typeof item.error === "string" && item.error.trim()) ||
        "";
      if (msg) {
        lastAnyErrIdx = i;
        lastAnyErrText = msg;
        if (isQuotaOrRateLimitErrorText(msg)) {
          lastQuotaErrIdx = i;
          lastQuotaErrText = msg;
          lastQuotaErrTs = toEpochMs(item.timestamp);
        }
      }
    }
  }

  const turnCompletedAtOrAfterLastUser =
    lastUserIdx < 0
      ? lastReplyIdx >= 0 || lastCompactionDoneIdx >= 0
      : lastReplyIdx > lastUserIdx || lastCompactionDoneIdx > lastUserIdx;

  const timelineErrorAfterLastReply =
    lastQuotaErrIdx > Math.max(lastReplyIdx, lastCompactionDoneIdx) ||
    (lastQuotaErrIdx >= 0 && lastQuotaErrIdx > lastUserIdx && !turnCompletedAtOrAfterLastUser);

  const agentLastErr = typeof agent?.lastError === "string" ? agent.lastError.trim() : "";
  const agentStatus = String(agent?.status ?? "").toLowerCase();
  const agentAttention = String(agent?.attentionReason ?? "").toLowerCase();
  const agentHasQuotaErr =
    (agentStatus === "error" || agentAttention === "error") && isQuotaOrRateLimitErrorText(agentLastErr);

  const hasQuotaError = timelineErrorAfterLastReply || agentHasQuotaErr;
  const hasAnyError =
    hasQuotaError ||
    agentStatus === "error" ||
    lastAnyErrIdx > Math.max(lastReplyIdx, lastCompactionDoneIdx, lastUserIdx);

  const errorText =
    (timelineErrorAfterLastReply ? lastQuotaErrText : null) ??
    (agentHasQuotaErr ? agentLastErr : null) ??
    (hasAnyError ? lastAnyErrText || agentLastErr || null : null);

  const cooldownMs = errorText ? parseQuotaCooldownMs(errorText, nowMs) : null;

  const previousTurnIncomplete =
    hasQuotaError ||
    (lastUserIdx >= 0 && !turnCompletedAtOrAfterLastUser && (agentStatus === "error" || lastAnyErrIdx > lastUserIdx));

  return {
    hasQuotaError,
    hasAnyError,
    errorText,
    errorTimestampMs: lastQuotaErrTs,
    cooldownMs,
    previousTurnIncomplete,
  };
}

export type QuotaQueueDrainReasonCode =
  | "ok"
  | "disabled"
  | "empty"
  | "initializing"
  | "agent_running"
  | "pending_permission"
  | "quota_error_hold"
  | "previous_turn_incomplete"
  | "quota_not_refreshed"
  | "drain_cooldown";

export interface QuotaQueueGateInput {
  enabled: boolean;
  queuedCount: number;
  initializing: boolean;
  agentRunning: boolean;
  hasPendingPermission: boolean;
  turnSignal: LatestTurnQuotaSignal;
  serverReadyToDrain?: boolean | null;
  serverPreviousTurnCompleted?: boolean | null;
  serverHoldReason?: string | null;
  serverResumeAtMs?: number | null;
  lastDispatchedAtMs?: number | null;
  nowMs?: number;
}

export interface QuotaQueueGateDecision {
  allow: boolean;
  reasonCode: QuotaQueueDrainReasonCode;
  reason: string;
  resumeAtMs: number | null;
}

export function evaluateQuotaQueueDrainGate(input: QuotaQueueGateInput): QuotaQueueGateDecision {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.enabled) {
    return { allow: true, reasonCode: "disabled", reason: "Quota queue guard disabled", resumeAtMs: null };
  }
  if (input.queuedCount <= 0) {
    return { allow: false, reasonCode: "empty", reason: "No queued messages", resumeAtMs: null };
  }
  if (input.initializing) {
    return { allow: false, reasonCode: "initializing", reason: "Agent is initializing", resumeAtMs: null };
  }
  if (input.agentRunning) {
    return { allow: false, reasonCode: "agent_running", reason: "Current turn is still running", resumeAtMs: null };
  }
  if (input.hasPendingPermission) {
    return {
      allow: false,
      reasonCode: "pending_permission",
      reason: "Waiting for user permission/question response",
      resumeAtMs: null,
    };
  }

  // If the server explicitly proved quota refreshed AND previous turn is already completed, allow!
  const serverApproved =
    input.serverReadyToDrain === true && input.serverPreviousTurnCompleted === true;

  if (input.serverReadyToDrain === true && input.serverPreviousTurnCompleted === false) {
    return {
      allow: false,
      reasonCode: "previous_turn_incomplete",
      reason:
        input.serverHoldReason ||
        "Quota refreshed; waiting for previous/current turn to complete before draining queued messages",
      resumeAtMs: input.serverResumeAtMs ?? null,
    };
  }

  if (!serverApproved && input.turnSignal.hasQuotaError) {
    const resumeAtMs =
      input.serverResumeAtMs ??
      (input.turnSignal.cooldownMs
        ? (input.turnSignal.errorTimestampMs ?? nowMs) + input.turnSignal.cooldownMs
        : null);
    return {
      allow: false,
      reasonCode: "quota_error_hold",
      reason:
        input.serverHoldReason ||
        "Previous turn hit 429/quota limit; holding queued messages until quota refreshes",
      resumeAtMs,
    };
  }

  if (input.serverPreviousTurnCompleted === false || (!serverApproved && input.turnSignal.previousTurnIncomplete)) {
    return {
      allow: false,
      reasonCode: "previous_turn_incomplete",
      reason:
        input.serverHoldReason ||
        "Waiting for previous/current turn to complete before draining queued messages",
      resumeAtMs: input.serverResumeAtMs ?? null,
    };
  }

  if (input.serverReadyToDrain === false) {
    return {
      allow: false,
      reasonCode: "quota_not_refreshed",
      reason: input.serverHoldReason || "Waiting for quota refresh",
      resumeAtMs: input.serverResumeAtMs ?? null,
    };
  }

  if (
    typeof input.lastDispatchedAtMs === "number" &&
    nowMs - input.lastDispatchedAtMs < QUOTA_QUEUE_SERIAL_SETTLE_MS
  ) {
    return {
      allow: false,
      reasonCode: "drain_cooldown",
      reason: "Waiting for previous queued message turn to settle",
      resumeAtMs: input.lastDispatchedAtMs + QUOTA_QUEUE_SERIAL_SETTLE_MS,
    };
  }

  return {
    allow: true,
    reasonCode: "ok",
    reason: "Quota healthy and previous turn completed; ready to run next queued message",
    resumeAtMs: null,
  };
}

export const QuotaQueueItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(z.unknown()).default([]),
});

export type QuotaQueueItem = z.infer<typeof QuotaQueueItemSchema>;

export const QuotaQueueAgentEntrySchema = z.object({
  agentId: z.string(),
  serverId: z.string().default("local"),
  provider: z.string().default(""),
  model: z.string().default(""),
  title: z.string().default(""),
  held: z.boolean(),
  reasonCode: z.string().default(""),
  holdReason: z.string().default(""),
  quotaRefreshed: z.boolean().nullable().optional(),
  previousTurnCompleted: z.boolean().nullable().optional(),
  readyToDrain: z.boolean().default(false),
  resumeAtIso: z.string().nullable().optional(),
  lastErrorText: z.string().nullable().optional(),
  queuedCount: z.number(),
  queuedMessages: z.array(QuotaQueueItemSchema),
  updatedAtIso: z.string(),
  lastClientHeartbeatIso: z.string().nullable().optional(),
});

export type QuotaQueueAgentEntry = z.infer<typeof QuotaQueueAgentEntrySchema>;

export const QuotaQueueReceiptSchema = z.object({
  at: z.string(),
  agentId: z.string(),
  action: z.enum(["held", "checked", "drained", "pulled_previous", "released", "restored"]),
  queuedCount: z.number(),
  detail: z.string(),
  messageIds: z.array(z.string()).optional(),
});

export const QuotaQueueDrainedEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  by: z.string().default(""),
});

export type QuotaQueueDrainedEntry = z.infer<typeof QuotaQueueDrainedEntrySchema>;

/** Drop ledger entries past the TTL and cap each agent's list (newest first). */
export function pruneDrainedLedger(
  ledger: Record<string, QuotaQueueDrainedEntry[]> | undefined,
  nowMs: number,
): Record<string, QuotaQueueDrainedEntry[]> {
  const out: Record<string, QuotaQueueDrainedEntry[]> = {};
  for (const [agentId, entries] of Object.entries(ledger ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = entries
      .filter((e) => e && typeof e.id === "string" && e.id)
      .filter((e) => {
        const at = Date.parse(String(e.at ?? ""));
        return Number.isFinite(at) && nowMs - at < QUOTA_QUEUE_DRAINED_LEDGER_TTL_MS;
      })
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, QUOTA_QUEUE_DRAINED_LEDGER_MAX_PER_AGENT);
    if (kept.length > 0) out[agentId] = kept;
  }
  return out;
}

export type QuotaQueueReceipt = z.infer<typeof QuotaQueueReceiptSchema>;

export const manageQuotaQueueRpc = defineRpc({
  name: "finder.manage_quota_queue",
  input: z.object({
    action: z
      .enum(["status", "sync", "check", "drain_one", "release", "clear_agent", "reset"])
      .default("status"),
    agentId: z.string().optional(),
    serverId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    title: z.string().optional(),
    held: z.boolean().optional(),
    reasonCode: z.string().optional(),
    holdReason: z.string().optional(),
    lastErrorText: z.string().nullable().optional(),
    resumeAtMs: z.number().nullable().optional(),
    queuedMessages: z.array(QuotaQueueItemSchema).optional(),
    dispatchedMessageIds: z.array(z.string()).optional(),
    triggerRecoveryIfReady: z.boolean().optional(),
    source: z
      .enum(["runtime-guard", "settings-ui", "slash-command", "command-center", "agent-tool"])
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.string(),
    stateFile: z.string(),
    heldCount: z.number(),
    totalQueuedMessages: z.number(),
    readyToDrain: z.boolean(),
    quotaRefreshed: z.boolean().nullable(),
    previousTurnCompleted: z.boolean().nullable(),
    resumeAtIso: z.string().nullable(),
    holdReason: z.string(),
    entries: z.array(QuotaQueueAgentEntrySchema),
    receipts: z.array(QuotaQueueReceiptSchema),
    drainedMessageIds: z.array(z.string()).optional(),
    message: z.string(),
    durationMs: z.number(),
  }),
});
