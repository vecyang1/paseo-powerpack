import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type LocalSwarmSummary,
  type LocalWorkflowRun,
  type SwarmBoardBridgeStatus,
  type SwarmBoardMessage,
  type SwarmMemberSummary,
  extractAntigravityConversationIdFromAgentDoc,
  inspectSwarmWorkflowRpc,
  parseWorkflowTaskLog,
} from "../shared/swarm-workflow-contracts";

const CONV_ID_RE = /^[0-9a-f-]{8,}$/i;

interface PaseoAgentMapping {
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  conversationId: string;
  updatedAtMs: number;
}

const AGENT_MAPPING_CACHE_TTL_MS = 15_000;
const agentMappingCache = new Map<
  string,
  {
    at: number;
    byCid: Map<string, PaseoAgentMapping>;
    byAgentId: Map<string, PaseoAgentMapping>;
    fileCache: Map<string, { mtimeMs: number; size: number; mapping: PaseoAgentMapping | null }>;
  }
>();

const SWARM_DIR_INDEX_TTL_MS = 10_000;
const swarmDirIndexCache = new Map<
  string,
  {
    at: number;
    entries: Array<{ appData: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; cid: string }>;
  }
>();

interface SwarmBoardUpstreamLocation {
  dir: string;
  checksum: string | null;
  appDataLabel: "agy-cli" | "antigravity-app";
}

interface BridgeRuntimeState {
  child: ChildProcess | null;
  upstreamPort: number | null;
  upstreamDir: string | null;
  upstreamChecksum: string | null;
  sidecarSdkMode: "official" | "fallback-shim" | "unavailable";
  proxyServer: http.Server | null;
  proxyPort: number | null;
  proxyToken: string;
  starting: Promise<void> | null;
  restarts: number;
  lastError: string | null;
  fallbackLoaderDir: string | null;
}

const bridge: BridgeRuntimeState = {
  child: null,
  upstreamPort: null,
  upstreamDir: null,
  upstreamChecksum: null,
  sidecarSdkMode: "unavailable",
  proxyServer: null,
  proxyPort: null,
  proxyToken: crypto.randomBytes(16).toString("hex"),
  starting: null,
  restarts: 0,
  lastError: null,
  fallbackLoaderDir: null,
};

function readTextSafe(filePath: string, maxBytes = 256 * 1024): string | null {
  try {
    const st = fsSync.statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fsSync.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function locateOfficialSwarmBoard(homeDir = os.homedir()): SwarmBoardUpstreamLocation | null {
  const candidates: Array<{ dir: string; checksumFile: string; label: "agy-cli" | "antigravity-app" }> = [
    {
      dir: path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "plugins", "swarm", "sidecars", "swarm_board"),
      checksumFile: path.join(homeDir, ".gemini", "antigravity-cli", "builtin", ".checksum"),
      label: "agy-cli",
    },
    {
      dir: path.join(homeDir, ".gemini", "antigravity", "builtin", "plugins", "swarm", "sidecars", "swarm_board"),
      checksumFile: path.join(homeDir, ".gemini", "antigravity", "builtin", ".checksum"),
      label: "antigravity-app",
    },
  ];
  for (const cand of candidates) {
    if (
      fsSync.existsSync(path.join(cand.dir, "main.mjs")) &&
      fsSync.existsSync(path.join(cand.dir, "index.html")) &&
      fsSync.existsSync(path.join(cand.dir, "app.js"))
    ) {
      const checksum = readTextSafe(cand.checksumFile, 1024)?.trim() ?? null;
      return { dir: cand.dir, checksum, appDataLabel: cand.label };
    }
  }
  return null;
}

function locateSidecarSdkRegisterLoader(homeDir = os.homedir()): string | null {
  const candidates = [
    path.join(homeDir, ".gemini", "config", "node_modules", "sidecar_sdk", "register_loader.js"),
    path.join(homeDir, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "register_loader.js"),
  ];
  for (const cand of candidates) {
    if (fsSync.existsSync(cand)) return cand;
  }
  return null;
}

function ensureFallbackSidecarSdkLoader(): string {
  if (bridge.fallbackLoaderDir && fsSync.existsSync(path.join(bridge.fallbackLoaderDir, "register.mjs"))) {
    return path.join(bridge.fallbackLoaderDir, "register.mjs");
  }
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "paseo-swarm-sdk-shim-"));
  bridge.fallbackLoaderDir = dir;
  const sdkCode = [
    `import { createServer } from "node:http";`,
    `export class Response {`,
    `  constructor(body, { contentType = "text/plain", status = 200, headers } = {}) {`,
    `    this.body = body; this.contentType = contentType; this.status = status; this.headers = headers;`,
    `  }`,
    `}`,
    `export class SidecarApp {`,
    `  #port; #server; #pages = new Map(); #apis = new Map();`,
    `  constructor() { this.#port = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "0", 10); }`,
    `  get config() { return { projectId: process.env.ANTIGRAVITY_PROJECT_ID || "", conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || "" }; }`,
    `  page(p, fn) { this.#pages.set(p, fn); }`,
    `  api(p, fn, method = "POST") { if (!this.#apis.has(p)) this.#apis.set(p, new Map()); this.#apis.get(p).set(method.toUpperCase(), fn); }`,
    `  run() {`,
    `    const srv = createServer(async (req, res) => {`,
    `      const u = new URL(req.url || "/", "http://127.0.0.1");`,
    `      if (req.method === "GET" && this.#pages.has(u.pathname)) {`,
    `        const out = await this.#pages.get(u.pathname)();`,
    `        if (out instanceof Response) { res.writeHead(out.status || 200, { "Content-Type": out.contentType, ...(out.headers || {}) }); res.end(out.body); return; }`,
    `        res.writeHead(200, { "Content-Type": u.pathname.endsWith(".js") ? "application/javascript" : "text/html" }); res.end(out); return;`,
    `      }`,
    `      const m = this.#apis.get(u.pathname);`,
    `      if (m && m.has(req.method || "GET")) {`,
    `        const data = {};`,
    `        for (const [k, v] of u.searchParams.entries()) if (k.toLowerCase() !== "token") data[k] = v;`,
    `        try {`,
    `          const out = await m.get(req.method || "GET")(data);`,
    `          if (out instanceof Response || (out && typeof out === "object" && out.contentType && out.body !== undefined)) {`,
    `            res.writeHead(out.status || 200, { "Content-Type": out.contentType, ...(out.headers || {}) });`,
    `            res.end(typeof out.body === "string" ? out.body : Buffer.from(out.body));`,
    `            return;`,
    `          }`,
    `          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); return;`,
    `        } catch (err) {`,
    `          res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(err?.message || err) })); return;`,
    `        }`,
    `      }`,
    `      res.writeHead(404); res.end("Not found");`,
    `    });`,
    `    return new Promise((resolve) => {`,
    `      this.#server = srv.listen(this.#port, "127.0.0.1", () => {`,
    `        console.log("[sidecar] listening on 127.0.0.1:" + srv.address().port);`,
    `        resolve(srv);`,
    `      });`,
    `    });`,
    `  }`,
    `}`,
  ].join("\n");
  const sdkPath = path.join(dir, "sidecar_sdk.mjs");
  const sdkUrl = pathToFileURL(sdkPath).href;
  const resolverPath = path.join(dir, "resolver.mjs");
  const registerPath = path.join(dir, "register.mjs");
  fsSync.writeFileSync(sdkPath, sdkCode, "utf8");
  fsSync.writeFileSync(
    resolverPath,
    `export async function resolve(specifier, context, nextResolve) {\n  if (specifier === "sidecar_sdk") return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true };\n  return nextResolve(specifier, context);\n}\n`,
    "utf8",
  );
  fsSync.writeFileSync(
    registerPath,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(resolverPath).href)});\n`,
    "utf8",
  );
  return registerPath;
}

function resolveNodeExecutable(): string {
  for (const cand of [process.execPath, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (!cand) continue;
    try {
      if (path.basename(cand).toLowerCase().includes("node") && fsSync.existsSync(cand)) {
        return cand;
      }
    } catch {
      // continue
    }
  }
  return "node";
}

function allocateFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("Failed to allocate loopback port"));
      });
    });
  });
}

function waitForHttpReady(port: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const req = http.get({ host: "127.0.0.1", port, path: "/api/swarm", timeout: 800 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => {
        setTimeout(attempt, 120);
      });
      req.on("timeout", () => {
        req.destroy();
        setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

function buildPaseoSwarmPreloadJs(): string {
  return `(function () {
  var params = new URLSearchParams(window.location.search);
  var currentConversationId = params.get("conversationId") || "";
  var currentToken = params.get("token") || "";
  var expandDoneTasksDefault = params.get("expandDoneTasks") !== "0";
  var userToggledDoneOpen = false;
  var autoClickingDoneOpen = false;
  var expandRetryTimer = null;

  function maybeAutoExpandDoneTasks() {
    if (!expandDoneTasksDefault || userToggledDoneOpen) return;
    if (!document || typeof document.querySelector !== "function") return;
    var btn = document.querySelector('button.o2-progh[data-o2="doneOpen"][aria-expanded="false"]');
    if (!btn || typeof btn.click !== "function") return;
    if (typeof btn.onclick !== "function") {
      if (expandRetryTimer) clearTimeout(expandRetryTimer);
      expandRetryTimer = setTimeout(function () {
        expandRetryTimer = null;
        maybeAutoExpandDoneTasks();
      }, 30);
      return;
    }
    autoClickingDoneOpen = true;
    try {
      btn.click();
    } finally {
      autoClickingDoneOpen = false;
    }
  }

  document.addEventListener("click", function (ev) {
    if (autoClickingDoneOpen) return;
    var target = ev && ev.target;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest('button.o2-progh[data-o2="doneOpen"]')) {
      userToggledDoneOpen = true;
    }
  }, true);

  function installOverviewAutoExpandObserver() {
    maybeAutoExpandDoneTasks();
    if (typeof MutationObserver === "undefined" || !document.documentElement) return;
    var mo = new MutationObserver(function () {
      maybeAutoExpandDoneTasks();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function applyThemeVars(vars, scheme) {
    if (!vars || typeof vars !== "object") return;
    var root = document.documentElement;
    if (!root) return;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k) && typeof vars[k] === "string") {
        root.style.setProperty(k, vars[k]);
      }
    }
    if (scheme === "dark" || scheme === "light") {
      root.setAttribute("data-theme", scheme);
      root.style.colorScheme = scheme;
    }
  }

  var initScheme = params.get("scheme") || "";
  if (initScheme === "dark" || initScheme === "light") {
    document.documentElement.setAttribute("data-theme", initScheme);
    document.documentElement.style.colorScheme = initScheme;
  }

  function applyBodyBase() {
    var root = document.documentElement;
    if (root) {
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.setProperty("--col", "min(960px, calc(100% - 32px))");
    }
    if (!document.body) return;
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.width = "100%";
    document.body.style.minHeight = "100%";
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      applyBodyBase();
      installOverviewAutoExpandObserver();
    });
  } else {
    applyBodyBase();
    installOverviewAutoExpandObserver();
  }

  window.addEventListener("message", function (event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "theme-change" && msg.payload) {
      applyThemeVars(msg.payload.cssVariables, msg.payload.colorScheme);
    } else if (msg.type === "paseo-swarm-set-prefs" && msg.payload) {
      if (typeof msg.payload.expandDoneTasks === "boolean") {
        expandDoneTasksDefault = msg.payload.expandDoneTasks;
        if (expandDoneTasksDefault) maybeAutoExpandDoneTasks();
      }
    } else if (msg.type === "paseo-swarm-set-conversation" && typeof msg.conversationId === "string") {
      if (msg.conversationId !== currentConversationId) {
        userToggledDoneOpen = false;
      }
      currentConversationId = msg.conversationId;
      if (window.sidecar) window.sidecar.conversationId = currentConversationId;
      try {
        var nextUrl = new URL(window.location.href);
        if (currentConversationId) nextUrl.searchParams.set("conversationId", currentConversationId);
        else nextUrl.searchParams.delete("conversationId");
        window.history.replaceState(null, "", nextUrl.toString());
      } catch (e) {}
      setTimeout(maybeAutoExpandDoneTasks, 60);
    }
  });

  function secureFetch(url, options) {
    var opts = options || {};
    var headers = new Headers(opts.headers || {});
    if (currentToken) headers.set("X-Sidecar-Token", currentToken);
    return fetch(url, Object.assign({}, opts, { headers: headers }));
  }

  window.sidecar = {
    conversationId: currentConversationId,
    fetch: secureFetch,
    getWorkspaceUris: function () { return Promise.resolve([]); },
    onWorkspaceChange: function () { return function () {}; },
    agent: {
      sendMessage: function () { return Promise.reject(new Error("Read-only in Paseo Swarm Bridge")); },
      startConversation: function () { return Promise.reject(new Error("Read-only in Paseo Swarm Bridge")); },
      getConversationMetadata: function (cid) {
        return secureFetch("/_sidecar/get-conversation-metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: cid || currentConversationId })
        }).then(function (r) { return r.json(); });
      }
    },
    ui: {
      toggleConversation: function (convId, options) {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: "paseo-swarm-open-conversation",
            payload: { conversationId: String(convId || ""), options: options || null }
          }, "*");
        }
      },
      toggleAuxPane: function (request) {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: "paseo-swarm-open-file",
            payload: request || null
          }, "*");
        }
      },
      addArtifactComment: function () {}
    },
    auth: {
      requestCredentialRefresh: function () {}
    }
  };

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "paseo-swarm-preload-ready", conversationId: currentConversationId }, "*");
  }
})();\n`;
}

function readPaseoAgentMappings(
  homeDir = os.homedir(),
  options?: { bypassCache?: boolean },
): Map<string, PaseoAgentMapping> {
  const now = Date.now();
  const prevState = agentMappingCache.get(homeDir);
  if (!options?.bypassCache && prevState && now - prevState.at < AGENT_MAPPING_CACHE_TTL_MS) {
    return prevState.byCid;
  }
  const byCid = new Map<string, PaseoAgentMapping>();
  const byAgentId = new Map<string, PaseoAgentMapping>();
  const prevFileCache = prevState?.fileCache ?? new Map();
  const nextFileCache = new Map<
    string,
    { mtimeMs: number; size: number; mapping: PaseoAgentMapping | null }
  >();
  const agentsRoot = path.join(homeDir, ".paseo", "agents");
  let buckets: string[] = [];
  try {
    buckets = fsSync.readdirSync(agentsRoot);
  } catch {
    return byCid;
  }
  for (const bucket of buckets) {
    if (bucket.startsWith(".")) continue;
    const bDir = path.join(agentsRoot, bucket);
    let files: string[] = [];
    try {
      files = fsSync.readdirSync(bDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const fullPath = path.join(bDir, f);
      let st: fsSync.Stats;
      try {
        st = fsSync.statSync(fullPath);
        if (!st.isFile() || st.size > 192 * 1024) continue;
      } catch {
        continue;
      }
      const cachedFile = prevFileCache.get(fullPath);
      let mapping: PaseoAgentMapping | null = null;
      if (cachedFile && cachedFile.mtimeMs === st.mtimeMs && cachedFile.size === st.size) {
        mapping = cachedFile.mapping;
      } else {
        try {
          const raw = fsSync.readFileSync(fullPath, "utf8");
          if (raw.includes("conversationId")) {
            const doc = JSON.parse(raw) as {
              id?: string;
              workspaceId?: string;
              title?: string;
              name?: string;
              updatedAt?: string;
              lastActivityAt?: string;
              createdAt?: string;
            };
            const cid = extractAntigravityConversationIdFromAgentDoc(doc);
            if (cid && CONV_ID_RE.test(cid)) {
              const parsedUpdated = Date.parse(
                String(doc.updatedAt ?? doc.lastActivityAt ?? doc.createdAt ?? ""),
              );
              const updatedAtMs = Number.isFinite(parsedUpdated) ? parsedUpdated : st.mtimeMs;
              mapping = {
                agentId: String(doc.id ?? f.slice(0, -5)),
                workspaceId: typeof doc.workspaceId === "string" ? doc.workspaceId : null,
                title:
                  typeof doc.title === "string"
                    ? doc.title
                    : typeof doc.name === "string"
                      ? doc.name
                      : null,
                conversationId: cid,
                updatedAtMs,
              };
            }
          }
        } catch {
          mapping = null;
        }
      }
      nextFileCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, mapping });
      if (mapping) {
        byAgentId.set(mapping.agentId, mapping);
        const prev = byCid.get(mapping.conversationId);
        if (!prev || mapping.updatedAtMs >= prev.updatedAtMs) {
          byCid.set(mapping.conversationId, mapping);
        }
      }
    }
  }
  agentMappingCache.set(homeDir, { at: now, byCid, byAgentId, fileCache: nextFileCache });
  return byCid;
}

function normalizeWorkspaceIdForMatch(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const colon = s.indexOf(":");
  return colon > 0 ? s.slice(colon + 1) : s;
}

function resolveConversationForRequest(
  input: RpcInput<typeof inspectSwarmWorkflowRpc>,
  mappings: Map<string, PaseoAgentMapping>,
  swarms?: LocalSwarmSummary[],
): string | null {
  if (input.conversationId && CONV_ID_RE.test(input.conversationId.trim())) {
    return input.conversationId.trim();
  }
  if (input.agentId) {
    const reqAgent = input.agentId.trim();
    for (const m of mappings.values()) {
      if (m.agentId === reqAgent) return m.conversationId;
    }
  }
  if (input.workspaceId) {
    const targetWs = normalizeWorkspaceIdForMatch(input.workspaceId);
    const wsCandidates: PaseoAgentMapping[] = [];
    for (const m of mappings.values()) {
      if (m.workspaceId && normalizeWorkspaceIdForMatch(m.workspaceId) === targetWs) {
        wsCandidates.push(m);
      }
    }
    if (wsCandidates.length > 0) {
      wsCandidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      if (swarms && swarms.length > 0) {
        const swarmConvIds = new Set<string>();
        for (const sw of swarms) {
          swarmConvIds.add(sw.swarmId);
          for (const mem of sw.members) {
            if (mem.conversationId) swarmConvIds.add(mem.conversationId);
          }
        }
        const withSwarm = wsCandidates.find((c) => swarmConvIds.has(c.conversationId));
        if (withSwarm) return withSwarm.conversationId;
      }
      return wsCandidates[0]!.conversationId;
    }
  }
  return null;
}

function listAppDataBrainRoots(homeDir = os.homedir()): Array<{
  appData: string;
  brainDir: string;
  label: "agy-cli" | "antigravity-app" | "other";
}> {
  const out: Array<{ appData: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other" }> = [];
  const preferred: Array<{ name: string; label: "agy-cli" | "antigravity-app" }> = [
    { name: "antigravity-cli", label: "agy-cli" },
    { name: "antigravity", label: "antigravity-app" },
  ];
  const seen = new Set<string>();
  for (const item of preferred) {
    const appData = path.join(homeDir, ".gemini", item.name);
    const brainDir = path.join(appData, "brain");
    if (fsSync.existsSync(brainDir)) {
      seen.add(item.name);
      out.push({ appData, brainDir, label: item.label });
    }
  }
  try {
    const geminiDir = path.join(homeDir, ".gemini");
    for (const entry of fsSync.readdirSync(geminiDir)) {
      if (entry.startsWith(".") || seen.has(entry)) continue;
      const appData = path.join(geminiDir, entry);
      const brainDir = path.join(appData, "brain");
      if (fsSync.existsSync(brainDir)) {
        out.push({ appData, brainDir, label: "other" });
      }
    }
  } catch {
    // ignore
  }
  return out;
}

function readTailUtf8(filePath: string, tailBytes = 16 * 1024): string | null {
  try {
    const st = fsSync.statSync(filePath);
    if (!st.isFile() || st.size === 0) return null;
    const len = Math.min(st.size, tailBytes);
    const start = st.size - len;
    const fd = fsSync.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      fsSync.readSync(fd, buf, 0, len, start);
      const txt = buf.toString("utf8");
      return start > 0 ? txt.slice(txt.indexOf("\n") + 1) : txt;
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readMemberRuntimeState(
  appData: string,
  memberCid: string,
  raw: Record<string, unknown>,
): { status: "working" | "waiting" | "stopped" | "killed"; activity?: string } {
  if (raw.killed === true || String(raw.phase ?? "").toUpperCase() === "KILLED") {
    return { status: "killed" };
  }
  const phase = String(raw.phase ?? "").toUpperCase();
  if (phase === "STOPPED") return { status: "stopped" };

  if (memberCid && CONV_ID_RE.test(memberCid)) {
    const tp = path.join(appData, "brain", memberCid, ".system_generated", "logs", "transcript.jsonl");
    const tail = readTailUtf8(tp, 20 * 1024);
    if (tail) {
      const rows: Array<Record<string, unknown>> = [];
      for (const ln of tail.split("\n")) {
        if (!ln.trim()) continue;
        try {
          rows.push(JSON.parse(ln) as Record<string, unknown>);
        } catch {
          // ignore partial leading line
        }
      }
      let lastPlannerIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.type === "PLANNER_RESPONSE") {
          lastPlannerIdx = i;
          break;
        }
      }
      if (lastPlannerIdx >= 0) {
        const planner = rows[lastPlannerIdx]!;
        const tcs = Array.isArray(planner.tool_calls) ? (planner.tool_calls as Array<Record<string, unknown>>) : [];
        if (tcs.length === 0) {
          return { status: "waiting" };
        }
        const hasSwarmWait = tcs.some((tc) => String(tc?.name ?? "").toLowerCase() === "swarm_wait");
        const trailing = rows.slice(lastPlannerIdx + 1);
        if (hasSwarmWait) {
          const waitDone = trailing.some(
            (r) => r.type === "GENERIC" && String(r.status ?? "").toUpperCase() === "DONE",
          );
          if (waitDone) return { status: "waiting" };
        }
        const lastTc = tcs[tcs.length - 1];
        const tcName = typeof lastTc?.name === "string" ? lastTc.name : "";
        const tcArgs =
          lastTc?.args && typeof lastTc.args === "object"
            ? (lastTc.args as Record<string, unknown>)
            : {};
        const target =
          unquoteArg(tcArgs.Path) ||
          unquoteArg(tcArgs.AbsolutePath) ||
          unquoteArg(tcArgs.TargetFile) ||
          unquoteArg(tcArgs.toolSummary) ||
          unquoteArg(tcArgs.CommandLine) ||
          "";
        const shortTarget = target
          ? target.includes("/")
            ? path.basename(target)
            : target.slice(0, 48)
          : "";
        const activity = tcName
          ? shortTarget
            ? `${tcName} ${shortTarget}`
            : tcName
          : undefined;
        // If no planner step is still actively updating (stale > 5 min), treat as waiting.
        try {
          const mtimeMs = fsSync.statSync(tp).mtimeMs;
          if (Date.now() - mtimeMs > 5 * 60_000) {
            return { status: "waiting" };
          }
        } catch {
          // fall through
        }
        return { status: "working", activity };
      }
    }
  }
  const wake = String(raw.wake_mode ?? "").toLowerCase();
  if (wake === "working") return { status: "working" };
  return { status: "waiting" };
}

function discoverSwarmDirEntries(
  homeDir: string,
  bypassCache = false,
): Array<{ appData: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; cid: string }> {
  const now = Date.now();
  if (!bypassCache) {
    const cached = swarmDirIndexCache.get(homeDir);
    if (cached && now - cached.at < SWARM_DIR_INDEX_TTL_MS) {
      return cached.entries;
    }
  }
  const roots = listAppDataBrainRoots(homeDir);
  const seen = new Set<string>();
  const entries: Array<{ appData: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; cid: string }> = [];
  for (const { appData, brainDir, label } of roots) {
    let convIds: string[] = [];
    try {
      convIds = fsSync.readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const cid of convIds) {
      if (!CONV_ID_RE.test(cid) || seen.has(cid)) continue;
      const membersFile = path.join(brainDir, cid, ".system_generated", "swarm", "members.json");
      if (!fsSync.existsSync(membersFile)) continue;
      seen.add(cid);
      entries.push({ appData, brainDir, label, cid });
    }
  }
  swarmDirIndexCache.set(homeDir, { at: now, entries });
  return entries;
}

function readSingleSwarmSummary(
  entry: { appData: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; cid: string },
  mappings: Map<string, PaseoAgentMapping>,
): LocalSwarmSummary | null {
  const { appData, brainDir, label, cid } = entry;
  const sDir = path.join(brainDir, cid, ".system_generated", "swarm");
  const membersFile = path.join(sDir, "members.json");
  const rawMembers = readTextSafe(membersFile, 512 * 1024);
  if (!rawMembers) return null;
  try {
    const parsed = JSON.parse(rawMembers) as {
      title?: string;
      members?: Record<string, Record<string, unknown>>;
    };
    const memberEntries = parsed.members && typeof parsed.members === "object" ? Object.entries(parsed.members) : [];
    const boardFile = path.join(sDir, "board.jsonl");
    let postCount = 0;
    let updatedAtMs = 0;
    try {
      updatedAtMs = Math.max(updatedAtMs, fsSync.statSync(membersFile).mtimeMs);
    } catch {
      // ignore
    }
    if (fsSync.existsSync(boardFile)) {
      try {
        const st = fsSync.statSync(boardFile);
        updatedAtMs = Math.max(updatedAtMs, st.mtimeMs);
        if (st.size <= 4 * 1024 * 1024) {
          const boardText = fsSync.readFileSync(boardFile, "utf8");
          for (const ln of boardText.split("\n")) {
            if (ln.trim()) postCount += 1;
          }
        }
      } catch {
        // ignore
      }
    }
    const members: SwarmMemberSummary[] = [];
    let activeCount = 0;
    let waitingCount = 0;
    let killedCount = 0;
    for (const [mName, mObj] of memberEntries) {
      if (!mObj || typeof mObj !== "object") continue;
      const mCid = typeof mObj.conversation_id === "string" ? mObj.conversation_id : "";
      const runtime = readMemberRuntimeState(appData, mCid, mObj);
      const status = runtime.status;
      if (status === "working") activeCount += 1;
      else if (status === "killed") killedCount += 1;
      else waitingCount += 1;
      const mapped = mCid ? mappings.get(mCid) ?? null : null;
      members.push({
        name: mName,
        role: typeof mObj.role === "string" ? mObj.role : "worker",
        conversationId: mCid,
        model: typeof mObj.model === "string" ? mObj.model : String(mObj.applied_model ?? ""),
        status,
        wakeMode: typeof mObj.wake_mode === "string" ? mObj.wake_mode : "",
        lastReadSeq: typeof mObj.last_read_seq === "number" ? mObj.last_read_seq : 0,
        killed: Boolean(mObj.killed),
        paseoAgentId: mapped?.agentId ?? null,
        paseoWorkspaceId: mapped?.workspaceId ?? null,
        ...(runtime.activity ? { activity: runtime.activity } : {}),
      });
    }
    const rootMap = mappings.get(cid) ?? null;
    const hasPlan = fsSync.existsSync(path.join(sDir, "plan.json"));
    const hasOverview = hasPlan || fsSync.existsSync(path.join(sDir, "view.json"));
    return {
      swarmId: cid,
      title: (typeof parsed.title === "string" && parsed.title.trim()) || rootMap?.title || `Swarm ${cid.slice(0, 8)}`,
      appDataRoot: appData,
      appDataLabel: label,
      memberCount: members.length,
      activeCount,
      waitingCount,
      killedCount,
      postCount,
      hasOverview,
      hasPlan,
      updatedAtMs,
      paseoAgentId: rootMap?.agentId ?? null,
      paseoWorkspaceId: rootMap?.workspaceId ?? null,
      paseoTitle: rootMap?.title ?? null,
      members,
    };
  } catch {
    return null;
  }
}

export function listLocalSwarms(homeDir = os.homedir(), limit = 40, options?: { bypassCache?: boolean }): LocalSwarmSummary[] {
  const mappings = readPaseoAgentMappings(homeDir, { bypassCache: options?.bypassCache });
  const dirEntries = discoverSwarmDirEntries(homeDir, options?.bypassCache);
  const swarms: LocalSwarmSummary[] = [];
  for (const entry of dirEntries) {
    const summary = readSingleSwarmSummary(entry, mappings);
    if (summary) swarms.push(summary);
  }
  swarms.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return swarms.slice(0, limit);
}

export function readSwarmSnapshotDirect(
  conversationId: string,
  homeDir = os.homedir(),
  prelistedSwarms?: LocalSwarmSummary[],
): {
  swarmId: string;
  title: string;
  memberCount: number;
  activeCount: number;
  waitingCount: number;
  killedCount: number;
  postCount: number;
  updatedAtMs: number;
  paseoAgentId: string | null;
  paseoWorkspaceId: string | null;
  members: SwarmMemberSummary[];
  messages: SwarmBoardMessage[];
} | null {
  if (!CONV_ID_RE.test(conversationId)) return null;
  const swarms = prelistedSwarms ?? listLocalSwarms(homeDir, 100);
  const hit =
    swarms.find((s) => s.swarmId === conversationId) ??
    swarms.find((s) => s.members.some((m) => m.conversationId === conversationId)) ??
    null;
  if (!hit) return null;
  const boardFile = path.join(hit.appDataRoot, "brain", hit.swarmId, ".system_generated", "swarm", "board.jsonl");
  const messages: SwarmBoardMessage[] = [];
  const raw = readTextSafe(boardFile, 2 * 1024 * 1024);
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        messages.push({
          seq: typeof m.seq === "number" ? m.seq : messages.length + 1,
          agent: typeof m.agent === "string" ? m.agent : "unknown",
          text: typeof m.text === "string" ? m.text.slice(0, 2000) : "",
          time: typeof m.time === "string" ? m.time : "",
          kind: typeof m.kind === "string" ? m.kind : undefined,
          channel: typeof m.channel === "string" ? m.channel : undefined,
        });
      } catch {
        // skip torn line
      }
    }
  }
  return {
    swarmId: hit.swarmId,
    title: hit.title,
    memberCount: hit.memberCount,
    activeCount: hit.activeCount,
    waitingCount: hit.waitingCount,
    killedCount: hit.killedCount,
    postCount: messages.length,
    updatedAtMs: hit.updatedAtMs,
    paseoAgentId: hit.paseoAgentId,
    paseoWorkspaceId: hit.paseoWorkspaceId,
    members: hit.members,
    messages: messages.slice(-120),
  };
}

function unquoteArg(val: unknown): string {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

const WORKFLOW_SCAN_TTL_MS = 12_000;
const workflowScanCache = new Map<string, { at: number; runs: LocalWorkflowRun[] }>();

function resolveRipgrepExecutable(): string | null {
  for (const cand of ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]) {
    try {
      if (fsSync.existsSync(cand)) return cand;
    } catch {
      // continue
    }
  }
  return "rg";
}

function discoverWorkflowTranscriptPathsViaRg(
  roots: Array<{ brainDir: string; label: "agy-cli" | "antigravity-app" | "other" }>,
): Array<{ cid: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; mtimeMs: number }> | null {
  const rgBin = resolveRipgrepExecutable();
  if (!rgBin || roots.length === 0) return null;
  const brainDirs = roots.map((r) => r.brainDir);
  const res = spawnSync(
    rgBin,
    [
      "--hidden",
      "--no-ignore",
      "--max-depth",
      "4",
      "-l",
      "-F",
      "--no-messages",
      "-g",
      "transcript.jsonl",
      '"run_workflow"',
      ...brainDirs,
    ],
    {
      encoding: "utf8",
      timeout: 4500,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (res.error || (res.status !== 0 && res.status !== 1)) {
    return null;
  }
  const hits: Array<{ cid: string; brainDir: string; label: "agy-cli" | "antigravity-app" | "other"; mtimeMs: number }> = [];
  const seen = new Set<string>();
  const lines = String(res.stdout ?? "").split("\n");
  for (const rawPath of lines) {
    const tp = rawPath.trim();
    if (!tp) continue;
    const owner = roots.find((r) => tp.startsWith(r.brainDir + path.sep));
    if (!owner) continue;
    const rel = path.relative(owner.brainDir, tp);
    const cid = rel.split(path.sep)[0] ?? "";
    if (!CONV_ID_RE.test(cid) || seen.has(`${owner.brainDir}:${cid}`)) continue;
    try {
      const st = fsSync.statSync(tp);
      if (st.isFile() && st.size > 0 && st.size <= 32 * 1024 * 1024) {
        seen.add(`${owner.brainDir}:${cid}`);
        hits.push({ cid, brainDir: owner.brainDir, label: owner.label, mtimeMs: st.mtimeMs });
      }
    } catch {
      // skip
    }
  }
  return hits;
}

export function listLocalWorkflows(
  homeDir = os.homedir(),
  filterConversationId?: string | null,
  limit = 25,
  options?: { bypassCache?: boolean },
): LocalWorkflowRun[] {
  const now = Date.now();
  if (!filterConversationId && !options?.bypassCache) {
    const cached = workflowScanCache.get(homeDir);
    if (cached && now - cached.at < WORKFLOW_SCAN_TTL_MS) {
      return cached.runs.slice(0, limit);
    }
  }

  const mappings = readPaseoAgentMappings(homeDir);
  const roots = listAppDataBrainRoots(homeDir);
  let candidates: Array<{
    cid: string;
    brainDir: string;
    label: "agy-cli" | "antigravity-app" | "other";
    mtimeMs: number;
  }> = [];

  let totalDirCount = 0;
  const rootEntries: Array<{
    brainDir: string;
    label: "agy-cli" | "antigravity-app" | "other";
    entries: string[];
  }> = [];

  for (const { brainDir, label } of roots) {
    let entries: string[] = [];
    if (filterConversationId && CONV_ID_RE.test(filterConversationId)) {
      entries = fsSync.existsSync(path.join(brainDir, filterConversationId)) ? [filterConversationId] : [];
    } else {
      try {
        entries = fsSync.readdirSync(brainDir);
      } catch {
        continue;
      }
    }
    totalDirCount += entries.length;
    rootEntries.push({ brainDir, label, entries });
  }

  // On real user machines (hundreds/thousands of brain dirs), use fast ripgrep pre-filtering so
  // historical /run-workflow transcripts are never missed by a recency cap. Small dirs (tests)
  // stay on pure FS scan with zero external process dependency.
  const rgHits = !filterConversationId && totalDirCount > 120 ? discoverWorkflowTranscriptPathsViaRg(roots) : null;
  if (rgHits !== null) {
    candidates = rgHits;
  } else {
    for (const { brainDir, label, entries } of rootEntries) {
      for (const cid of entries) {
        if (!CONV_ID_RE.test(cid)) continue;
        const tp = path.join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
        try {
          const st = fsSync.statSync(tp);
          if (st.isFile() && st.size > 0 && st.size <= 32 * 1024 * 1024) {
            candidates.push({ cid, brainDir, label, mtimeMs: st.mtimeMs });
          }
        } catch {
          // skip
        }
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const runs: LocalWorkflowRun[] = [];
  const scannedCap = filterConversationId || rgHits !== null ? candidates.length : Math.min(candidates.length, 400);

  for (let i = 0; i < scannedCap && runs.length < limit; i++) {
    const cand = candidates[i]!;
    const tp = path.join(cand.brainDir, cand.cid, ".system_generated", "logs", "transcript.jsonl");
    const raw = readTextSafe(tp, 12 * 1024 * 1024);
    if (!raw || !raw.includes('"run_workflow"')) continue;
    const lines = raw.split("\n");
    const rootMap = mappings.get(cand.cid) ?? null;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      if (!line.includes('"run_workflow"') || !line.includes('"PLANNER_RESPONSE"')) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const stepIndex = typeof row.step_index === "number" ? row.step_index : li;
      const tcs = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      for (const rawTc of tcs) {
        if (!rawTc || typeof rawTc !== "object") continue;
        const tc = rawTc as Record<string, unknown>;
        if (tc.name !== "run_workflow") continue;
        const args = tc.args && typeof tc.args === "object" ? (tc.args as Record<string, unknown>) : {};
        const desc = unquoteArg(args.Description) || "Dynamic workflow";
        const scriptPath = unquoteArg(args.ScriptPath) || null;

        // Find matching tool result / background task log in following transcript steps
        let taskId: string | null = null;
        let logPath: string | null = null;
        let inlineResult = "";
        let explicitStatus: LocalWorkflowRun["status"] = "unknown";
        for (let look = li + 1; look < Math.min(lines.length, li + 10); look++) {
          const lLine = lines[look]!;
          if (lLine.includes('"PLANNER_RESPONSE"') || lLine.includes('"USER_INPUT"')) break;
          if (!lLine.includes('"GENERIC"')) continue;
          try {
            const gRow = JSON.parse(lLine) as Record<string, unknown>;
            const content = typeof gRow.content === "string" ? gRow.content : "";
            const tm = /task id:\s*([A-Za-z0-9_./-]+)/i.exec(content);
            const lm = /Task logs are available at:\s*file:\/\/([^\s\r\n]+)/i.exec(content);
            if (tm?.[1]) taskId = tm[1].trim();
            if (lm?.[1]) logPath = lm[1].trim();
            if (/Workflow\s+"[^"]+"\s+completed/i.test(content)) {
              explicitStatus = "completed";
              inlineResult = content;
            } else if (/Tool is running as a background task/i.test(content)) {
              explicitStatus = "running";
            } else if (gRow.status === "ERROR") {
              explicitStatus = "failed";
              inlineResult = content;
            }
            break;
          } catch {
            // continue
          }
        }
        // Fallback task log path: `.system_generated/tasks/task-<stepIndex+1>.log`
        if (!logPath) {
          const guessLog = path.join(cand.brainDir, cand.cid, ".system_generated", "tasks", `task-${stepIndex + 1}.log`);
          if (fsSync.existsSync(guessLog)) logPath = guessLog;
        }
        // Check later SYSTEM_MESSAGE completion notice for this taskId
        if (taskId) {
          for (let look = li + 1; look < lines.length; look++) {
            const sLine = lines[look]!;
            if (!sLine.includes(taskId) || !sLine.includes('"SYSTEM_MESSAGE"')) continue;
            if (/finished with result:/i.test(sLine)) explicitStatus = "completed";
            else if (/failed|was canceled/i.test(sLine)) explicitStatus = "failed";
            break;
          }
        }

        const rawLog = logPath ? readTextSafe(logPath, 2 * 1024 * 1024) ?? "" : "";
        const parsedLog = parseWorkflowTaskLog(rawLog || inlineResult);
        let updatedAtMs = cand.mtimeMs;
        if (logPath) {
          try {
            updatedAtMs = Math.max(updatedAtMs, fsSync.statSync(logPath).mtimeMs);
          } catch {
            // ignore
          }
        }
        const finalStatus =
          explicitStatus === "completed" || explicitStatus === "failed"
            ? explicitStatus
            : parsedLog.inferredStatus !== "unknown"
              ? parsedLog.inferredStatus
              : explicitStatus;

        const mapAgent = (a: (typeof parsedLog.agents)[number]) => {
          const m = a.childConversationId ? mappings.get(a.childConversationId) ?? null : null;
          return {
            ...a,
            paseoAgentId: m?.agentId ?? null,
            paseoWorkspaceId: m?.workspaceId ?? null,
          };
        };

        runs.push({
          id: `${cand.cid}:${stepIndex}`,
          conversationId: cand.cid,
          stepIndex,
          taskId,
          description: desc.slice(0, 240),
          scriptPath,
          logPath,
          status: finalStatus,
          phases: parsedLog.phases.map((p) => ({
            name: p.name,
            logs: p.logs,
            agents: p.agents.map(mapAgent),
          })),
          agents: parsedLog.agents.map(mapAgent),
          output: parsedLog.output || (inlineResult ? inlineResult.slice(0, 1200) : ""),
          logLineCount: parsedLog.logLineCount,
          updatedAtMs,
          appDataLabel: cand.label,
          paseoAgentId: rootMap?.agentId ?? null,
          paseoWorkspaceId: rootMap?.workspaceId ?? null,
          paseoTitle: rootMap?.title ?? null,
        });
      }
    }
  }

  runs.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (!filterConversationId) {
    workflowScanCache.set(homeDir, { at: Date.now(), runs });
  }
  return runs.slice(0, limit);
}

async function stopUpstreamChildOnly(): Promise<void> {
  const child = bridge.child;
  bridge.child = null;
  bridge.upstreamPort = null;
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

export async function disposeSwarmBoardBridge(): Promise<void> {
  await stopUpstreamChildOnly();
  const srv = bridge.proxyServer;
  bridge.proxyServer = null;
  bridge.proxyPort = null;
  if (srv) {
    await new Promise<void>((resolve) => {
      try {
        srv.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  if (bridge.fallbackLoaderDir) {
    try {
      fsSync.rmSync(bridge.fallbackLoaderDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    bridge.fallbackLoaderDir = null;
  }
}

async function ensureSwarmBoardBridgeStarted(forceRestart = false, homeDir = os.homedir()): Promise<void> {
  const located = locateOfficialSwarmBoard(homeDir);
  if (!located) {
    bridge.lastError = "Official Antigravity swarm_board sidecar not found under $HOME/.gemini/antigravity*/builtin/plugins/swarm/sidecars/swarm_board";
    return;
  }

  const checksumChanged =
    Boolean(bridge.upstreamChecksum) &&
    Boolean(located.checksum) &&
    bridge.upstreamChecksum !== located.checksum;
  const dirChanged = Boolean(bridge.upstreamDir) && bridge.upstreamDir !== located.dir;
  const childAlive = Boolean(bridge.child && bridge.child.exitCode === null && !bridge.child.killed && bridge.upstreamPort);
  const proxyAlive = Boolean(bridge.proxyServer && bridge.proxyPort);

  if (!forceRestart && !checksumChanged && !dirChanged && childAlive && proxyAlive) {
    return;
  }

  if (bridge.starting) {
    await bridge.starting;
    return;
  }

  bridge.starting = (async () => {
    try {
      if (forceRestart || checksumChanged || dirChanged || !childAlive) {
        if (bridge.child) bridge.restarts += 1;
        await stopUpstreamChildOnly();
        const upstreamPort = await allocateFreeLoopbackPort();
        const officialLoader = locateSidecarSdkRegisterLoader(homeDir);
        const loaderPath = officialLoader ?? ensureFallbackSidecarSdkLoader();
        bridge.sidecarSdkMode = officialLoader ? "official" : "fallback-shim";

        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:0",
          ANTIGRAVITY_CSRF_TOKEN: bridge.proxyToken,
          ANTIGRAVITY_SIDECAR_WEB_PORT: String(upstreamPort),
          SWARM_OVERVIEW: "true",
          SWARM_GRAPH_TAB: "true",
          SWARM_RAW_TAB: "true",
        };
        // Intentionally omit ANTIGRAVITY_EXECUTABLE_DATA_DIR so official main.mjs reads BOTH
        // $HOME/.gemini/antigravity-cli/brain and $HOME/.gemini/antigravity/brain seamlessly.
        delete childEnv.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
        delete childEnv.NODE_OPTIONS;

        const child = spawn(
          resolveNodeExecutable(),
          ["--import", pathToFileURL(loaderPath).href, path.join(located.dir, "main.mjs")],
          {
            cwd: located.dir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderrTail = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1024);
        });
        child.on("exit", (code, signal) => {
          if (bridge.child === child) {
            bridge.child = null;
            bridge.upstreamPort = null;
            if (code !== 0 && code !== null) {
              bridge.lastError = stderrTail.trim() || `swarm_board exited (${signal || code})`;
            }
          }
        });
        bridge.child = child;
        bridge.upstreamPort = upstreamPort;
        bridge.upstreamDir = located.dir;
        bridge.upstreamChecksum = located.checksum;

        const ready = await waitForHttpReady(upstreamPort, 6000);
        if (!ready) {
          bridge.lastError = stderrTail.trim() || `swarm_board failed to listen on 127.0.0.1:${upstreamPort}`;
          await stopUpstreamChildOnly();
          return;
        }
        bridge.lastError = null;
      }

      if (!bridge.proxyServer || !bridge.proxyPort) {
        const preloadBody = buildPaseoSwarmPreloadJs();
        const proxy = http.createServer((req, res) => {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");
          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }
          if (url.pathname === "/preload.js") {
            res.writeHead(200, {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.end(preloadBody);
            return;
          }
          if (url.pathname === "/_sidecar/get-conversation-metadata") {
            let body = "";
            req.on("data", (c) => {
              body += c.toString("utf8");
            });
            req.on("end", () => {
              let cid = "";
              try {
                cid = String((JSON.parse(body || "{}") as { conversationId?: string }).conversationId ?? "");
              } catch {
                cid = "";
              }
              const mapped = cid ? readPaseoAgentMappings(homeDir).get(cid) ?? null : null;
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(
                JSON.stringify({
                  title: mapped?.title ?? "",
                  response: { conversationMetadata: { metadata: { title: mapped?.title ?? "", projectId: "" } } },
                }),
              );
            });
            return;
          }
          if (!bridge.upstreamPort) {
            res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: bridge.lastError || "Swarm board upstream not running" }));
            return;
          }
          const upReq = http.request(
            {
              host: "127.0.0.1",
              port: bridge.upstreamPort,
              method: req.method,
              path: `${url.pathname}${url.search}`,
              headers: { ...req.headers, host: `127.0.0.1:${bridge.upstreamPort}` },
            },
            (upRes) => {
              const outHeaders: http.OutgoingHttpHeaders = { ...upRes.headers };
              delete outHeaders["x-frame-options"];
              res.writeHead(upRes.statusCode || 200, outHeaders);
              upRes.pipe(res);
            },
          );
          upReq.on("error", (err) => {
            res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: `Swarm board proxy error: ${err.message}` }));
          });
          req.pipe(upReq);
        });
        await new Promise<void>((resolve, reject) => {
          proxy.once("error", reject);
          proxy.listen(0, "127.0.0.1", () => {
            const addr = proxy.address();
            bridge.proxyServer = proxy;
            bridge.proxyPort = typeof addr === "object" && addr ? addr.port : null;
            resolve();
          });
        });
      }
    } catch (err) {
      bridge.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      bridge.starting = null;
    }
  })();

  await bridge.starting;
}

function readAgyVersionAndNativeSkills(homeDir = os.homedir()): {
  agyVersion: string | null;
  nativeSwarmSkillPath: string | null;
  runWorkflowSkillPath: string | null;
} {
  let agyVersion: string | null = null;
  const cacheJson = readTextSafe(path.join(homeDir, ".paseo", "vec-patches", "subharness-slash-cache.json"), 64 * 1024);
  if (cacheJson) {
    try {
      const parsed = JSON.parse(cacheJson) as { agy_version?: unknown };
      if (typeof parsed.agy_version === "string" && parsed.agy_version.trim()) {
        agyVersion = parsed.agy_version.trim();
      }
    } catch {
      // ignore
    }
  }
  const nativeSwarmCandidates = [
    path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "skills", "native_swarm", "SKILL.md"),
    path.join(homeDir, ".gemini", "antigravity", "builtin", "skills", "native_swarm", "SKILL.md"),
  ];
  const runWorkflowCandidates = [
    path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "skills", "run-workflow", "SKILL.md"),
    path.join(homeDir, ".gemini", "antigravity", "builtin", "skills", "run-workflow", "SKILL.md"),
  ];
  return {
    agyVersion,
    nativeSwarmSkillPath: nativeSwarmCandidates.find((p) => fsSync.existsSync(p)) ?? null,
    runWorkflowSkillPath: runWorkflowCandidates.find((p) => fsSync.existsSync(p)) ?? null,
  };
}

function buildBridgeStatus(homeDir = os.homedir()): SwarmBoardBridgeStatus {
  const located = locateOfficialSwarmBoard(homeDir);
  const meta = readAgyVersionAndNativeSkills(homeDir);
  const running = Boolean(
    bridge.child &&
      bridge.child.exitCode === null &&
      !bridge.child.killed &&
      bridge.upstreamPort &&
      bridge.proxyServer &&
      bridge.proxyPort,
  );
  const dir = bridge.upstreamDir ?? located?.dir ?? null;
  return {
    running,
    proxyUrl: running && bridge.proxyPort ? `http://127.0.0.1:${bridge.proxyPort}` : null,
    upstreamPort: running ? bridge.upstreamPort : null,
    upstreamDir: dir,
    upstreamChecksum: bridge.upstreamChecksum ?? located?.checksum ?? null,
    sidecarSdkMode: bridge.sidecarSdkMode,
    nativeSwarmSkillPath: meta.nativeSwarmSkillPath,
    runWorkflowSkillPath: meta.runWorkflowSkillPath,
    agyVersion: meta.agyVersion,
    features: {
      overview: true,
      graph: true,
      raw: true,
      hive: Boolean(dir && fsSync.existsSync(path.join(dir, "hive.js"))),
      gifExport: Boolean(dir && fsSync.existsSync(path.join(dir, "gif.js"))),
    },
    restarts: bridge.restarts,
    lastError: bridge.lastError,
  };
}

function httpGetText(
  urlStr: string,
  timeoutMs = 4000,
  maxBytes = 4 * 1024 * 1024,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < maxBytes) body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

function checkOverlayNativeSlashPassthrough(homeDir = os.homedir()): { ok: boolean; detail: string } {
  const overlayBase = path.join(homeDir, ".paseo", "vec-builtin-plugins");
  let promptPath = "";
  try {
    const activeJson = readTextSafe(path.join(overlayBase, "runtime-active.json"), 16 * 1024);
    if (activeJson) {
      const parsed = JSON.parse(activeJson) as { overlayRoot?: string };
      if (parsed.overlayRoot) {
        promptPath = path.join(parsed.overlayRoot, "antigravity-provider", "server", "internal", "prompt.ts");
      }
    }
  } catch {
    // fallback below
  }
  if (!promptPath || !fsSync.existsSync(promptPath)) {
    try {
      const vers = fsSync
        .readdirSync(overlayBase)
        .filter((v) => /^\d+\.\d+/.test(v))
        .sort()
        .reverse();
      if (vers[0]) {
        promptPath = path.join(overlayBase, vers[0], "antigravity-provider", "server", "internal", "prompt.ts");
      }
    } catch {
      // ignore
    }
  }
  const src = promptPath ? readTextSafe(promptPath, 512 * 1024) : null;
  if (!src) return { ok: false, detail: "antigravity-provider prompt.ts not found in overlay" };
  const hasNativeSwarm = /VEC_NATIVE_WORKFLOW_SLASH\s*=\s*new Set\(\[[\s\S]*?"swarm"/.test(src);
  const hasNativeRunWf = /VEC_NATIVE_WORKFLOW_SLASH\s*=\s*new Set\(\[[\s\S]*?"run-workflow"/.test(src);
  const noFakeSwarmDirective = !/<SWARM>\nThe user invoked/.test(src);
  const ok = hasNativeSwarm && hasNativeRunWf && noFakeSwarmDirective;
  return {
    ok,
    detail: ok
      ? `native passthrough active in ${path.basename(path.dirname(path.dirname(path.dirname(path.dirname(promptPath)))))}/prompt.ts`
      : `swarm=${hasNativeSwarm} run-workflow=${hasNativeRunWf} noFakeDirective=${noFakeSwarmDirective}`,
  };
}

function readSwarmDirectByConversationId(
  cid: string,
  homeDir: string,
  mappings: Map<string, PaseoAgentMapping>,
): LocalSwarmSummary | null {
  if (!CONV_ID_RE.test(cid)) return null;
  for (const { appData, brainDir, label } of listAppDataBrainRoots(homeDir)) {
    const membersFile = path.join(brainDir, cid, ".system_generated", "swarm", "members.json");
    if (fsSync.existsSync(membersFile)) {
      return readSingleSwarmSummary({ appData, brainDir, label, cid }, mappings);
    }
  }
  return null;
}

export async function handleInspectSwarmWorkflow(
  input: RpcInput<typeof inspectSwarmWorkflowRpc>,
  _context?: PluginHandlerContext,
  options?: { homeDir?: string },
): Promise<RpcOutput<typeof inspectSwarmWorkflowRpc>> {
  const startedAt = Date.now();
  const homeDir = options?.homeDir ?? os.homedir();
  const action = input.action ?? "status";
  const limit = input.limit ?? 30;
  const mappings = readPaseoAgentMappings(homeDir, {
    bypassCache: action === "probe" || action === "restart_board",
  });

  if (action === "ensure_board_server" || action === "probe" || action === "restart_board") {
    await ensureSwarmBoardBridgeStarted(action === "restart_board", homeDir);
  }

  // O(1) fast path for live card / header polling: avoid scanning all 1,100+ brain dirs when
  // the scoped conversation directly owns `.system_generated/swarm/members.json`.
  const hasExplicitScope = Boolean(input.conversationId || input.agentId || input.workspaceId);
  if (action === "inspect_swarm_snapshot" && hasExplicitScope) {
    const directCid = resolveConversationForRequest(input, mappings);
    if (directCid) {
      const directSummary = readSwarmDirectByConversationId(directCid, homeDir, mappings);
      if (directSummary) {
        const snap = readSwarmSnapshotDirect(directCid, homeDir, [directSummary]);
        const bridgeStatus = buildBridgeStatus(homeDir);
        return {
          ok: true,
          action,
          resolvedConversationId: directCid,
          bridge: bridgeStatus,
          swarms: [directSummary],
          workflows: [],
          activeSwarmSnapshot: snap,
          probe: null,
          message: `Swarm snapshot (${directSummary.title}) · ${directSummary.memberCount}m · ${directSummary.postCount}p`,
          durationMs: Date.now() - startedAt,
        };
      }
    }
  }

  const swarms = listLocalSwarms(homeDir, Math.max(limit, 50), {
    bypassCache: action === "probe" || action === "restart_board",
  });
  const resolvedConversationId = resolveConversationForRequest(input, mappings, swarms);
  const skipWorkflowScan =
    action === "inspect_swarm_snapshot" || action === "list_swarms" || action === "status";
  const cachedWorkflows = skipWorkflowScan ? (workflowScanCache.get(homeDir)?.runs.slice(0, limit) ?? []) : [];
  const workflows = skipWorkflowScan
    ? cachedWorkflows
    : listLocalWorkflows(
        homeDir,
        action === "list_workflows" ? resolvedConversationId : null,
        limit,
        { bypassCache: action === "restart_board" || action === "list_workflows" },
      );

  // For `inspect_swarm_snapshot` with an explicit agent/workspace/conversation scope, ONLY return
  // the swarm belonging to that scope (never silently substitute an unrelated workspace's swarm).
  const targetCid =
    action === "inspect_swarm_snapshot" && hasExplicitScope
      ? resolvedConversationId
      : (resolvedConversationId ?? swarms[0]?.swarmId ?? null);
  const activeSwarmSnapshot =
    targetCid &&
    (action === "inspect_swarm_snapshot" || action === "status" || action === "ensure_board_server")
      ? readSwarmSnapshotDirect(targetCid, homeDir, swarms)
      : null;

  const returnedSwarms = swarms.slice(0, limit);

  const bridgeStatus = buildBridgeStatus(homeDir);
  let probeResult: RpcOutput<typeof inspectSwarmWorkflowRpc>["probe"] = null;

  if (action === "probe") {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    checks.push({
      name: "official_swarm_board_assets",
      ok: Boolean(bridgeStatus.upstreamDir),
      detail: bridgeStatus.upstreamDir ?? "Missing official swarm_board directory",
    });
    checks.push({
      name: "native_swarm_skill",
      ok: Boolean(bridgeStatus.nativeSwarmSkillPath),
      detail: bridgeStatus.nativeSwarmSkillPath ?? "Missing native_swarm/SKILL.md",
    });
    checks.push({
      name: "run_workflow_skill",
      ok: Boolean(bridgeStatus.runWorkflowSkillPath),
      detail: bridgeStatus.runWorkflowSkillPath ?? "Missing run-workflow/SKILL.md",
    });
    const passthrough = checkOverlayNativeSlashPassthrough(homeDir);
    checks.push({
      name: "native_slash_passthrough",
      ok: passthrough.ok,
      detail: passthrough.detail,
    });

    let httpStatus: number | null = null;
    let preloadOk = false;
    let apiSwarmOk = false;
    if (bridgeStatus.running && bridgeStatus.proxyUrl) {
      try {
        const indexRes = await httpGetText(`${bridgeStatus.proxyUrl}/`);
        httpStatus = indexRes.status;
        checks.push({
          name: "swarm_board_index_http",
          ok: indexRes.status === 200 && indexRes.body.includes("swarm-board"),
          detail: `HTTP ${indexRes.status} (${indexRes.body.length} bytes)`,
        });
      } catch (err) {
        checks.push({
          name: "swarm_board_index_http",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const preRes = await httpGetText(`${bridgeStatus.proxyUrl}/preload.js`);
        preloadOk = preRes.status === 200 && preRes.body.includes("paseo-swarm-open-conversation");
        checks.push({
          name: "paseo_preload_bridge",
          ok: preloadOk,
          detail: `HTTP ${preRes.status} (${preRes.body.length} bytes)`,
        });
      } catch (err) {
        checks.push({
          name: "paseo_preload_bridge",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const sampleCid = targetCid ?? "00000000-0000-0000-0000-000000000000";
        const apiRes = await httpGetText(
          `${bridgeStatus.proxyUrl}/api/swarm?conversationId=${encodeURIComponent(sampleCid)}`,
        );
        const parsedApi = JSON.parse(apiRes.body) as { conversationId?: unknown };
        apiSwarmOk = apiRes.status === 200 && typeof parsedApi === "object" && parsedApi !== null;
        checks.push({
          name: "official_api_swarm",
          ok: apiSwarmOk,
          detail: `HTTP ${apiRes.status} (cid=${sampleCid.slice(0, 8)}, swarms=${swarms.length})`,
        });
      } catch (err) {
        checks.push({
          name: "official_api_swarm",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      checks.push({
        name: "swarm_board_bridge_running",
        ok: false,
        detail: bridgeStatus.lastError ?? "Bridge not running",
      });
    }

    const allOk = checks.every((c) => c.ok);
    probeResult = {
      ok: allOk,
      httpStatus,
      preloadOk,
      apiSwarmOk,
      nativeSlashPassthroughOk: passthrough.ok,
      checks,
    };
  }

  const ok =
    action === "probe"
      ? Boolean(probeResult?.ok)
      : action === "ensure_board_server" || action === "restart_board"
        ? bridgeStatus.running
        : true;

  return {
    ok,
    action,
    resolvedConversationId,
    bridge: bridgeStatus,
    swarms: returnedSwarms,
    workflows,
    activeSwarmSnapshot,
    probe: probeResult,
    message: ok
      ? `Swarm Bridge ${bridgeStatus.running ? `live (${bridgeStatus.proxyUrl})` : "standby"} · ${returnedSwarms.length} swarm(s) · ${workflows.length} workflow(s)`
      : `Swarm Bridge issue: ${bridgeStatus.lastError ?? "probe check failed"}`,
    durationMs: Date.now() - startedAt,
  };
}
