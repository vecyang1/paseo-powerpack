import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const RaceIsolationSchema = z.enum(["worktree", "local"]);
export type RaceIsolation = z.infer<typeof RaceIsolationSchema>;

export const RaceConfigSchema = z.object({
  defaultIsolation: RaceIsolationSchema.default("worktree"),
  defaultBranchPrefix: z.string().min(1).max(24).default("race"),
  maxContenders: z.number().int().min(2).max(8).default(6),
  showNewWorkspaceTrigger: z.boolean().default(true),
});
export type RaceConfig = z.infer<typeof RaceConfigSchema>;

export const DEFAULT_RACE_CONFIG: RaceConfig = {
  defaultIsolation: "worktree",
  defaultBranchPrefix: "race",
  maxContenders: 6,
  showNewWorkspaceTrigger: true,
};

export const RaceContenderSpecSchema = z.object({
  profileId: z.string().optional(),
  profile: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
});
export type RaceContenderSpec = z.infer<typeof RaceContenderSpecSchema>;

export const RaceProfileOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  mode: z.string().nullable(),
  notes: z.string().nullable(),
});
export type RaceProfileOption = z.infer<typeof RaceProfileOptionSchema>;

export const RaceProjectOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  isGit: z.boolean(),
  defaultBaseRef: z.string().nullable(),
});
export type RaceProjectOption = z.infer<typeof RaceProjectOptionSchema>;

export const RaceDiffStatsSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  aheadCommits: z.number().int().nonnegative(),
  dirty: z.boolean(),
});
export type RaceDiffStats = z.infer<typeof RaceDiffStatsSchema>;

export const RaceContenderRecordSchema = z.object({
  slotId: z.string(),
  slotSlug: z.string().optional(),
  profile: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  mode: z.string().nullable(),
  branch: z.string().nullable(),
  workspaceTitle: z.string(),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  archived: z.boolean(),
  updatedAt: z.string().nullable().optional(),
  diffStats: RaceDiffStatsSchema.optional(),
});
export type RaceContenderRecord = z.infer<typeof RaceContenderRecordSchema>;

export const RaceRecordSchema = z.object({
  raceId: z.string(),
  title: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  projectName: z.string(),
  isolation: RaceIsolationSchema,
  isolationNote: z.string().nullable().optional(),
  baseRef: z.string().nullable(),
  branchPrefix: z.string(),
  createdAt: z.string(),
  createdBy: z.enum(["ui", "cli", "agent"]).default("ui"),
  winnerWorkspaceId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  contenders: z.array(RaceContenderRecordSchema),
});
export type RaceRecord = z.infer<typeof RaceRecordSchema>;

export const RaceGitContextSchema = z.object({
  cwd: z.string(),
  isGit: z.boolean(),
  repoRoot: z.string().nullable(),
  currentBranch: z.string().nullable(),
  defaultBaseRef: z.string().nullable(),
});
export type RaceGitContext = z.infer<typeof RaceGitContextSchema>;

export const RacePlanPreviewItemSchema = z.object({
  slotId: z.string(),
  slotSlug: z.string(),
  profile: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  mode: z.string().nullable(),
  branch: z.string().nullable(),
  workspaceTitle: z.string(),
});
export type RacePlanPreviewItem = z.infer<typeof RacePlanPreviewItemSchema>;

export const RaceDryRunPreviewSchema = z.object({
  raceId: z.string(),
  title: z.string(),
  cwd: z.string(),
  isGit: z.boolean(),
  isolation: RaceIsolationSchema,
  isolationNote: z.string().nullable(),
  baseRef: z.string().nullable(),
  branchPrefix: z.string(),
  contenders: z.array(RacePlanPreviewItemSchema),
});
export type RaceDryRunPreview = z.infer<typeof RaceDryRunPreviewSchema>;

export const manageMultiModelRaceRpc = defineRpc({
  name: "finder.manage_multi_model_race",
  input: z.object({
    action: z.enum(["status", "dry_run", "launch", "inspect", "archive_losers", "configure", "reset"]),
    cwd: z.string().optional(),
    workspaceId: z.string().optional(),
    prompt: z.string().optional(),
    title: z.string().optional(),
    isolation: RaceIsolationSchema.optional(),
    baseRef: z.string().optional(),
    branchPrefix: z.string().optional(),
    contenders: z.array(RaceContenderSpecSchema).optional(),
    raceId: z.string().optional(),
    winnerWorkspaceId: z.string().optional(),
    archiveAll: z.boolean().optional(),
    createdBy: z.enum(["ui", "cli", "agent"]).optional(),
    config: z
      .object({
        defaultIsolation: RaceIsolationSchema.optional(),
        defaultBranchPrefix: z.string().optional(),
        maxContenders: z.number().int().min(2).max(8).optional(),
        showNewWorkspaceTrigger: z.boolean().optional(),
      })
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.string(),
    error: z.string().nullable(),
    ledgerPath: z.string(),
    config: RaceConfigSchema,
    gitContext: RaceGitContextSchema.nullable(),
    profiles: z.array(RaceProfileOptionSchema),
    projects: z.array(RaceProjectOptionSchema),
    races: z.array(RaceRecordSchema),
    totalRaces: z.number().int(),
    activeRaces: z.number().int(),
    preview: RaceDryRunPreviewSchema.nullable(),
    launchedRace: RaceRecordSchema.nullable(),
    archiveResult: z
      .object({
        raceId: z.string(),
        winnerWorkspaceId: z.string().nullable(),
        archivedCount: z.number().int(),
        keptCount: z.number().int(),
        errors: z.array(z.string()),
      })
      .nullable(),
  }),
});

export function sanitizeRaceBranchSegment(raw: string, fallback = "task", maxLen = 28): string {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-/]+|[.\-/]+$/g, "");
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLen).replace(/[.\-/]+$/g, "") || fallback;
}

export function deriveRaceTitle(prompt: string, explicitTitle?: string | null): string {
  const explicit = String(explicitTitle || "").trim();
  if (explicit) return explicit.slice(0, 64);
  const firstLine =
    String(prompt || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "Multi-model race";
  return firstLine.replace(/\s+/g, " ").slice(0, 56);
}

export function buildRacePlanPreview(input: {
  raceId: string;
  title: string;
  cwd: string;
  isGit: boolean;
  requestedIsolation: RaceIsolation;
  baseRef: string | null;
  branchPrefix: string;
  contenders: RaceContenderSpec[];
}): RaceDryRunPreview {
  const effectiveIsolation: RaceIsolation =
    input.requestedIsolation === "worktree" && !input.isGit ? "local" : input.requestedIsolation;
  const isolationNote =
    input.requestedIsolation === "worktree" && !input.isGit
      ? `${input.cwd} is not a git repository; using local workspace isolation`
      : null;
  const cleanPrefix = sanitizeRaceBranchSegment(input.branchPrefix || "race", "race", 20);
  const topicSlug = sanitizeRaceBranchSegment(input.title, "task", 24);
  const suffix = input.raceId.split("-").pop()?.slice(0, 6) || "run";
  const seenSlugs = new Map<string, number>();

  const planned: RacePlanPreviewItem[] = input.contenders.map((spec, idx) => {
    const baseSlug = sanitizeRaceBranchSegment(
      spec.profile || `${spec.provider}-${spec.model || idx + 1}`,
      `m${idx + 1}`,
      24,
    );
    const count = (seenSlugs.get(baseSlug) ?? 0) + 1;
    seenSlugs.set(baseSlug, count);
    const slotSlug = count === 1 ? baseSlug : `${baseSlug}-${count}`;
    const branch =
      effectiveIsolation === "worktree" ? `${cleanPrefix}/${topicSlug}-${slotSlug}-${suffix}` : null;
    const workspaceTitle = `Race · ${spec.profile} · ${input.title}`.slice(0, 68);
    return {
      slotId: `c${idx + 1}`,
      slotSlug,
      profile: spec.profile,
      provider: spec.provider,
      model: spec.model ?? null,
      thinking: spec.thinking ?? null,
      mode: spec.mode ?? null,
      branch,
      workspaceTitle,
    };
  });

  return {
    raceId: input.raceId,
    title: input.title,
    cwd: input.cwd,
    isGit: input.isGit,
    isolation: effectiveIsolation,
    isolationNote,
    baseRef: effectiveIsolation === "worktree" ? input.baseRef : null,
    branchPrefix: cleanPrefix,
    contenders: planned,
  };
}
