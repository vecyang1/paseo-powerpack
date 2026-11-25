import assert from "node:assert/strict";
import test from "node:test";
import {
  childWorkspaceDepth,
  orderSidebarRows,
  planChildSessions,
  type ChildSessionAgent,
} from "../shared/sidebar-child-sessions";
import { planSidebarLayout } from "../client/sidebar-child-sessions-web";

const SERVER = "srv_A";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 10, minute)).toISOString();
const agent = (id: string, workspaceId: string, extra: Partial<ChildSessionAgent> = {}): ChildSessionAgent => ({
  id,
  workspaceId,
  title: `title ${id}`,
  createdAt: at(Number(id.replace(/\D/g, "") || 0)),
  ...extra,
});
const childOf = (parentId: string, extra: Record<string, string> = {}) => ({
  labels: { "paseo.parent-agent-id": parentId, ...extra },
});

test("a child in another workspace nests that workspace under the parent's", () => {
  const plan = planChildSessions(
    [agent("p1", "wks_A"), agent("c2", "wks_B", childOf("p1")), agent("c3", "wks_B", childOf("p1"))],
    { serverId: SERVER },
  );
  assert.deepEqual([...plan.childWorkspaces.keys()], ["wks_B"]);
  const link = plan.childWorkspaces.get("wks_B")!;
  assert.equal(link.parentWorkspaceId, "wks_A");
  assert.deepEqual(link.links, [
    { agentId: "c2", parentAgentId: "p1" },
    { agentId: "c3", parentAgentId: "p1" },
  ]);
  assert.equal(plan.tabChildren.size, 0);
  assert.equal(childWorkspaceDepth(plan, "wks_B"), 1);
  assert.equal(childWorkspaceDepth(plan, "wks_A"), 0);
});

test("the store's parentAgentId counts the same as the label", () => {
  const plan = planChildSessions([agent("p1", "wks_A"), agent("c2", "wks_B", { parentAgentId: "p1" })]);
  assert.equal(plan.childWorkspaces.get("wks_B")?.parentWorkspaceId, "wks_A");
});

test("an empty parent label (intake-routed, colleague) is not a child", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("c2", "wks_B", childOf("", { "relation-kind": "intake-routed", "routed-by-agent-id": "p1" })),
  ]);
  assert.equal(plan.childWorkspaces.size, 0);
  assert.deepEqual(plan.skipped, []);
});

test("intake tasks and colleague peers never nest, even when the daemon left a parent label", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("i2", "wks_B", childOf("p1", { "relation-kind": "intake-routed" })),
    agent("i3", "wks_C", { ...childOf("p1"), title: "Intake · Fix the cadence sync" }),
    agent("i4", "wks_D", childOf("p1", { brief: "intake-261109-0403-96e2e779-a1" })),
    agent("k5", "wks_E", childOf("p1", { "relation-kind": "colleague" })),
    agent("k6", "wks_A", childOf("p1", { "colleague-of": "p1" })),
    agent("s7", "wks_F", childOf("p1", { "relation-kind": "subagent" })),
  ]);
  assert.deepEqual([...plan.childWorkspaces.keys()], ["wks_F"]);
  assert.equal(plan.tabChildren.size, 0, "a same-workspace colleague is not a tab sub-session");
  assert.deepEqual(
    plan.skipped.map((s) => s.agentId).sort(),
    ["i2", "i3", "i4", "k5", "k6"],
  );
  assert.ok(plan.skipped.every((s) => s.reason === "not-a-subagent"));
});

test("a parent that is archived, or not known at all, leaves the child at top level and says why", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A", { archivedAt: at(5) }),
    agent("c2", "wks_B", childOf("p1", { "parent-workspace": "wks_A" })),
    agent("c3", "wks_C", childOf("gone")),
  ]);
  assert.equal(plan.childWorkspaces.size, 0);
  assert.deepEqual(
    plan.skipped.map((s) => `${s.agentId}:${s.reason}`).sort(),
    ["c2:parent-archived", "c3:parent-unknown"],
  );
});

test("a parent in an archived workspace counts as archived", () => {
  const plan = planChildSessions([agent("p1", "wks_A"), agent("c2", "wks_B", childOf("p1"))], {
    archivedWorkspaceIds: ["wks_A"],
  });
  assert.equal(plan.childWorkspaces.size, 0);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["parent-archived"]);
});

test("a workspace that also holds a session the user started stays at top level", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("c2", "wks_B", childOf("p1")),
    agent("u3", "wks_B"),
  ]);
  assert.equal(plan.childWorkspaces.size, 0);
  assert.deepEqual(plan.skipped.map((s) => `${s.agentId}:${s.reason}`), ["c2:mixed-roots"]);
});

test("roots whose parents live in two different workspaces are not nested under either", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("p2", "wks_X"),
    agent("c3", "wks_B", childOf("p1")),
    agent("c4", "wks_B", childOf("p2")),
  ]);
  assert.equal(plan.childWorkspaces.size, 0);
  assert.ok(plan.skipped.every((s) => s.reason === "parents-in-several-workspaces"));
});

test("a parent on another server is ignored; the same server is fine", () => {
  const other = planChildSessions(
    [agent("p1", "wks_A"), agent("c2", "wks_B", childOf("p1", { "paseo.parent-server-id": "srv_Z" }))],
    { serverId: SERVER },
  );
  assert.equal(other.childWorkspaces.size, 0);
  assert.deepEqual(other.skipped.map((s) => s.reason), ["parent-server-differs"]);
  const same = planChildSessions(
    [agent("p1", "wks_A"), agent("c2", "wks_B", childOf("p1", { "paseo.parent-server-id": SERVER }))],
    { serverId: SERVER },
  );
  assert.equal(same.childWorkspaces.size, 1);
});

test("children in the parent's own workspace become tab rows, in creation order, with depth", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("c5", "wks_A", { ...childOf("p1"), running: true }),
    agent("c2", "wks_A", { ...childOf("p1"), pendingPermissionCount: 1 }),
    agent("g7", "wks_A", childOf("c2")),
    agent("x9", "wks_A", { ...childOf("p1"), archivedAt: at(9) }),
  ]);
  const rows = plan.tabChildren.get("wks_A")!;
  assert.deepEqual(
    rows.map((r) => `${r.agentId}@${r.depth}:${r.state}`),
    ["c2@1:attention", "g7@2:idle", "c5@1:running"],
  );
  assert.equal(rows[1].parentAgentId, "c2");
  assert.equal(plan.childWorkspaces.size, 0, "a tab child does not make its workspace a child workspace");
});

test("a child workspace can itself hold tab children and be the parent of another workspace", () => {
  const plan = planChildSessions([
    agent("p1", "wks_A"),
    agent("c2", "wks_B", childOf("p1")),
    agent("g3", "wks_B", childOf("c2")),
    agent("h4", "wks_C", childOf("c2")),
  ]);
  assert.equal(plan.childWorkspaces.get("wks_B")?.parentWorkspaceId, "wks_A");
  assert.equal(plan.childWorkspaces.get("wks_C")?.parentWorkspaceId, "wks_B");
  assert.equal(childWorkspaceDepth(plan, "wks_C"), 2);
  assert.deepEqual(plan.tabChildren.get("wks_B")!.map((r) => r.agentId), ["g3"]);
});

test("a loop of workspaces is dropped instead of hiding rows", () => {
  const plan = planChildSessions([agent("a1", "wks_A", childOf("b2")), agent("b2", "wks_B", childOf("a1"))]);
  assert.equal(plan.childWorkspaces.size, 0);
  assert.ok(plan.skipped.some((s) => s.reason === "cycle"));
});

test("sidebar order puts each child right after its parent and keeps the rest native", () => {
  const parent: Record<string, string> = { child1: "top2", child2: "top2", grand: "child1" };
  assert.deepEqual(
    orderSidebarRows(["child1", "top1", "top2", "grand", "top3", "child2"], (k) => parent[k] ?? null),
    ["top1", "top2", "child1", "grand", "child2", "top3"],
  );
});

test("a child whose parent row is not in this list keeps its native place", () => {
  assert.deepEqual(
    orderSidebarRows(["a", "orphan", "b"], (k) => (k === "orphan" ? "elsewhere" : null)),
    ["a", "orphan", "b"],
  );
});

test("a loop of rows in one list keeps every row on screen", () => {
  const parent: Record<string, string> = { a: "b", b: "a" };
  const out = orderSidebarRows(["x", "a", "b"], (k) => parent[k] ?? null);
  assert.deepEqual([...out].sort(), ["a", "b", "x"]);
});

// ---------------------------------------------------------------------------
// Stylesheet builder against a fake sidebar list (client/sidebar-child-sessions-web.ts)
// ---------------------------------------------------------------------------


interface FakeEl {
  testId: string | null;
  parentElement: FakeEl | null;
  children: FakeEl[];
  getAttribute(name: string): string | null;
  closest(selector: string): FakeEl | null;
}

function fakeSidebar(listId: string, rowKeys: Array<string | null>) {
  const list: FakeEl = {
    testId: listId,
    parentElement: null,
    children: [],
    getAttribute: (n) => (n === "data-testid" ? listId : null),
    closest: () => null,
  };
  const rows: FakeEl[] = [];
  for (const key of rowKeys) {
    const item: FakeEl = { testId: null, parentElement: list, children: [], getAttribute: () => null, closest: () => list };
    list.children.push(item);
    if (!key) continue; // a non-row list child, such as "New workspace"
    const row: FakeEl = {
      testId: `sidebar-workspace-row-${key}`,
      parentElement: item,
      children: [],
      getAttribute: (n) => (n === "data-testid" ? `sidebar-workspace-row-${key}` : null),
      closest: () => list,
    };
    item.children.push(row);
    rows.push(row);
  }
  return { querySelectorAll: () => rows } as unknown as Document;
}

const colors = { name: "light", fg: "#111", muted: "#777", extraMuted: "#aaa", border: "#ddd", hover: "#eee", selected: "#ddd", running: "#06f", warning: "#f90" };

test("the stylesheet moves a child workspace row right after its parent row and indents it", () => {
  const plan = planChildSessions([agent("p1", "wks_P"), agent("c2", "wks_C", childOf("p1")), agent("u3", "wks_U")], { serverId: SERVER });
  const doc = fakeSidebar("sidebar-workspace-list-proj", [null, "srv_A:wks_C", "srv_A:wks_U", "srv_A:wks_P"]);
  const out = planSidebarLayout(doc, [{ serverId: SERVER, plan, titles: new Map([["wks_C", "Child"], ["wks_P", "Parent"]]) }], colors, { enabled: true, tabChildren: true });
  const orderOf = (key: string) => Number(out.css.match(new RegExp(`row-${key}"\\]\\)\\{order:(\\d+);`))?.[1]);
  assert.ok(orderOf("srv_A:wks_U") < orderOf("srv_A:wks_P"), "unrelated row keeps its place above the parent");
  assert.equal(orderOf("srv_A:wks_C"), orderOf("srv_A:wks_P") + 1, "child directly after parent");
  assert.match(out.css, /:nth-child\(1\):not\(:has/, "the non-row list child keeps slot 0");
  assert.match(out.css, /row-srv_A:wks_C"\]\)\{position:relative;padding-left:22px;\}/);
  assert.deepEqual(out.nested.map((n) => `${n.title}<-${n.parentTitle}:${n.onScreen}`), ["Child<-Parent:true"]);
});

test("no rules are written for a list where nothing moves", () => {
  const plan = planChildSessions([agent("p1", "wks_P"), agent("c2", "wks_C", childOf("p1"))], { serverId: SERVER });
  const doc = fakeSidebar("sidebar-workspace-list-other", ["srv_A:wks_C"]); // parent row not in this list
  const out = planSidebarLayout(doc, [{ serverId: SERVER, plan, titles: new Map() }], colors, { enabled: true, tabChildren: true });
  assert.equal(out.cssRules, 0);
  assert.equal(out.nested[0].onScreen, false);
});

test("tab sub-sessions are offered for their workspace row unless turned off", () => {
  const plan = planChildSessions([agent("p1", "wks_P"), agent("c2", "wks_P", childOf("p1"))], { serverId: SERVER });
  const doc = fakeSidebar("sidebar-workspace-list-proj", ["srv_A:wks_P"]);
  const on = planSidebarLayout(doc, [{ serverId: SERVER, plan, titles: new Map() }], colors, { enabled: true, tabChildren: true });
  assert.deepEqual(on.tabBlocks.map((b) => `${b.key}:${b.rows.map((r) => r.agentId)}`), ["srv_A:wks_P:c2"]);
  const off = planSidebarLayout(doc, [{ serverId: SERVER, plan, titles: new Map() }], colors, { enabled: true, tabChildren: false });
  assert.equal(off.tabBlocks.length, 0);
});

test("provider and model metadata propagate from parent and child into tab rows and moved badges", () => {
  const plan = planChildSessions(
    [
      agent("p1", "wks_P", { provider: "antigravity", model: "gemini-4-neon" }),
      agent("t2", "wks_P", {
        ...childOf("p1"),
        provider: "claude",
        model: "claude-opus-5-5",
      }),
      agent("c3", "wks_C", {
        ...childOf("p1"),
        provider: "claude",
        model: "claude-opus-5-5",
      }),
    ],
    { serverId: SERVER },
  );
  const tabRow = plan.tabChildren.get("wks_P")?.[0];
  assert.ok(tabRow);
  assert.equal(tabRow.provider, "claude");
  assert.equal(tabRow.model, "claude-opus-5-5");
  assert.equal(tabRow.parentProvider, "antigravity");
  assert.equal(tabRow.parentModel, "gemini-4-neon");

  const doc = fakeSidebar("sidebar-workspace-list-proj", ["srv_A:wks_C", "srv_A:wks_P"]);
  const out = planSidebarLayout(doc, [{ serverId: SERVER, plan, titles: new Map() }], colors, {
    enabled: true,
    tabChildren: true,
    modelIcons: "always",
  });
  assert.equal(out.nested[0]?.brand, "claude");
  assert.equal(out.nested[0]?.modelSummary, "Claude · Opus 5.5");
  assert.equal(out.nested[0]?.differsFromParent, true);
  assert.equal(out.movedBadges.length, 1);
  assert.equal(out.movedBadges[0]?.workspaceId, "wks_C");
});
