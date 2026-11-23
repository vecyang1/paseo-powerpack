import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const IntakeDecisionOptionSchema = z.object({
  index: z.number(),
  label: z.string(),
  recommended: z.boolean(),
});

export type IntakeDecisionOption = z.infer<typeof IntakeDecisionOptionSchema>;

export const IntakeDecisionItemSchema = z.object({
  taskId: z.string(),
  shortId: z.string(),
  state: z.string(),
  title: z.string(),
  priority: z.string(),
  kind: z.string(),
  profile: z.string(),
  agentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  agentLiveStatus: z.string().optional(),
  resumable: z.boolean(),
  decisionRounds: z.number(),
  finishedAt: z.string().nullable().optional(),
  url: z.string(),
  report: z.string(),
  summary: z.string(),
  checkpoints: z.array(z.string()),
  options: z.array(IntakeDecisionOptionSchema),
  bucket: z.string(),
});

export type IntakeDecisionItem = z.infer<typeof IntakeDecisionItemSchema>;

export const IntakeAnswerPreviewSchema = z.object({
  mode: z.string(),
  taskId: z.string(),
  shortId: z.string(),
  title: z.string(),
  agentId: z.string().nullable().optional(),
  agentStatus: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  profile: z.string().nullable().optional(),
  round: z.number().nullable().optional(),
  maxDecisionRounds: z.number().nullable().optional(),
  decisionText: z.string(),
  nextReport: z.string().nullable().optional(),
  promptPreview: z.string().nullable().optional(),
});

export type IntakeAnswerPreview = z.infer<typeof IntakeAnswerPreviewSchema>;

export const ExternalScanItemPreviewSchema = z.object({
  target: z.string(),
  subtype: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  reason: z.string().optional(),
});

export const ExternalScanSummarySchema = z.object({
  at: z.string().nullable().optional(),
  dryRun: z.boolean(),
  ran: z.array(z.string()),
  githubNotifications: z.number(),
  githubCreated: z.number(),
  githubAutoResolved: z.number(),
  githubSkipped: z.number(),
  emailScanned: z.number(),
  emailTier1: z.number(),
  emailSpawned: z.number(),
  errors: z.array(z.string()),
  items: z.array(ExternalScanItemPreviewSchema),
});

export type ExternalScanSummary = z.infer<typeof ExternalScanSummarySchema>;

export const manageIntakeDecisionsRpc = defineRpc({
  name: "finder.manage_intake_decisions",
  input: z.object({
    action: z
      .enum(["list", "preview_answer", "answer", "resolve_done", "tune_config", "scan_external"])
      .default("list"),
    refresh: z.boolean().optional(),
    taskId: z.string().optional(),
    choice: z.number().int().min(1).max(12).optional(),
    text: z.string().max(2000).optional(),
    configAction: z.enum(["show", "set", "reset"]).optional(),
    configKey: z.string().optional(),
    configValue: z.string().optional(),
    dryRun: z.boolean().optional(),
    sources: z.string().optional(),
    force: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    available: z.boolean(),
    action: z.enum(["list", "preview_answer", "answer", "resolve_done", "tune_config", "scan_external"]),
    generatedAt: z.string().nullable().optional(),
    totalTasks: z.number(),
    actionableBlockedCount: z.number(),
    supersededDuplicateCount: z.number(),
    concernsCount: z.number(),
    doneCount: z.number(),
    maxDecisionRounds: z.number(),
    maxConcurrent: z.number(),
    externalScanEnabled: z.boolean(),
    includeSources: z.array(z.string()),
    githubScanIntervalMinutes: z.number(),
    emailScanIntervalMinutes: z.number(),
    lastExternalScanAt: z.string().nullable().optional(),
    externalScan: ExternalScanSummarySchema.nullable().optional(),
    items: z.array(IntakeDecisionItemSchema),
    preview: IntakeAnswerPreviewSchema.nullable().optional(),
    message: z.string(),
    durationMs: z.number(),
  }),
});
