import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  DEFAULT_RACE_CONFIG,
  buildRacePlanPreview,
  deriveRaceTitle,
  manageMultiModelRaceRpc,
  sanitizeRaceBranchSegment,
  type RaceConfig,
  type RaceContenderRecord,
  type RaceContenderSpec,
  type RaceDiffStats,
  type RaceGitContext,
  type RaceProfileOption,
  type RaceProjectOption,
  type RaceRecord,
} from "../shared/multi-model-race-contracts";

const execFileAsync = promisify(execFile);

type ManageRaceInput = RpcInput<typeof manageMultiModelRaceRpc>;
type ManageRaceOutput = RpcOutput<typeof manageMultiModelRaceRpc>;

const MAX_STORED_RACES = 60;
const EMPTY_DIFF_STATS: RaceDiffStats = {
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  aheadCommits: 0,
  dirty: false,
};

export interface MultiModelRaceHandlerDeps {
  paseoHome?: string;
  paseo?: PluginHandlerContext["paseo"];
  inspectGit?: (cwd: string) => Promise<RaceGitContext> | RaceGitContext;
  readDiffStats?: (worktreePath: string, baseRef: string | null) => Promise<RaceDiffStats> | RaceDiffStats;
}

function resolvePaseoHome(override?: string): string {
  return override || process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

function getRacesDir(paseoHome: string): string {
  return path.join(paseoHome, "vec-races");
}

function getLedgerPath(paseoHome: string): string {
  return path.join(getRacesDir(paseoHome), "races.json");
}

function getConfigPath(paseoHome: string): string {
  return path.join(getRacesDir(paseoHome), "config.json");
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const st = await fsp.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}

export async function loadRaceConfig(paseoHome: string): Promise<RaceConfig> {
  const out: RaceConfig = { ...DEFAULT_RACE_CONFIG };
  try {
    const raw = JSON.parse(await fsp.readFile(getConfigPath(paseoHome), "utf8")) as Record<string, unknown>;
    if (raw.defaultIsolation === "worktree" || raw.defaultIsolation === "local") {
      out.defaultIsolation = raw.defaultIsolation;
    }
    if (typeof raw.defaultBranchPrefix === "string" && raw.defaultBranchPrefix.trim()) {
      out.defaultBranchPrefix = sanitizeRaceBranchSegment(raw.defaultBranchPrefix, "race", 20);
    }
    if (typeof raw.maxContenders === "number" && Number.isInteger(raw.maxContenders)) {
      out.maxContenders = Math.max(2, Math.min(8, raw.maxContenders));
    }
    if (typeof raw.showNewWorkspaceTrigger === "boolean") {
      out.showNewWorkspaceTrigger = raw.showNewWorkspaceTrigger;
    }
  } catch {
    // defaults
  }
  return out;
}

export async function saveRaceConfig(
  paseoHome: string,
  patch?: Partial<RaceConfig>,
  reset = false,
): Promise<RaceConfig> {
  const next: RaceConfig = reset ? { ...DEFAULT_RACE_CONFIG } : await loadRaceConfig(paseoHome);
  if (patch?.defaultIsolation === "worktree" || patch?.defaultIsolation === "local") {
    next.defaultIsolation = patch.defaultIsolation;
  }
  if (typeof patch?.defaultBranchPrefix === "string" && patch.defaultBranchPrefix.trim()) {
    next.defaultBranchPrefix = sanitizeRaceBranchSegment(patch.defaultBranchPrefix, "race", 20);
  }
  if (typeof patch?.maxContenders === "number" && Number.isInteger(patch.maxContenders)) {
    next.maxContenders = Math.max(2, Math.min(8, patch.maxContenders));
  }
  if (typeof patch?.showNewWorkspaceTrigger === "boolean") {
    next.showNewWorkspaceTrigger = patch.showNewWorkspaceTrigger;
  }
  await atomicWriteJson(getConfigPath(paseoHome), next);
  return next;
}

export async function loadRacesLedger(paseoHome: string): Promise<RaceRecord[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(getLedgerPath(paseoHome), "utf8")) as {
      races?: unknown[];
    };
    if (!Array.isArray(raw.races)) return [];
    const out: RaceRecord[] = [];
    for (const item of raw.races) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.raceId !== "string" || !Array.isArray(r.contenders)) continue;
      out.push({
        raceId: r.raceId,
        title: String(r.title || r.raceId),
        prompt: String(r.prompt || ""),
        cwd: String(r.cwd || ""),
        projectName: String(r.projectName || path.basename(String(r.cwd || "")) || "workspace"),
        isolation: r.isolation === "local" ? "local" : "worktree",
        isolationNote: typeof r.isolationNote === "string" ? r.isolationNote : null,
        baseRef: typeof r.baseRef === "string" ? r.baseRef : null,
        branchPrefix: typeof r.branchPrefix === "string" ? r.branchPrefix : "race",
        createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
        createdBy: r.createdBy === "cli" || r.createdBy === "agent" ? r.createdBy : "ui",
        winnerWorkspaceId: typeof r.winnerWorkspaceId === "string" ? r.winnerWorkspaceId : null,
        archivedAt: typeof r.archivedAt === "string" ? r.archivedAt : null,
        contenders: (r.contenders as Array<Record<string, unknown>>).map((c, idx) => ({
          slotId: String(c.slotId || `c${idx + 1}`),
          slotSlug: typeof c.slotSlug === "string" ? c.slotSlug : undefined,
          profile: String(c.profile || `${c.provider || "agent"}/${c.model || "default"}`),
          provider: String(c.provider || ""),
          model: typeof c.model === "string" ? c.model : null,
          thinking: typeof c.thinking === "string" ? c.thinking : null,
          mode: typeof c.mode === "string" ? c.mode : null,
          branch: typeof c.branch === "string" ? c.branch : null,
          workspaceTitle: String(c.workspaceTitle || ""),
          workspaceId: typeof c.workspaceId === "string" ? c.workspaceId : null,
          agentId: typeof c.agentId === "string" ? c.agentId : null,
          worktreePath: typeof c.worktreePath === "string" ? c.worktreePath : null,
          status: String(c.status || "idle"),
          error: typeof c.error === "string" ? c.error : null,
          archived: Boolean(c.archived),
          updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
          diffStats: undefined,
        })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveRacesLedger(paseoHome: string, races: RaceRecord[]): Promise<void> {
  const sanitized = races.slice(0, MAX_STORED_RACES).map((r) => ({
    ...r,
    contenders: r.contenders.map(({ diffStats: _drop, ...rest }) => rest),
  }));
  await atomicWriteJson(getLedgerPath(paseoHome), { version: 1, races: sanitized });
}

export async function readPaseoAgentProfiles(paseoHome: string): Promise<RaceProfileOption[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(paseoHome, "config.json"), "utf8")) as {
      daemon?: { agentProfiles?: Array<Record<string, unknown>> };
    };
    const list = raw?.daemon?.agentProfiles;
    if (!Array.isArray(list)) return [];
    const out: RaceProfileOption[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const provider = String(item.provider || "").trim();
      const name = String(item.name || "").trim();
      if (!provider || !name) continue;
      out.push({
        id: String(item.id || name),
        name,
        provider,
        model: typeof item.model === "string" && item.model.trim() ? item.model.trim() : null,
        thinking:
          typeof item.thinkingOptionId === "string" && item.thinkingOptionId.trim()
            ? item.thinkingOptionId.trim()
            : null,
        mode: typeof item.modeId === "string" && item.modeId.trim() ? item.modeId.trim() : null,
        notes: typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function runGit(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf8",
      timeout: 4_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function inspectGitContextNode(cwd: string): Promise<RaceGitContext> {
  const abs = path.resolve(cwd);
  if (!(await isDirectory(abs))) {
    return { cwd: abs, isGit: false, repoRoot: null, currentBranch: null, defaultBaseRef: null };
  }
  const repoRoot = await runGit(["-C", abs, "rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    return { cwd: abs, isGit: false, repoRoot: null, currentBranch: null, defaultBaseRef: null };
  }
  const [br, sym] = await Promise.all([
    runGit(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  const currentBranch = br && br !== "HEAD" ? br : null;
  const defaultBaseRef = sym || currentBranch || "HEAD";
  return { cwd: abs, isGit: true, repoRoot, currentBranch, defaultBaseRef };
}

export async function readGitDiffStatsNode(
  worktreePath: string,
  baseRef: string | null,
): Promise<RaceDiffStats> {
  if (!worktreePath || !(await isDirectory(worktreePath))) return { ...EMPTY_DIFF_STATS };
  const stats: RaceDiffStats = { ...EMPTY_DIFF_STATS };
  const diffArgs = ["-C", worktreePath, "diff", "--shortstat"];
  if (baseRef) diffArgs.push(baseRef);
  const [statusOut, diffOut, aheadOut] = await Promise.all([
    runGit(["-C", worktreePath, "status", "--porcelain"]),
    runGit(diffArgs),
    baseRef ? runGit(["-C", worktreePath, "rev-list", "--count", `${baseRef}..HEAD`]) : Promise.resolve(null),
  ]);
  if (statusOut && statusOut.length > 0) stats.dirty = true;
  if (diffOut) {
    const fMatch = diffOut.match(/(\d+)\s+file/);
    const iMatch = diffOut.match(/(\d+)\s+insertion/);
    const dMatch = diffOut.match(/(\d+)\s+deletion/);
    if (fMatch) stats.filesChanged = Number.parseInt(fMatch[1], 10) || 0;
    if (iMatch) stats.insertions = Number.parseInt(iMatch[1], 10) || 0;
    if (dMatch) stats.deletions = Number.parseInt(dMatch[1], 10) || 0;
  }
  if (aheadOut) {
    const parsed = Number.parseInt(aheadOut, 10);
    if (Number.isFinite(parsed) && parsed >= 0) stats.aheadCommits = parsed;
  }
  return stats;
}

async function readRegisteredProjects(paseoHome: string): Promise<RaceProjectOption[]> {
  const projectsJsonPath = path.join(paseoHome, "projects", "projects.json");
  const out: RaceProjectOption[] = [];
  let entries: Array<Record<string, unknown>> = [];
  try {
    const raw = JSON.parse(await fsp.readFile(projectsJsonPath, "utf8")) as
      | Array<Record<string, unknown>>
      | { projects?: Array<Record<string, unknown>> };
    entries = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
  } catch {
    return out;
  }
  const seenCwds = new Set<string>();
  const resolved = await Promise.all(
    entries.map(async (raw): Promise<RaceProjectOption | null> => {
      try {
        if (raw.archivedAt) return null;
        const id = String(raw.projectId || raw.id || "").trim();
        const cwd = String(raw.rootPath || raw.path || raw.directory || raw.cwd || "").trim();
        if (!id || !cwd || !(await isDirectory(cwd))) return null;
        const name = String(raw.customName || raw.displayName || raw.name || path.basename(cwd) || id).trim();
        const isGit = raw.kind === "git";
        return {
          id,
          name,
          cwd,
          isGit,
          defaultBaseRef: null,
        };
      } catch {
        return null;
      }
    }),
  );
  for (const item of resolved) {
    if (!item || seenCwds.has(item.cwd)) continue;
    seenCwds.add(item.cwd);
    out.push(item);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function readAgentStatusIndex(paseoHome: string): Promise<
  Map<
    string,
    { status: string; archived: boolean; workspaceId: string | null; cwd: string | null; updatedAt: string | null }
  >
> {
  const map = new Map<
    string,
    { status: string; archived: boolean; workspaceId: string | null; cwd: string | null; updatedAt: string | null }
  >();
  const agentsRoot = path.join(paseoHome, "agents");
  let subdirs: string[];
  try {
    subdirs = await fsp.readdir(agentsRoot);
  } catch {
    return map;
  }
  await Promise.all(
    subdirs.map(async (subdir) => {
      const fullSub = path.join(agentsRoot, subdir);
      if (!(await isDirectory(fullSub))) return;
      let files: string[];
      try {
        files = (await fsp.readdir(fullSub)).filter((f) => f.endsWith(".json"));
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          try {
            const rec = JSON.parse(await fsp.readFile(path.join(fullSub, f), "utf8")) as Record<
              string,
              unknown
            >;
            const id = String(rec.id || "");
            if (!id) return;
            const archived = Boolean(rec.archivedAt);
            map.set(id, {
              status: archived ? "archived" : String(rec.status || "idle"),
              archived,
              workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : null,
              cwd: typeof rec.cwd === "string" ? rec.cwd : null,
              updatedAt:
                typeof rec.updatedAt === "string"
                  ? rec.updatedAt
                  : typeof rec.lastActivityAt === "string"
                    ? rec.lastActivityAt
                    : null,
            });
          } catch {
            // skip
          }
        }),
      );
    }),
  );
  return map;
}

async function resolveWorkspaceCwdOnDisk(paseoHome: string, workspaceId: string): Promise<string | null> {
  const candidates = [
    path.join(paseoHome, "projects", "workspaces.json"),
    path.join(paseoHome, "workspaces.json"),
  ];
  for (const filePath of candidates) {
    try {
      const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as
        | Array<Record<string, unknown>>
        | { workspaces?: Array<Record<string, unknown>> };
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.workspaces) ? raw.workspaces : [];
      const hit = list.find((w) => String(w?.workspaceId || w?.id || "") === workspaceId);
      if (!hit) continue;
      const dir = String(
        hit.workspaceDirectory || hit.workingDirectory || hit.sourceDirectory || hit.cwd || hit.path || "",
      ).trim();
      if (dir) return dir;
    } catch {
      // try next path
    }
  }
  return null;
}

async function enrichRaces(
  paseoHome: string,
  races: RaceRecord[],
  readDiffStats: (wt: string, baseRef: string | null) => Promise<RaceDiffStats> | RaceDiffStats,
  targetRaceId?: string,
): Promise<RaceRecord[]> {
  const filtered = targetRaceId
    ? races.filter((r) => r.raceId === targetRaceId || r.raceId.startsWith(targetRaceId))
    : races.slice(0, 20);
  if (filtered.length === 0) return [];
  const index = await readAgentStatusIndex(paseoHome);

  return Promise.all(
    filtered.map(async (race) => ({
      ...race,
      contenders: await Promise.all(
        race.contenders.map(async (c) => {
          const live = c.agentId ? index.get(c.agentId) : undefined;
          const archived = live ? live.archived : c.archived;
          const status = live ? live.status : c.status;
          const workspaceId = c.workspaceId || live?.workspaceId || null;
          const worktreePath =
            c.worktreePath ||
            live?.cwd ||
            (workspaceId ? await resolveWorkspaceCwdOnDisk(paseoHome, workspaceId) : null);
          const diffStats =
            race.isolation === "worktree" && worktreePath && !archived
              ? await readDiffStats(worktreePath, race.baseRef)
              : { ...EMPTY_DIFF_STATS };
          return {
            ...c,
            archived,
            status,
            workspaceId,
            worktreePath,
            updatedAt: live?.updatedAt ?? c.updatedAt ?? null,
            diffStats,
          };
        }),
      ),
    })),
  );
}

function buildRaceId(cwd: string, title: string, contenders: RaceContenderSpec[]): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const hash = crypto
    .createHash("sha1")
    .update(`${ts}:${cwd}:${title}:${contenders.map((c) => `${c.provider}/${c.model || ""}`).join(",")}`)
    .digest("hex")
    .slice(0, 6);
  return `race-${ts}-${hash}`;
}

export async function handleManageMultiModelRace(
  input: ManageRaceInput,
  deps: MultiModelRaceHandlerDeps = {},
): Promise<ManageRaceOutput> {
  const paseoHome = resolvePaseoHome(deps.paseoHome);
  const inspectGit = deps.inspectGit ?? inspectGitContextNode;
  const readDiffStats = deps.readDiffStats ?? readGitDiffStatsNode;

  let config = await loadRaceConfig(paseoHome);
  if (input.action === "configure") {
    config = await saveRaceConfig(paseoHome, input.config, false);
  } else if (input.action === "reset") {
    config = await saveRaceConfig(paseoHome, undefined, true);
  }

  const [profiles, projects] = await Promise.all([
    readPaseoAgentProfiles(paseoHome),
    readRegisteredProjects(paseoHome),
  ]);

  let targetCwd = (input.cwd || "").trim();
  if (!targetCwd && input.workspaceId) {
    targetCwd = (await resolveWorkspaceCwdOnDisk(paseoHome, input.workspaceId)) || "";
  }
  if (!targetCwd && projects.length > 0) {
    targetCwd = projects[0].cwd;
  }
  const gitContext = targetCwd ? await inspectGit(targetCwd) : null;

  const baseOutput = async (
    overrides: Partial<ManageRaceOutput> & { ok: boolean; error: string | null },
  ): Promise<ManageRaceOutput> => {
    const stored = await loadRacesLedger(paseoHome);
    const enriched = overrides.races ?? (await enrichRaces(paseoHome, stored, readDiffStats, input.raceId));
    const activeRaces = enriched.filter(
      (r) => !r.archivedAt && r.contenders.some((c) => !c.archived && c.status !== "archived"),
    ).length;
    return {
      ok: overrides.ok,
      action: input.action,
      error: overrides.error,
      ledgerPath: getLedgerPath(paseoHome),
      config,
      gitContext,
      profiles,
      projects,
      races: enriched,
      totalRaces: stored.length,
      activeRaces,
      preview: overrides.preview ?? null,
      launchedRace: overrides.launchedRace ?? null,
      archiveResult: overrides.archiveResult ?? null,
    };
  };

  if (input.action === "status" || input.action === "inspect" || input.action === "configure" || input.action === "reset") {
    return baseOutput({ ok: true, error: null });
  }

  if (input.action === "dry_run" || input.action === "launch") {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) {
      return baseOutput({ ok: false, error: "Prompt is required to launch a multi-model race." });
    }
    const contenders = input.contenders ?? [];
    if (contenders.length < 2) {
      return baseOutput({ ok: false, error: "Select at least 2 models or profiles to race in parallel." });
    }
    if (contenders.length > config.maxContenders) {
      return baseOutput({
        ok: false,
        error: `Selected ${contenders.length} contenders exceeds configured max (${config.maxContenders}).`,
      });
    }
    if (!targetCwd || !gitContext) {
      return baseOutput({ ok: false, error: "Target project directory is required." });
    }

    const effectiveCwd =
      (input.isolation || config.defaultIsolation) === "worktree" && gitContext.repoRoot
        ? gitContext.repoRoot
        : gitContext.cwd;
    const title = deriveRaceTitle(prompt, input.title);
    const raceId = buildRaceId(effectiveCwd, title, contenders);
    const preview = buildRacePlanPreview({
      raceId,
      title,
      cwd: effectiveCwd,
      isGit: gitContext.isGit,
      requestedIsolation: input.isolation ?? config.defaultIsolation,
      baseRef: (input.baseRef || "").trim() || gitContext.defaultBaseRef,
      branchPrefix: (input.branchPrefix || "").trim() || config.defaultBranchPrefix,
      contenders,
    });

    if (input.action === "dry_run") {
      return baseOutput({ ok: true, error: null, preview });
    }

    const paseoApi = deps.paseo;
    if (!paseoApi?.workspaces?.create) {
      return baseOutput({
        ok: false,
        error: "Paseo server SDK workspaces.create is unavailable in this runtime.",
        preview,
      });
    }

    const createdContenders = await Promise.all(
      preview.contenders.map(async (slot): Promise<RaceContenderRecord> => {
        const rec: RaceContenderRecord = {
          slotId: slot.slotId,
          slotSlug: slot.slotSlug,
          profile: slot.profile,
          provider: slot.provider,
          model: slot.model,
          thinking: slot.thinking,
          mode: slot.mode,
          branch: slot.branch,
          workspaceTitle: slot.workspaceTitle,
          workspaceId: null,
          agentId: null,
          worktreePath: null,
          status: "failed",
          error: null,
          archived: false,
          updatedAt: new Date().toISOString(),
        };
        try {
          const wsSource =
            preview.isolation === "worktree" && slot.branch
              ? {
                  kind: "worktree" as const,
                  cwd: preview.cwd,
                  action: "branch-off" as const,
                  branchName: slot.branch,
                  ...(preview.baseRef ? { refName: preview.baseRef } : {}),
                }
              : {
                  kind: "directory" as const,
                  path: preview.cwd,
                };
          const createdWs = await paseoApi.workspaces.create({
            title: slot.workspaceTitle,
            source: wsSource,
          } as Parameters<typeof paseoApi.workspaces.create>[0]);
          rec.workspaceId = createdWs.id;

          const providerRef = slot.model ? `${slot.provider}/${slot.model}` : slot.provider;
          const labels: Record<string, string> = {
            "race-id": preview.raceId,
            "race-slot": slot.slotId,
            "race-contender": slot.slotSlug,
            "race-isolation": preview.isolation,
            "relation-kind": "race-contender",
          };
          if (preview.baseRef) labels["race-base"] = preview.baseRef;

          const agentConfig: Record<string, unknown> = {
            provider: providerRef,
          };
          if (slot.mode) agentConfig.modeId = slot.mode;
          if (slot.thinking) agentConfig.thinkingOptionId = slot.thinking;

          const wsRef =
            typeof (createdWs as { agents?: { create?: unknown } }).agents?.create === "function"
              ? createdWs
              : paseoApi.workspaces.ref(createdWs.id);
          const createdAgent = await (
            wsRef.agents.create as unknown as (opts: Record<string, unknown>) => Promise<{
              id: string;
              send?: (text: string) => Promise<unknown>;
            }>
          )({
            title: slot.workspaceTitle,
            config: agentConfig,
            labels,
          });
          if (typeof createdAgent.send === "function") {
            await createdAgent.send(prompt);
          }
          rec.agentId = createdAgent.id;
          rec.worktreePath =
            (createdWs as { directory?: string | null }).directory ||
            (await resolveWorkspaceCwdOnDisk(paseoHome, createdWs.id)) ||
            preview.cwd;
          rec.status = "running";
          return rec;
        } catch (err) {
          rec.error = err instanceof Error ? err.message : String(err);
          return rec;
        }
      }),
    );

    const record: RaceRecord = {
      raceId: preview.raceId,
      title: preview.title,
      prompt,
      cwd: preview.cwd,
      projectName: path.basename(preview.cwd) || preview.cwd,
      isolation: preview.isolation,
      isolationNote: preview.isolationNote,
      baseRef: preview.baseRef,
      branchPrefix: preview.branchPrefix,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? "ui",
      winnerWorkspaceId: null,
      archivedAt: null,
      contenders: createdContenders,
    };

    const existing = (await loadRacesLedger(paseoHome)).filter((r) => r.raceId !== record.raceId);
    await saveRacesLedger(paseoHome, [record, ...existing]);

    const launchedCount = createdContenders.filter((c) => Boolean(c.agentId)).length;
    return baseOutput({
      ok: launchedCount > 0,
      error: launchedCount > 0 ? null : createdContenders[0]?.error ?? "Failed to launch contenders.",
      preview,
      launchedRace: record,
    });
  }

  if (input.action === "archive_losers") {
    const targetId = String(input.raceId || "").trim();
    if (!targetId) {
      return baseOutput({ ok: false, error: "raceId is required for archive_losers." });
    }
    const races = await loadRacesLedger(paseoHome);
    const target = races.find((r) => r.raceId === targetId || r.raceId.startsWith(targetId));
    if (!target) {
      return baseOutput({ ok: false, error: `Race not found: ${targetId}` });
    }
    const winnerWs = input.archiveAll ? null : (input.winnerWorkspaceId || "").trim() || null;
    if (!input.archiveAll && !winnerWs) {
      return baseOutput({ ok: false, error: "Provide winnerWorkspaceId or set archiveAll: true." });
    }
    if (winnerWs && !target.contenders.some((c) => c.workspaceId === winnerWs)) {
      return baseOutput({
        ok: false,
        error: `Winner workspace ${winnerWs} is not part of race ${target.raceId}.`,
      });
    }

    const errors: string[] = [];
    let archivedCount = 0;
    let keptCount = 0;
    for (const contender of target.contenders) {
      if (winnerWs && contender.workspaceId === winnerWs) {
        keptCount += 1;
        continue;
      }
      if (contender.archived || !contender.workspaceId) continue;
      try {
        if (deps.paseo?.workspaces?.ref) {
          await deps.paseo.workspaces.ref(contender.workspaceId).archive();
        } else {
          throw new Error("Paseo server SDK workspaces.ref().archive is unavailable");
        }
        contender.archived = true;
        contender.status = "archived";
        archivedCount += 1;
      } catch (err) {
        errors.push(`${contender.slotId} (${contender.workspaceId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (winnerWs) target.winnerWorkspaceId = winnerWs;
    if (input.archiveAll) target.archivedAt = new Date().toISOString();
    await saveRacesLedger(paseoHome, races);

    return baseOutput({
      ok: errors.length === 0,
      error: errors.length > 0 ? errors[0] : null,
      archiveResult: {
        raceId: target.raceId,
        winnerWorkspaceId: winnerWs,
        archivedCount,
        keptCount,
        errors,
      },
    });
  }

  return baseOutput({ ok: false, error: `Unsupported action: ${String(input.action)}` });
}
