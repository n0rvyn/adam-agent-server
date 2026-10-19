/**
 * Centralized JSON Schema definitions for Fastify response serialization.
 *
 * These schemas must mirror the TypeScript types in src/shared/types.ts.
 * When a field is added to a type, add it here too — otherwise
 * fast-json-stringify will silently strip it from API responses.
 *
 * Convention: every object schema uses `additionalProperties: true` as a
 * safety net so that newly-added fields pass through even before the schema
 * is updated. The explicit property list still enables fast-json-stringify
 * optimizations for known fields.
 */

// ---------------------------------------------------------------------------
// Primitives & shared fragments
// ---------------------------------------------------------------------------

const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });

const errorResponse = {
  type: "object" as const,
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// TaskTemplate
// ---------------------------------------------------------------------------

const taskStepSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    prompt: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
    outputAs: { type: "string" },
    roleId: { type: "string" },
    autoSelectRole: { type: "boolean" },
    requirements: { type: "object", additionalProperties: true },
  },
};

const taskTemplateTriggerSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    cron: { type: "string" },
    event: { type: "string" },
  },
};

const taskTemplateSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    trigger: taskTemplateTriggerSchema,
    steps: { type: "array", items: taskStepSchema },
    agentPreference: { type: "string" },
    config: { type: "object", additionalProperties: true },
    tags: { type: "array", items: { type: "string" } },
    enabled: { type: "boolean" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const tokenUsageSchema = {
  type: "object" as const,
  properties: {
    input: { type: "number" },
    output: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// TaskRequirements / ExecutionProfile / AdmissionFailure (capability-aware routing)
// ---------------------------------------------------------------------------

const taskRequirementPathSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    path: { type: "string" },
    access: { type: "string", enum: ["ro", "rw"] },
  },
};

const roleOsCapabilitySchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    targets: { type: "array", items: { type: "string" } },
  },
};

const taskRequirementsSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    tools: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: taskRequirementPathSchema },
    osCapabilities: { type: "array", items: roleOsCapabilitySchema },
    network: { type: "boolean" },
    plugins: { type: "array", items: { type: "string" } },
  },
};

const taskExecutionProfileSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    allowedTools: { type: "array", items: { type: "string" } },
    disallowedTools: { type: "array", items: { type: "string" } },
    approvalRequired: { type: "array", items: { type: "string" } },
    osCapabilities: { type: "array", items: roleOsCapabilitySchema },
    additionalDirectories: { type: "array", items: { type: "object", additionalProperties: true } },
    cagPrompt: { type: "string" },
    learnedRules: {
      type: "object",
      additionalProperties: true,
      properties: {
        stylePreferences: { type: "array", items: { type: "string" } },
        avoidedActions: { type: "array", items: { type: "string" } },
        pinnedParameters: { type: "array", items: {
          type: "object",
          additionalProperties: true,
          properties: {
            tool: { type: "string" },
            params: { type: "object", additionalProperties: true },
            condition: { type: "string" },
            pinnedAt: { type: "number" },
          },
          required: ["tool", "params", "pinnedAt"],
        }},
      },
    },
    performanceScore: { type: "number" },
    model: { type: "string" },
    executionMode: { type: "string" },
  },
};

const taskConfigSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    model: { type: "string" },
    maxTurns: { type: "integer" },
    maxBudgetUsd: { type: "number" },
    timeout: { type: "integer" },
    effort: { type: "string" },
    requirements: taskRequirementsSchema,
    executionProfile: taskExecutionProfileSchema,
  },
};

const admissionFailureMissingSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    tools: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: taskRequirementPathSchema },
    osCapabilities: { type: "array", items: roleOsCapabilitySchema },
    plugins: { type: "array", items: { type: "string" } },
    network: { type: "boolean" },
  },
};

const admissionFailureCandidateSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    roleId: { type: "string" },
    name: { type: "string" },
    fitScore: { type: "number" },
    missing: admissionFailureMissingSchema,
  },
};

const admissionFailureSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    code: {
      type: "string",
      enum: [
        "ROLE_NOT_FOUND",
        "ROLE_TOOL_MISMATCH",
        "ROLE_PATH_SCOPE_MISMATCH",
        "ROLE_OS_CAPABILITY_MISMATCH",
        "ROLE_PLUGIN_MISMATCH",
        "ROLE_NETWORK_MISMATCH",
        "ROLE_SELECTION_AMBIGUOUS",
        "REQUIREMENTS_MISSING",
        "VALIDATION_ERROR",
      ],
    },
    message: { type: "string" },
    missing: admissionFailureMissingSchema,
    candidates: { type: "array", items: admissionFailureCandidateSchema },
  },
};

const taskSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    parentId: { type: "string" },
    status: { type: "string" },
    prompt: { type: "string" },
    originalPrompt: { type: "string" },
    config: taskConfigSchema,
    result: { type: "string" },
    error: { type: "string" },
    sdkSessionId: { type: "string" },
    roleId: { type: "string" },
    templateId: { type: "string" },
    createdAt: { type: "number" },
    startedAt: { type: "number" },
    completedAt: { type: "number" },
    costUsd: { type: "number" },
    tokenUsage: tokenUsageSchema,
    numTurns: { type: "number" },
    totalDurationMs: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// RoleProfile
// ---------------------------------------------------------------------------

const rolePreferencesSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    model: { type: "string" },
    effort: { type: "string" },
    maxTurns: { type: "number" },
  },
};

const roleProfileSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    source: { type: "string" },
    traits: { type: "array", items: { type: "string" } },
    background: { type: "string" },
    preferences: rolePreferencesSchema,
    learnedRules: {
      type: "object",
      additionalProperties: true,
      properties: {
        stylePreferences: { type: "array", items: { type: "string" } },
        avoidedActions: { type: "array", items: { type: "string" } },
        pinnedParameters: { type: "array", items: {
          type: "object",
          additionalProperties: true,
          properties: {
            tool: { type: "string" },
            params: { type: "object", additionalProperties: true },
            condition: { type: "string" },
            pinnedAt: { type: "number" },
          },
          required: ["tool", "params", "pinnedAt"],
        }},
      },
    },
    memoryStreamId: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "number" },
    lastActiveAt: { type: "number" },
    taskCount: { type: "number" },
    performanceScore: { type: "number" },
    role: { type: "string" },
    toolProfile: { type: "array", items: { type: "string" } },
    evaluationCriteria: { type: "object", additionalProperties: { type: "number" } },
    strategyPoolId: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// MemoryNode (sans embedding)
// ---------------------------------------------------------------------------

const memoryNodeSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    roleId: { type: "string" },
    type: { type: "string" },
    content: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    importance: { type: "number" },
    sourceType: { type: "string" },
    sourceTaskId: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    createdAt: { type: "number" },
    lastAccessed: { type: "number" },
    retrievedCount: { type: "number" },
    score: { type: "number" }, // computed field from Smallville scoring
  },
};

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

const strategySchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    role: { type: "string" },
    taskType: { type: "string" },
    name: { type: "string" },
    promptTemplate: { type: "string" },
    alpha: { type: "number" },
    beta: { type: "number" },
    totalTrials: { type: "number" },
    avgReward: { type: "number" },
    toolProfile: { type: "array", items: { type: "string" } },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

const goalSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    role: { type: "string" },
    metricType: { type: "string" },
    targetValue: { type: "number" },
    currentValue: { type: "number" },
    deadline: { type: "number" },
    budgetUsd: { type: "number" },
    status: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// Webhook (virtual, derived from TaskTemplate at runtime)
// ---------------------------------------------------------------------------

const webhookSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    name: { type: "string" },
    displayName: { type: "string" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    trigger: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// Composed response schemas — keyed by HTTP status code
// ---------------------------------------------------------------------------

export const responses = {
  // -- TaskTemplate --
  templateCreated: {
    200: { type: "object", properties: { templateId: { type: "string" } } },
    201: { type: "object", properties: { templateId: { type: "string" } } },
    400: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        failingStepIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  templateList: {
    200: { type: "object", properties: { templates: { type: "array", items: taskTemplateSchema } } },
  },
  templateDetail: {
    200: { type: "object", properties: { template: taskTemplateSchema } },
    404: errorResponse,
  },
  templateUpdated: {
    200: { type: "object", properties: { templateId: { type: "string" } } },
    400: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        failingStepIds: { type: "array", items: { type: "string" } },
      },
    },
    404: errorResponse,
  },
  templateDeleted: {
    200: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        deleted: { type: "boolean" },
        mode: { type: "string", enum: ["template_only", "with_tasks"] },
        deletedCounts: {
          type: "object",
          properties: {
            template: { type: "number" },
            templateExecutions: { type: "number" },
            tasks: { type: "number" },
          },
        },
      },
    },
    404: errorResponse,
    409: errorResponse,
  },
  templateRun: {
    200: {
      type: "object",
      properties: {
        executionId: { type: "string" },
        status: { type: "string" },
        monitorUrl: { type: "string" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    400: errorResponse,
    404: errorResponse,
  },

  // -- Task --
  taskCreated: {
    201: {
      type: "object",
      additionalProperties: true,
      properties: {
        taskId: { type: "string" },
        roleId: { type: "string" },
        fitScore: { type: "number" },
      },
    },
    400: admissionFailureSchema,
  },
  taskList: {
    200: { type: "object", properties: { tasks: { type: "array", items: taskSchema } } },
  },
  taskDetail: {
    200: { type: "object", properties: { task: taskSchema } },
    404: errorResponse,
  },
  taskAction: {
    200: { type: "object", additionalProperties: true, properties: { taskId: { type: "string" } } },
    400: errorResponse,
    404: errorResponse,
  },
  approvalAction: {
    200: { type: "object", properties: { approvalId: { type: "string" }, decision: { type: "string" } } },
    404: errorResponse,
  },

  // -- Agent --
  agentList: {
    200: { type: "object", properties: { roles: { type: "array", items: roleProfileSchema } } },
  },
  agentDetail: {
    200: { type: "object", properties: { agent: roleProfileSchema } },
    404: errorResponse,
  },
  agentCreated: {
    201: { type: "object", properties: { agent: roleProfileSchema } },
  },
  agentUpdated: {
    200: { type: "object", properties: { agent: roleProfileSchema } },
    404: errorResponse,
  },
  agentDeleted: {
    200: { type: "object", properties: { agentId: { type: "string" }, deleted: { type: "boolean" } } },
    400: errorResponse,
    404: errorResponse,
  },
  agentPersona: {
    200: { type: "object", properties: { persona: nullable({ type: "string" }) } },
    404: errorResponse,
  },

  // -- Memory --
  memoryList: {
    200: { type: "object", properties: { memories: { type: "array", items: memoryNodeSchema }, count: { type: "number" } } },
    404: errorResponse,
  },
  memoryQuery: {
    200: { type: "object", properties: { memories: { type: "array", items: memoryNodeSchema }, count: { type: "number" } } },
    404: errorResponse,
  },
  memoryCreated: {
    201: { type: "object", properties: { memory: memoryNodeSchema } },
    400: errorResponse,
    404: errorResponse,
  },
  memoryUpdated: {
    200: { type: "object", properties: { memoryId: { type: "string" }, updated: { type: "boolean" }, embeddingUpdated: { type: "boolean" } } },
    400: errorResponse,
    404: errorResponse,
  },
  memoryDeleted: {
    200: { type: "object", properties: { memoryId: { type: "string" }, deleted: { type: "boolean" } } },
    404: errorResponse,
  },

  // -- Strategy --
  strategyList: {
    200: { type: "object", properties: { strategies: { type: "array", items: strategySchema } } },
  },
  strategyProbabilities: {
    200: { type: "object", additionalProperties: true, properties: { role: { type: "string" }, taskType: { type: "string" }, stats: { type: "object", additionalProperties: true }, probabilities: { type: "object", additionalProperties: { type: "number" } } } },
  },

  // -- Goal --
  goalList: {
    200: { type: "object", properties: { goals: { type: "array", items: goalSchema } } },
  },
  goalDetail: {
    200: { type: "object", properties: { goal: goalSchema } },
    404: errorResponse,
  },
  goalCreated: {
    201: { type: "object", properties: { goal: goalSchema } },
    400: { ...errorResponse, additionalProperties: true, properties: { ...errorResponse.properties, errors: { type: "array", items: { type: "string" } }, warnings: { type: "array", items: { type: "string" } } } },
  },

  // -- Webhook --
  webhookTriggered: {
    202: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, executionId: { type: "string" }, templateId: { type: "string" } } },
    401: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
  webhookList: {
    200: { type: "object", properties: { webhooks: { type: "array", items: webhookSchema }, auth: { type: "string" } } },
  },

  // -- Auth --
  authVerify: {
    200: { type: "object", properties: { ok: { type: "boolean" } } },
    401: errorResponse,
  },
  authRotate: {
    200: { type: "object", properties: { apiKey: { type: "string" } } },
    401: errorResponse,
    409: errorResponse,
  },

  // -- Config --
  configGet: {
    200: {
      type: "object",
      additionalProperties: true,
      properties: {
        config: { type: "object", additionalProperties: { type: "object", additionalProperties: true, properties: { value: {}, mutable: { type: "boolean" } } } },
        mutable: { type: "array", items: { type: "string" } },
        restartRequired: { type: "array", items: { type: "string" } },
        sandbox: {
          type: "object",
          additionalProperties: true,
          properties: {
            platform: { type: "string" },
            available: { type: "boolean" },
          },
        },
        osCapabilities: {
          type: "object",
          additionalProperties: true,
          properties: {
            registry: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                  platform: { type: "string" },
                  status: { type: "string" },
                  availability: { type: "string" },
                  editable: { type: "boolean" },
                  supportsTargets: { type: "boolean" },
                  disabledReason: { type: "string" },
                  effectiveDisabledReason: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  configPatch: {
    200: {
      type: "object",
      additionalProperties: true,
      properties: {
        success: { type: "boolean" },
        updated: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
        message: { type: "string" },
      },
    },
  },

  // -- Health --
  healthz: {
    200: { type: "object", properties: { status: { type: "string" } } },
  },
  readyz: {
    200: { type: "object", properties: { status: { type: "string" }, checks: { type: "object", additionalProperties: { type: "boolean" } }, legacy_mcp_servers_count: { type: "number" } } },
    503: { type: "object", properties: { status: { type: "string" }, checks: { type: "object", additionalProperties: { type: "boolean" } }, legacy_mcp_servers_count: { type: "number" } } },
  },
} as const;
