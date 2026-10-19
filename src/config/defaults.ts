import type { ServerConfig, NotifyTarget } from "../shared/types.js";
import { RUNTIME_DIR, DEFAULT_DENIED_READ_PATHS } from "../shared/constants.js";

export const DEFAULT_CONFIG: ServerConfig = {
  defaults: {
    timeout: 600,
    maxTurns: 400,  // Phase 2: raised from 100 to accommodate research-class tasks (task-013bb0f8 hit 200 ceiling)
    maxBudgetUsd: 5.0,
    effort: "high",
    model: "",  // Empty = let Claude Code CLI decide from ANTHROPIC_MODEL env var or its own default
    settingSources: ["user", "project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: ["rm -rf *", "git push*", "git reset*", "curl * -X POST*", "curl * --request POST*"],
    approvalTimeout: 600,
    env: {},
    plugins: [],
    workspacePath: RUNTIME_DIR,
    workspaceRetention: "immediate" as "immediate" | "on_restart" | number,
    deniedReadPaths: [...DEFAULT_DENIED_READ_PATHS],
  },
  externalApis: [],
  server: {
    port: 7100,
    host: "0.0.0.0",
    timezone: "system",  // IANA timezone string or "system" for OS default
  },
  identity: {
    ownerViewerKey: "local-owner",
  },
  logging: {
    level: "info",
  },
  roles: {
    presets: [],
    evolution: {
      triggerEvery: 5,
      reflectionThreshold: 150,
      retirementThreshold: 0.4,
      probationTasks: 5,
    },
  },
  chat: {
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
    contextBudgetTokens: 20000,
    artifactThresholdChars: 4000,
    maxConcurrentLiveSessions: 3,
    liveSessionIdleMinutes: 30,
    commitmentDetection: {
      locales: ["zh", "en"],
      blockedText: {
        zh: "任务已提交，完成后我会更新结果。",
        en: "Task dispatched; I will update you when it completes.",
      },
      unsupportedSuccessText: {
        zh: "图片已生成，发送状态还没有完成验证。",
        en: "Result is ready; delivery status is not yet verified.",
      },
      unsupportedFailureText: {
        zh: "图片已生成，但还没有执行发送。",
        en: "Result is ready, but delivery has not been attempted.",
      },
      unsupportedMutationText: {
        zh: "我没有完成这次记录，不能说已记录。需要先更新对应模板或配置后再确认。",
        en: "I did not actually record this. The template or config has not been updated yet.",
      },
    },
  },
  memory: {
    midTaskInjection: {
      enabled: true,
      toolCallThreshold: 10,
      cooldownMs: 60_000,
      topK: 3,
      maxTokens: 1000,
    },
    retrievalWeights: {
      cosSim: 0.4,
      recency: 0.2,
      tokenCost: 0.05,
    },
    globalBudgetTokens: 1500,
    retrievalDecayDays: 30,
    attributionThresholds: {
      high: 0.7,
      low: 0.4,
    },
    antiFlipMinUses: 5,
    antiFlipSuccessEmaThreshold: 0.25,
    reflection: { maxBudgetUsd: 5.0 },
    scope: {
      emaAlpha: 0.3,
      humanFeedbackWeight: 3.0,
      reflectionPoolMax: 100,
      decayBase: 0.995,
      archiveThreshold: 0.2,
    },
    embeddingModel: "bge-small-zh-v1.5",
  },
  watchdog: {
    enabled: true,
    intervalMinutes: 5,
    rules: {
      managerHealthCheck: { enabled: true, action: "restart", staleDurationMinutes: 15 },
      staleTasks: { enabled: true, action: "notify", maxPendingMinutes: 30 },
      staleRunningTasks: { enabled: true, action: "notify", maxRunningMinutes: 15 },
      staleTemplateExecutions: { enabled: true, action: "notify", maxOrphanMinutes: 60 },
      dbMaintenance: { enabled: true, action: "ignore", walCheckpointThresholdMB: 100 },
      artifactCleanup: { enabled: true, action: "ignore", ttlDays: 7, orphanGcMinAgeHours: 1 },
      sandboxViolation: { enabled: true, action: "alert" },
      reflectionJob: { enabled: true, intervalMinutes: 30 },
      memoryGc: {
        enabled: true,
        intervalHours: 24,
        observationTtlDays: 14,
      },
    },
  },
  execution: {
    maxConcurrent: 5,
    pollIntervalMs: 30_000,
  },
  anthropic: {
    apiKey: "",
    baseUrl: "",
    model: "",
    defaultOpusModel: "",
    defaultSonnetModel: "",
    defaultHaikuModel: "",
    smallFastModel: "",
  },
  emailGateway: {
    enabled: false,
    address: "",
    displayName: "Adam",
    imap: {
      host: "",
      port: 993,
      secure: true,
      auth: { user: "", pass: "" },
      mailbox: "INBOX",
    },
    smtp: {
      host: "",
      port: 465,
      secure: true,
      auth: { user: "", pass: "" },
      from: "",
    },
    subjectPrefix: "Adam",
  },
  audit: {
    intentEval: {
      maxBudgetUsd: 1.0,
      timeoutMs: 30_000,
    },
  },
  evaluation: {},
  delivery: {
    cronDefaultReportTo: null as NotifyTarget[] | null,
  },
  storage: {
    localProfile: "default",
  },
  pricing: {
    models: {
      // --- Anthropic (official; cacheRead=0.1x in, cacheCreation=1.25x in per docs) ---
      "claude-opus-4-7":   { input: 5,    output: 25,   cacheRead: 0.50,   cacheCreation: 6.25,  estimated: true },
      "claude-sonnet-4-6": { input: 3,    output: 15,   cacheRead: 0.30,   cacheCreation: 3.75,  estimated: true },
      "claude-haiku-4-5":  { input: 1,    output: 5,    cacheRead: 0.10,   cacheCreation: 1.25,  estimated: true },
      // --- DeepSeek (cacheRead = published cache-hit; cacheCreation defaulted to input) ---
      "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheCreation: 0.14,  estimated: true },
      "deepseek-v4-pro":   { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheCreation: 1.74,  estimated: true },
      // --- Volc Doubao (cacheRead from published 0.64元/M≈$0.094; cacheCreation defaulted to input) ---
      "doubao-seed-2.0-pro": { input: 0.47, output: 2.37, cacheRead: 0.094, cacheCreation: 0.47, estimated: true },
      // --- MiniMax (cache rates not separately published → defaulted to input) ---
      "minimax-m2":        { input: 0.26, output: 1.00, cacheRead: 0.26,   cacheCreation: 0.26,  estimated: true },
      // --- OpenAI (gpt-4.1 input/output $2/$8; verify) ---
      "gpt-4.1":           { input: 2,    output: 8,    cacheRead: 0.50,   cacheCreation: 2,     estimated: true },
      "gpt-4o":            { input: 2.5,  output: 10,   cacheRead: 1.25,   cacheCreation: 2.5,   estimated: true },
      // --- Google Gemini ---
      "gemini-2.5-pro":    { input: 1.25, output: 10,   cacheRead: 0.3125, cacheCreation: 1.25,  estimated: true },
      "gemini-2.5-flash":  { input: 0.30, output: 2.50, cacheRead: 0.075,  cacheCreation: 0.30,  estimated: true },
      // Note: a proxy (e.g. Volc Ark) may relabel models — your actual modelUsage wire keys may differ
      // from these names; set your observed keys + negotiated rates via ChatManager. Unset keys read "unknown".
    },
  },
  cost: {
    dailyThresholdUsd: 0,
  },
};
