import type {
  Task,
  Goal,
  Strategy,
  TaskTemplate,
  LogEntry,
  ReadyCheck,
  Role,
} from "@/lib/types";
import type { MistakePattern } from "@/lib/api";

export const mockTasks: Task[] = [
  {
    id: "task-001",
    status: "running",
    prompt: "Implement user authentication feature",
    roleId: "role-001",
    createdAt: Date.now() - 300_000,
    startedAt: Date.now() - 280_000,
    costUsd: 0.05,
    tokenUsage: { input: 5000, output: 2000 },
    numTurns: 3,
  },
  {
    id: "task-002",
    status: "pending",
    prompt: "Fix login button styling issue",
    createdAt: Date.now() - 60_000,
  },
  {
    id: "task-003",
    status: "completed",
    prompt: "Add dark mode support",
    result: "Successfully implemented dark mode",
    createdAt: Date.now() - 3_600_000,
    startedAt: Date.now() - 3_500_000,
    completedAt: Date.now() - 1_800_000,
    costUsd: 0.12,
    tokenUsage: { input: 8000, output: 5000 },
    numTurns: 5,
  },
  {
    id: "task-004",
    status: "failed",
    prompt: "Deploy to production",
    error: "Build failed: TypeScript compilation errors",
    createdAt: Date.now() - 7_200_000,
    costUsd: 0.02,
  },
  {
    id: "task-005",
    status: "queued",
    prompt: "Write unit tests for auth module",
    createdAt: Date.now() - 10_000,
  },
];

export const mockGoals: Goal[] = [
  {
    id: "goal-001",
    name: "Complete 50 tasks this week",
    description: "Weekly target for task completion",
    roleId: "role-001",
    metricType: "count",
    targetValue: 50,
    currentValue: 32,
    deadline: Date.now() + 259_200_000,
    budgetUsd: 500,
    status: "active",
    createdAt: Date.now() - 172_800_000,
  },
  {
    id: "goal-002",
    name: "Reduce latency to under 100ms",
    roleId: "role-001",
    metricType: "latency",
    targetValue: 100,
    currentValue: 150,
    deadline: Date.now() + 604_800_000,
    budgetUsd: 1000,
    status: "active",
    createdAt: Date.now() - 86_400_000,
  },
];

export const mockStrategies: Strategy[] = [
  {
    id: "strat-001",
    roleId: "role-001",
    taskType: "bug-fix",
    name: "Bug Fix Strategy v1",
    promptTemplate: "Fix the following bug: {prompt}",
    alpha: 1.5,
    beta: 2.0,
    totalTrials: 100,
    avgReward: 0.85,
    createdAt: Date.now() - 604_800_000,
  },
];

export const mockTemplates: TaskTemplate[] = [
  {
    id: "template-001",
    name: "Daily Standup Report",
    description: "Generate daily standup report",
    trigger: { type: "cron", cron: "0 9 * * *" },
    steps: [{ id: "step-1", prompt: "Summarize completed tasks" }],
    enabled: true,
    createdAt: Date.now() - 259_200_000,
  },
];

export const mockMultiStepTemplate: TaskTemplate = {
  id: "template-multi",
  name: "Multi-Role Pipeline",
  trigger: { type: "manual" },
  steps: [
    { id: "step-1", prompt: "Analyze data", config: { timeout: 120, maxTurns: 10 } },
    { id: "step-2", prompt: "Generate report", dependsOn: ["step-1"], roleId: "role-abc" },
  ],
  config: { continueOnError: true },
  enabled: true,
  createdAt: Date.now() - 86_400_000,
};

export const mockLogs: LogEntry[] = [
  {
    type: "log_event",
    timestamp: Date.now() - 5000,
    level: "info",
    component: "manager",
    msg: "Task dispatched to skill agent-001",
  },
  {
    type: "log_event",
    timestamp: Date.now() - 4000,
    level: "debug",
    component: "manager",
    msg: "Processing task step 1",
  },
  {
    type: "log_event",
    timestamp: Date.now() - 3000,
    level: "warn",
    component: "api",
    msg: "Rate limit approaching threshold",
  },
];

export const mockReadiness: ReadyCheck = {
  status: "ready",
  checks: {
    database: true,
    config: true,
  },
};

export const mockRoles: Role[] = [
  {
    id: "role-001",
    name: "Engineer",
    cagPrompt: "You are a senior engineer focused on clean code and tests.",
    learnedRules: { stylePreferences: ["Write tests first"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-001",
    status: "active",
    performanceScore: 0.92,
    preferences: { effort: "high" },
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: "role-002",
    name: "Reviewer",
    cagPrompt: "You are a code reviewer focused on security and quality.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-002",
    status: "inactive",
    preferences: {},
    createdAt: Date.now() - 172_800_000,
  },
];

export const mockMistakePatterns: MistakePattern[] = [
  {
    id: "mp-001",
    dimensionType: "event_type",
    dimensionValue: "audit:score_degradation",
    count: 5,
    roleIds: ["role-001", "role-002"],
    sampleEvidenceIds: [
      { source: "evolution_audit", id: "evo-001" },
      { source: "role_scores", id: "score-001" },
    ],
    status: "new",
    firstSeen: Date.now() - 604_800_000,
    lastSeen: Date.now() - 86_400_000,
    createdAt: Date.now() - 604_800_000,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    id: "mp-002",
    dimensionType: "tool_call_pattern",
    dimensionValue: "file-read on /etc/passwd",
    count: 3,
    roleIds: ["role-001"],
    sampleEvidenceIds: [{ source: "delivery_log", id: "dl-001" }],
    status: "acknowledged",
    firstSeen: Date.now() - 259_200_000,
    lastSeen: Date.now() - 172_800_000,
    createdAt: Date.now() - 259_200_000,
    updatedAt: Date.now() - 172_800_000,
  },
];
