// Shared fakes for the quota-queue guard tests (DOM, storage, window).

export function createMemStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => {
      data.delete(k);
    },
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

export class FakeElement {
  id = "";
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = { setProperty: (() => {}) as unknown as string };
  textContent: string | null = null;
  title = "";
  type = "";
  onclick: ((ev: { preventDefault: () => void; stopPropagation: () => void }) => void) | null = null;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
    if (k === "id") this.id = v;
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  append(...nodes: FakeElement[]) {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
    }
  }
  insertBefore(node: FakeElement, ref: FakeElement | null) {
    if (node.parentElement) {
      node.parentElement.children = node.parentElement.children.filter((c) => c !== node);
    }
    node.parentElement = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx >= 0) this.children.splice(idx, 0, node);
    else this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
  }
  querySelector<T = FakeElement>(selector: string): T | null {
    const walk = (el: FakeElement): FakeElement | null => {
      if (selector === '[data-role="status"]' && el.attributes.get("data-role") === "status") return el;
      if (selector === '[data-role="check"]' && el.attributes.get("data-role") === "check") return el;
      for (const c of el.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this) as T | null;
  }
}

export function createFakeBrowserEnv() {
  const root = new FakeElement("div");
  root.id = "root";
  const composerParent = new FakeElement("div");
  const anchorRoot = new FakeElement("div");
  const textarea = new FakeElement("textarea");
  const queueBtn = new FakeElement("button");
  queueBtn.setAttribute("aria-label", "Edit queued message");
  const p1 = new FakeElement("div");
  const p2 = new FakeElement("div");
  const p3 = new FakeElement("div");
  p1.append(queueBtn);
  p2.append(p1);
  p3.append(p2);
  anchorRoot.append(p3, textarea);
  composerParent.append(anchorRoot);
  root.append(composerParent);

  const doc = {
    documentElement: new FakeElement("html"),
    body: root,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string): FakeElement | null => {
      const walk = (el: FakeElement): FakeElement | null => {
        if (el.id === id) return el;
        for (const c of el.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(root);
    },
    querySelector: (sel: string): FakeElement | null => {
      if (sel.includes("queued message")) return queueBtn;
      if (sel === "textarea") return textarea;
      return null;
    },
  };

  const listeners = new Map<string, Set<() => void>>();
  const storage = createMemStorage();
  const win: Record<string, unknown> = {
    document: doc,
    localStorage: storage,
    location: { pathname: "/workspace/local:wks_1/agents/agent-12345678", hash: "" },
    addEventListener: (ev: string, fn: () => void) => {
      const set = listeners.get(ev) ?? new Set();
      set.add(fn);
      listeners.set(ev, set);
    },
    removeEventListener: (ev: string, fn: () => void) => {
      listeners.get(ev)?.delete(fn);
    },
    dispatchEvent: () => true,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  };
  return { doc, win, storage };
}
