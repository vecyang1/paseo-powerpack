// A queued message must never strand: a failed native send is retried, a queue left on an
// idle/errored agent is drained, and a message one drainer already sent is never sent twice
// by the other (desktop guard vs headless `antigravity-ops paseo-recovery`).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleManageQuotaQueue, readQuotaQueueStore } from "../server/quota-queue-handlers";
import {
  installQuotaQueueGuard,
  QUOTA_QUEUE_RECEIPTS_STORAGE_KEY,
  type QuotaQueueRpcCaller,
} from "../client/quota-queue-guard-web";
import { createFakeBrowserEnv } from "./quota-queue-fakes";

type QueueItem = { id: string; text: string; attachments: unknown[] };
type SendOutcome = { status: "submitted" } | { status: "failed"; errorMessage: string };

const AGENT = "agent-12345678";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// Mirrors Paseo's native HostRuntimeStore.drainQueuedAgentMessage + sendQueuedComposerMessageNow
// (app-dist bundle, Paseo 0.16.1): mark `${serverId}:${agentId}` in `queuedAgentDrainInFlight`,
// remove the head, submit it, on failure put it back at the FRONT, clear the in-flight key in
// `finally`, and RETURN NOTHING. The send promise is not returned, so the guard cannot await it.
function buildHarness(opts: {
  queue: QueueItem[];
  agent: Record<string, unknown>;
  outcomes: SendOutcome[];
}) {
  const env = createFakeBrowserEnv();
  const queuedMap = new Map<string, QueueItem[]>([[AGENT, [...opts.queue]]]);
  const agentsMap = new Map<string, Record<string, unknown>>([[AGENT, { id: AGENT, ...opts.agent }]]);
  const listeners = new Set<() => void>();
  const sessionStore = {
    getState: () => ({
      sessions: {
        local: {
          agents: agentsMap,
          queuedMessages: queuedMap,
          initializingAgents: new Map<string, boolean>(),
          pendingPermissions: new Map(),
          agentStreamTail: new Map<string, unknown[]>([[AGENT, []]]),
          agentStreamHead: new Map(),
          client: {},
        },
      },
      setQueuedMessages: (
        _sid: string,
        updater: Map<string, QueueItem[]> | ((p: Map<string, QueueItem[]>) => Map<string, QueueItem[]>),
      ) => {
        const next = typeof updater === "function" ? updater(new Map(queuedMap)) : updater;
        queuedMap.clear();
        for (const [k, v] of next.entries()) queuedMap.set(k, v);
        for (const fn of listeners) fn();
      },
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const submitted: string[] = [];
  const attempts: string[] = [];
  const outcomes = [...opts.outcomes];
  class FakeHostRuntimeStore {
    queuedAgentDrainInFlight = new Set<string>();
    drainQueuedAgentMessage(serverId: string, agentId: string): void {
      const key = `${serverId}:${agentId}`;
      if (this.queuedAgentDrainInFlight.has(key)) return;
      const list = queuedMap.get(agentId) ?? [];
      if (list.length === 0) return;
      this.queuedAgentDrainInFlight.add(key);
      const head = list[0];
      attempts.push(head.id);
      sessionStore.getState().setQueuedMessages("local", (prev) => {
        const next = new Map(prev);
        next.set(agentId, (prev.get(agentId) ?? []).filter((m) => m.id !== head.id));
        return next;
      });
      const outcome = outcomes.shift() ?? { status: "submitted" as const };
      void sleep(5)
        .then(() => {
        if (outcome.status === "failed") {
          sessionStore.getState().setQueuedMessages("local", (prev) => {
            const next = new Map(prev);
            next.set(agentId, [head, ...(prev.get(agentId) ?? [])]);
            return next;
          });
          return outcome;
        }
        submitted.push(head.id);
        return outcome;
        })
        .finally(() => this.queuedAgentDrainInFlight.delete(key));
    }
  }
  const runtime = new FakeHostRuntimeStore();
  (env.win as Record<string, unknown>).__c = new Map<number, unknown>([
    [1, { isInitialized: true, publicModule: { exports: { useSessionStore: sessionStore } } }],
    [
      2,
      {
        isInitialized: true,
        publicModule: { exports: { HostRuntimeStore: FakeHostRuntimeStore, getHostRuntimeStore: () => runtime } },
      },
    ],
  ]);
  return { ...env, queuedMap, agentsMap, runtime, submitted, attempts };
}

function readyRpc(extra?: (input: Parameters<QuotaQueueRpcCaller>[0]) => Record<string, unknown> | void) {
  const calls: Array<Parameters<QuotaQueueRpcCaller>[0]> = [];
  const rpcCall: QuotaQueueRpcCaller = async (input) => {
    calls.push(input);
    const base = {
      ok: true,
      readyToDrain: true,
      quotaRefreshed: true,
      previousTurnCompleted: true,
      resumeAtIso: null,
      holdReason: "",
      entries: [],
    };
    return { ...base, ...(extra?.(input) ?? {}) } as Awaited<ReturnType<QuotaQueueRpcCaller>>;
  };
  return { rpcCall, calls };
}

test("a failed native send of the queue head is retried instead of stranding the queue", async () => {
  const h = buildHarness({
    queue: [
      { id: "m1", text: "/compact", attachments: [] },
      { id: "m2", text: "so all my inro optimization are done?", attachments: [] },
    ],
    agent: { status: "idle", turn: { phase: "idle" } },
    outcomes: [{ status: "failed", errorMessage: "Timed out closing previous session during refresh" }],
  });
  const { rpcCall } = readyRpc();
  let now = 50_000;
  const dispose = installQuotaQueueGuard({
    win: h.win as unknown as Window,
    storage: h.storage,
    rpcCall,
    nowFn: () => now,
    retryDelaysMs: [20],
    heartbeatMs: 60_000,
  });
  try {
    // Turn ended -> native drain -> send fails -> head restored at the front.
    h.runtime.drainQueuedAgentMessage("local", AGENT);
    await waitFor(() => h.attempts.length === 1 && (h.queuedMap.get(AGENT)?.length ?? 0) === 2);
    assert.deepEqual(h.queuedMap.get(AGENT)?.map((m) => m.id), ["m1", "m2"]);
    // Retry fires on its own (well before the first stall sweep at 2s) and submits the SAME
    // head (order preserved), m2 stays queued.
    now += 2_000;
    await waitFor(() => h.submitted.length === 1, 600);
    assert.deepEqual(h.submitted, ["m1"]);
    assert.deepEqual(h.queuedMap.get(AGENT)?.map((m) => m.id), ["m2"]);
    const receipts = JSON.parse(h.storage.getItem(QUOTA_QUEUE_RECEIPTS_STORAGE_KEY) ?? "[]") as Array<{ action: string }>;
    assert.ok(receipts.some((r) => r.action === "dispatch_failed"), "failure must leave a receipt");
  } finally {
    dispose();
  }
});

test("a queue left on an idle/errored agent with no stop event is drained by the stall sweep", async () => {
  const h = buildHarness({
    queue: [{ id: "m1", text: "/compact", attachments: [] }],
    agent: { status: "error", lastError: "Timed out closing previous session during refresh", turn: { phase: "idle" } },
    outcomes: [],
  });
  const { rpcCall } = readyRpc();
  const dispose = installQuotaQueueGuard({
    win: h.win as unknown as Window,
    storage: h.storage,
    rpcCall,
    nowFn: () => 90_000,
    heartbeatMs: 15,
  });
  try {
    await waitFor(() => h.submitted.length === 1);
    assert.deepEqual(h.submitted, ["m1"]);
  } finally {
    dispose();
  }
});

test("the stall sweep never drains a running agent or one waiting on a permission prompt", async () => {
  const h = buildHarness({
    queue: [{ id: "m1", text: "next", attachments: [] }],
    agent: { status: "running", turn: { phase: "open" } },
    outcomes: [],
  });
  const { rpcCall, calls } = readyRpc();
  const dispose = installQuotaQueueGuard({
    win: h.win as unknown as Window,
    storage: h.storage,
    rpcCall,
    nowFn: () => 90_000,
    heartbeatMs: 10,
  });
  try {
    await sleep(80);
    assert.deepEqual(h.attempts, []);
    // No recovery probe either: each `check` spawns `antigravity-ops paseo-recovery` (D-072).
    assert.equal(calls.filter((c) => c.action === "check").length, 0);
    // ...and no "held" banner on an agent that is simply busy.
    assert.equal(h.doc.getElementById("paseo-finder-quota-queue-banner"), null);
  } finally {
    dispose();
  }
});

test("heartbeat keeps the server snapshot fresh and drops messages another drainer already sent", async () => {
  const h = buildHarness({
    queue: [
      { id: "m1", text: "/compact", attachments: [] },
      { id: "m2", text: "sent headlessly", attachments: [] },
    ],
    agent: { status: "running", turn: { phase: "open" } },
    outcomes: [],
  });
  const { rpcCall, calls } = readyRpc((input) =>
    input.action === "sync" ? { drainedMessageIds: ["m2"] } : undefined,
  );
  const dispose = installQuotaQueueGuard({
    win: h.win as unknown as Window,
    storage: h.storage,
    rpcCall,
    nowFn: () => 90_000,
    heartbeatMs: 15,
  });
  try {
    await waitFor(() => calls.filter((c) => c.action === "sync").length >= 2);
    await waitFor(() => (h.queuedMap.get(AGENT)?.length ?? 0) === 1);
    assert.deepEqual(h.queuedMap.get(AGENT)?.map((m) => m.id), ["m1"]);
    assert.deepEqual(h.attempts, [], "a running agent is synced, never drained");
  } finally {
    dispose();
  }
});

test("a successful desktop send is recorded so the headless drainer cannot resend it", async () => {
  const h = buildHarness({
    queue: [
      { id: "m1", text: "/compact", attachments: [] },
      { id: "m2", text: "second", attachments: [] },
    ],
    agent: { status: "idle", turn: { phase: "idle" } },
    outcomes: [],
  });
  const { rpcCall, calls } = readyRpc();
  const dispose = installQuotaQueueGuard({
    win: h.win as unknown as Window,
    storage: h.storage,
    rpcCall,
    nowFn: () => 90_000,
    heartbeatMs: 60_000,
  });
  try {
    h.runtime.drainQueuedAgentMessage("local", AGENT);
    await waitFor(() => calls.some((c) => c.action === "sync" && (c.dispatchedMessageIds ?? []).includes("m1")));
    const sync = calls.find((c) => c.action === "sync" && (c.dispatchedMessageIds ?? []).includes("m1"));
    assert.deepEqual(sync?.queuedMessages?.map((m) => m.id), ["m2"]);
  } finally {
    dispose();
  }
});

test("server ledger: sent ids are filtered from synced queues and reported back; drain_one records its id", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qq-ledger-"));
  const stateFile = path.join(dir, "quota-queued-messages.json");
  const nowMs = Date.parse("2026-11-18T01:30:00Z");
  try {
    // Desktop reports m1 dispatched while m2 waits.
    await handleManageQuotaQueue(
      {
        action: "sync",
        agentId: AGENT,
        serverId: "local",
        held: false,
        queuedMessages: [{ id: "m2", text: "second", attachments: [] }],
        dispatchedMessageIds: ["m1"],
        source: "runtime-guard",
      },
      undefined,
      { stateFile, nowFn: () => nowMs },
    );
    // A stale desktop snapshot that still lists m1 must not resurrect it.
    const res = await handleManageQuotaQueue(
      {
        action: "sync",
        agentId: AGENT,
        serverId: "local",
        held: false,
        queuedMessages: [
          { id: "m1", text: "/compact", attachments: [] },
          { id: "m2", text: "second", attachments: [] },
        ],
        source: "runtime-guard",
      },
      undefined,
      { stateFile, nowFn: () => nowMs + 1_000 },
    );
    assert.deepEqual(res.drainedMessageIds, ["m1"]);
    const store = await readQuotaQueueStore(stateFile);
    assert.deepEqual(store.agents[AGENT].queuedMessages.map((m) => m.id), ["m2"]);
    assert.deepEqual(store.drainedMessages?.[AGENT]?.map((d) => d.id), ["m1"]);

    // Server-side drain_one records the id it sent.
    const sent: string[][] = [];
    await handleManageQuotaQueue(
      { action: "drain_one", agentId: AGENT, source: "settings-ui" },
      undefined,
      {
        stateFile,
        nowFn: () => nowMs + 2_000,
        execFn: async (_cmd, args) => {
          if (args[0] === "paseo-recovery") {
            return { stdout: JSON.stringify({ agents: [], proxyHealthy: true }) };
          }
          sent.push(args);
          return { stdout: "{}", exitCode: 0 };
        },
      },
    );
    assert.equal(sent.length, 1);
    const after = await readQuotaQueueStore(stateFile);
    assert.deepEqual(after.drainedMessages?.[AGENT]?.map((d) => d.id).sort(), ["m1", "m2"]);
    assert.equal(after.agents[AGENT], undefined);

    // Entries older than the TTL are pruned on the next write.
    await handleManageQuotaQueue(
      { action: "sync", agentId: AGENT, serverId: "local", held: false, queuedMessages: [], source: "runtime-guard" },
      undefined,
      { stateFile, nowFn: () => nowMs + 25 * 3_600_000 },
    );
    const pruned = await readQuotaQueueStore(stateFile);
    assert.equal(pruned.drainedMessages?.[AGENT], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
