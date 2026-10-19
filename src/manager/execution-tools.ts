import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// System MCP server name and tool prefix constants.
// The carve-out in hooks.ts uses EXECUTION_TOOLS_TOOL_PREFIX to auto-allow
// all tools under this MCP server. Any rename here forces hooks.ts to update too.
export const EXECUTION_TOOLS_MCP_NAME = "execution-tools";
export const EXECUTION_TOOLS_TOOL_PREFIX = "mcp__execution-tools__";

/**
 * Tools registered on the execution-tools MCP server that MUTATE state
 * (write artifacts, send external messages, escalate, commit memory, mutate role memory).
 * Single source of truth — consumed by preset role disallowedTools and the
 * fence test in src/__tests__/presets/preset-role-system-mcp-fence.test.ts.
 *
 * The execution-tools MCP server registers 12 tools total (see createExecutionTools
 * below): 7 mutation (this list) + 5 read-only (EXECUTION_TOOLS_READONLY_TOOLS).
 * The fence test introspects the live MCP registration and asserts every tool
 * is classified into one of the two lists — drift catches new tools automatically.
 *
 * If you add a new tool to this MCP server, classify it here OR in the read-only
 * sibling list. Forgetting either way fails the fence test.
 */
export const EXECUTION_TOOLS_MUTATION_TOOLS: readonly string[] = [
  "mcp__execution-tools__write_artifact",
  "mcp__execution-tools__publish_artifact_file",
  "mcp__execution-tools__send_to_channel",
  "mcp__execution-tools__report_blocked",
  "mcp__execution-tools__commit_claim",
  // From shared-tools.ts (spread into the MCP via createSharedMemoryTools at line ~179):
  "mcp__execution-tools__save_memory",
  "mcp__execution-tools__delete_memory",
];

/**
 * Tools registered on the execution-tools MCP server that do NOT mutate state.
 * Read-only roles (mistake-digester, feature-miner) MAY call these even though
 * the system-MCP carve-out auto-allows the namespace. The fence test asserts
 * these are NOT in disallowedTools — protects read capability for those presets.
 */
export const EXECUTION_TOOLS_READONLY_TOOLS: readonly string[] = [
  "mcp__execution-tools__list_channels",
  "mcp__execution-tools__read_artifact",
  "mcp__execution-tools__fetch_artifact_file",
  "mcp__execution-tools__list_artifacts",
  // From shared-tools.ts:
  "mcp__execution-tools__search_memories",
];

/**
 * Manifest of every tool registered on the execution-tools MCP server.
 * Hand-maintained AT THE SAME EDIT POINT as the tool() registration calls below
 * (and the shared-tools.ts spread). MUST equal the union of MUTATION + READONLY lists.
 *
 * The fence test asserts:
 *   - MUTATION ∪ READONLY == ALL_TOOL_NAMES (set equality — no orphans, no fictional entries)
 *   - MUTATION ∩ READONLY == ∅ (no double classification)
 *
 * Adding a new tool() registration requires three coordinated edits:
 *   (1) Add the tool() call below or in shared-tools.ts
 *   (2) Append its fully-namespaced name to this manifest
 *   (3) Append its name to either EXECUTION_TOOLS_MUTATION_TOOLS or _READONLY_TOOLS
 * Forgetting any of the three fails the fence test.
 */
export const EXECUTION_TOOLS_ALL_TOOL_NAMES: readonly string[] = [
  // Mutation (7):
  "mcp__execution-tools__write_artifact",
  "mcp__execution-tools__publish_artifact_file",
  "mcp__execution-tools__send_to_channel",
  "mcp__execution-tools__report_blocked",
  "mcp__execution-tools__commit_claim",
  "mcp__execution-tools__save_memory",
  "mcp__execution-tools__delete_memory",
  // Read-only (5):
  "mcp__execution-tools__list_channels",
  "mcp__execution-tools__read_artifact",
  "mcp__execution-tools__fetch_artifact_file",
  "mcp__execution-tools__list_artifacts",
  "mcp__execution-tools__search_memories",
];
import { v4 as uuidv4 } from "uuid";
import { getRole } from "../store/roles.js";
import { getRoleWorkspacePath } from "../store/role-workspace.js";
import { getTask, updateTask } from "../store/tasks.js";
import { serverBus } from "../server/events/server-bus.js";
import {
  appendArtifactToCollection,
  createArtifact,
  convertPrimaryFileToCollectionInTransaction,
  deleteArtifactById,
  getArtifact,
  isArtifactCollectionManifest,
  listArtifactsByExecution,
  type Artifact,
} from "../store/artifacts.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { getTaskTemplate } from "../store/task-templates.js";
import { logArtifactAccess } from "../store/artifact-access-log.js";
import {
  fetchBlob,
  publishBlob,
  publishBlobByKind,
  unlinkBlob,
  unlinkSourceFileStrict,
  validatePathInWorkspace,
} from "../lib/artifact-storage.js";
import { createSharedMemoryTools } from "./shared-tools.js";
import { localFilePathSchema, stepIdSchema } from "../lib/tool-schemas.js";
import { basename, extname, join } from "node:path";
import { statSync, writeFileSync } from "node:fs";
import { isStalePublish } from "../lib/artifact-freshness.js";
import { ensureArtifactsDir } from "../lib/artifact-storage.js";
import { isTextDeliverable } from "../lib/resolve-contract-rules.js";
import type { TaskStep } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";
import { writeClaims } from "../store/assistant-claims.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import { writeMutationReceipt } from "../audit/mutation-receipt-writer.js";
import type { ClaimSpec } from "../shared/types.js";
import { validateArtifact } from "../validators/index.js";
import { AssertionFailedError, NoHandlerError } from "../validators/errors.js";
import { createStepLog } from "../store/logs.js";
import { getDb } from "../store/db.js";

const log = getLogger("execution");

/**
 * D-003 + D-004: MCP server injected into ExecutionManager query().
 *
 * Provides execution-layer capabilities scoped to the Role. Non-template worker
 * tasks keep active channel communication through allowedChannels. TemplateExecution
 * step tasks produce artifacts and structured data; final delivery is owned by
 * TemplateExecution and OutboundGateway.
 */

export const KEY_REGEX = /^[\p{L}0-9._-]{1,256}$/u;
const STEP_ID_REGEX = /^[\p{L}0-9._-]{1,128}$/u;
const MAX_JSON_BYTES = 256 * 1024;
const MIME_REGEX = /^[a-z]+\/[a-z0-9.+-]+$/;

const EXT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".opus": "audio/opus", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf", ".zip": "application/zip", ".json": "application/json",
  ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".csv": "text/csv",
};

/**
 * Infer a MIME type from a file path's extension. Used when publish_artifact_file's caller omits
 * `mime` — a binary publish (audio/image) that ships with no mime breaks the contract verifier's
 * binary-skip (isTextMime(null)=true → bytes judged as text → spurious Layer B fail) and the
 * delivery layer's content typing. Inferring from the extension makes the right thing automatic
 * (harness engineering) instead of relying on every Role to remember the mime. Unknown → undefined.
 */
export function inferMimeFromPath(sourcePath: string): string | undefined {
  return EXT_MIME[extname(sourcePath).toLowerCase()];
}

/**
 * Match an outputContract.expectedArtifacts mime declaration against an actual mime.
 * A declared value ending in "/" is a prefix match ("audio/" matches audio/mpeg and
 * audio/mp3); otherwise an exact match. A missing actual mime never matches.
 */
function mimeMatches(declared: string, actual: string | undefined): boolean {
  if (!actual) return false;
  return declared.endsWith("/") ? actual.startsWith(declared) : actual === declared;
}

/** Shared: resolve channel name → channelId + chatId (same logic as adam-tools) */
async function resolveChannelTarget(channelName: string): Promise<{ channelId: string; chatId: string } | null> {
  const { listChannels: listAllChannels } = await import("../store/channels.js");
  const allChannels = listAllChannels();
  const { listSessions } = await import("../chat/session-manager.js");
  const allSessions = [...listSessions("active"), ...listSessions("archived")];
  const { getDefaultChatIdForChannel } = await import("../channels/target-resolution.js");

  const ch = allChannels.find((c) => c.name.toLowerCase().includes(channelName.toLowerCase()));
  if (!ch) return null;

  const chatId = getDefaultChatIdForChannel(ch, allSessions) ?? "";

  return { channelId: ch.id, chatId };
}

function toCallToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function validateKey(key: string): string | null {
  return KEY_REGEX.test(key)
    ? null
    : "Invalid artifact key. Use only letters, numbers, dot, underscore, or dash (1-256 chars).";
}

function validateStepId(stepId: string): string | null {
  return STEP_ID_REGEX.test(stepId)
    ? null
    : "Invalid stepId format. Use only letters, numbers, dot, underscore, or dash (1-128 chars).";
}

function requestedCollectionChildKey(argsKey: string, outputAs: string, sourcePath: string): string {
  return argsKey !== outputAs ? argsKey : basename(sourcePath);
}

interface TaskCtx {
  taskId: string;
  roleId: string;
  roleWorkspacePath: string;
}

interface TemplateExecutionCtx {
  executionId: string;
  stepId: string;
  roleId: string;
  roleWorkspacePath: string;
  taskId: string;
}

/**
 * Resolve step.outputAs for a given execution + step.
 * Returns null if execution or template not found (legacy back-compat).
 */
function resolveStepOutputAs(executionId: string, stepId: string): string | null {
  const exec = getTemplateExecution(executionId);
  if (!exec) return null;
  const template = getTaskTemplate(exec.templateId);
  if (!template) return null;
  const steps = template.steps as TaskStep[];
  const step = steps.find((s) => s.id === stepId);
  return step?.outputAs ?? null;
}

const isTemplateExecutionStepTask = (taskId?: string) => {
  if (!taskId) return false;
  const task = getTask(taskId);
  return !!(task?.parentId && task.templateId && task.stepId);
};

export function createExecutionTools(roleId: string, taskId?: string, onBlocked?: () => void) {
  // Load Role once for channel permission checks; template execution tools resolve the task role dynamically.
  const role = roleId ? getRole(roleId) : undefined;
  const doReportBlocked = onBlocked ?? (() => { /* no-op default */ });

  const resolveTaskCtx = async (): Promise<TaskCtx | { error: string }> => {
    if (!taskId) return { error: "artifact tools require a task context" };
    const task = getTask(taskId);
    if (!task) return { error: `task not found: ${taskId}` };
    const ctxRoleId = task.roleId ?? roleId;
    if (!ctxRoleId) return { error: "this template execution task has no role context" };
    const ctxRole = getRole(ctxRoleId);
    if (!ctxRole) return { error: `role not found: ${ctxRoleId}` };
    return {
      taskId,
      roleId: ctxRoleId,
      roleWorkspacePath: getRoleWorkspacePath(ctxRole.name),
    };
  };

  const resolveTemplateExecutionCtx = async (): Promise<TemplateExecutionCtx | { error: string }> => {
    const taskCtx = await resolveTaskCtx();
    if ("error" in taskCtx) return taskCtx;
    const task = getTask(taskCtx.taskId)!;
    if (!task.parentId) return { error: "this task is not a TemplateExecution step (no execution context)" };
    if (!task.stepId) return { error: "this task is not a TemplateExecution step (no step_id)" };
    return {
      executionId: task.parentId,
      stepId: task.stepId,
      roleId: taskCtx.roleId,
      roleWorkspacePath: taskCtx.roleWorkspacePath,
      taskId: taskCtx.taskId,
    };
  };

  const tools = [
    // Shared memory tools (search, save, delete) — scoped to executing role (RBAC, D-026)
    ...createSharedMemoryTools(roleId),

    tool("list_channels", "List all available channels. Use this to discover what channels can be used with send_to_channel.", {}, async () => {
      const { listChannels } = await import("../store/channels.js");
      const channels = listChannels();
      return toCallToolResult({
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          enabled: c.enabled,
          type: (c.config as Record<string, unknown>)?.type ?? "unknown",
        })),
      });
    }),

    tool("send_to_channel", "Send a message to a connected channel by name. This role can only send to channels in its allowedChannels list (if configured).", {
      channelName: z.string().describe("The channel name, e.g., 'WeChat on iPad' or 'Client Mail'"),
      message: z.string().describe("The message content to send"),
    }, async (args) => {
      // D-004 permission check: allowedChannels null=unrestricted, []=block all, string[]=whitelist
      if (role?.allowedChannels !== undefined) {
        if (role.allowedChannels.length === 0) {
          return toCallToolResult({ error: "This role is not allowed to send to any channels" });
        }
        const allowed = role.allowedChannels.some(
          (name) => name.toLowerCase() === args.channelName.toLowerCase(),
        );
        if (!allowed) {
          return toCallToolResult({ error: `Channel "${args.channelName}" is not in the allowed channels list for this role` });
        }
      }

      const resolved = await resolveChannelTarget(args.channelName);
      if (!resolved) {
        return toCallToolResult({ error: `Channel "${args.channelName}" not found or has no chatId available` });
      }

      const { getOutboundGateway } = await import("../delivery/outbound-gateway.js");
      const gateway = getOutboundGateway();
      const result = await gateway.send({ channelId: resolved.channelId, chatId: resolved.chatId, content: args.message, messageType: "reply" });
      return toCallToolResult({ success: result.success, channelName: args.channelName });
    }),

    tool(
      "write_artifact",
      "Persist a small structured value (JSON <= 256KB) for downstream TemplateExecution steps to read. USE THIS for: extracted fields, status flags, URL lists, summaries, structured key-value data. Do NOT use for: files (audio, video, reports). For files use publish_artifact_file instead.",
      {
        key: z.string().describe("Artifact key — a unique identifier for this value within the template execution."),
        value: z.unknown().describe("The JSON value to persist (must be <= 256KB serialized)."),
        priority: z.number().int().min(0).max(1000).optional().describe("Lower = higher priority for delivery packing. Use 10 for primary deliverables (audio/video), 50 for text/markdown, 100 for images. Omit to use server-side heuristic."),
      },
      async (args) => {
        const ctx = await resolveTemplateExecutionCtx();
        if ("error" in ctx) return toCallToolResult({ error: ctx.error });

        if (args.priority !== undefined && (args.priority < 0 || args.priority > 1000 || !Number.isInteger(args.priority))) {
          return toCallToolResult({ error: `Invalid priority: ${args.priority}. Must be an integer between 0 and 1000.` });
        }

        const keyError = validateKey(args.key);
        if (keyError) {
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "write_artifact",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: keyError,
          });
          return toCallToolResult({ error: keyError });
        }

        // Resolve step.outputAs and apply key enforcement (DP-001 Option C + DP-002 outputAs-required)
        const declaredOutputAs = resolveStepOutputAs(ctx.executionId, ctx.stepId);
        const exec = getTemplateExecution(ctx.executionId);
        const template = exec ? getTaskTemplate(exec.templateId) : null;
        const stepFoundInTemplate = template ? (template.steps as TaskStep[]).some((s) => s.id === ctx.stepId) : false;

        let effectiveKey = args.key;
        let keyOverrideNote: string | undefined;
        // Per DP-002 + threat model: reject when this step is found in a MIGRATED template (one
        // where at least one step has outputAs declared) but THIS step lacks outputAs.
        // Legacy templates (all steps without outputAs) stay in legacy-compat mode until migrated.
        const templateIsMigrated =
          template != null && (template.steps as TaskStep[]).some((s) => !!s.outputAs);
        if (declaredOutputAs === null && stepFoundInTemplate && templateIsMigrated) {
          // Step exists in a migrated template but has no outputAs declared — reject per DP-002
          const errorMsg = `Step "${ctx.stepId}" in template "${exec!.templateId}" has no outputAs declared. This template must be migrated before its steps can publish artifacts. Operator action required: run \`pnpm tsx scripts/migrate-all-templates-outputAs.ts --apply\` from the project root, or have the operator ask ChatManager in chat to upgrade the template.`;
          log.warn({ taskId: ctx.taskId, stepId: ctx.stepId, templateId: exec!.templateId }, "write_artifact: step has no outputAs in migrated template");
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "write_artifact",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: errorMsg,
          });
          return toCallToolResult({ error: errorMsg });
        }
        if (declaredOutputAs && args.key !== declaredOutputAs) {
          effectiveKey = declaredOutputAs;
          keyOverrideNote = `key '${args.key}' replaced with step.outputAs '${declaredOutputAs}'`;
          log.warn({ taskId: ctx.taskId, llmKey: args.key, outputAs: declaredOutputAs }, "write_artifact: server key override");
        }

        // D7: a string value under a markdown/text contract is stored as a raw text blob
        // (not JSON.stringify-wrapped, which would quote/escape the markdown). Everything
        // else (objects, json-format, bare strings) stays kind="json".
        const stepDef = (template?.steps as TaskStep[] | undefined)?.find((s) => s.id === ctx.stepId);
        const storeAsText = stepDef ? isTextDeliverable(stepDef, args.value) : false;

        try {
          const artifactId = uuidv4();
          let sizeBytes: number;
          let blobPath: string | undefined;
          if (storeAsText) {
            const text = args.value as string;
            sizeBytes = Buffer.byteLength(text, "utf8");
            if (sizeBytes > MAX_JSON_BYTES) {
              const error = `Artifact text exceeds ${MAX_JSON_BYTES} bytes`;
              logArtifactAccess({
                timestamp: Date.now(),
                taskId: ctx.taskId,
                roleId: ctx.roleId,
                executionId: ctx.executionId,
                stepId: ctx.stepId,
                tool: "write_artifact",
                artifactKey: args.key,
                sizeBytes,
                outcome: "denied",
                errorReason: error,
              });
              return toCallToolResult({ error });
            }
            blobPath = join(ensureArtifactsDir(ctx.executionId), `${artifactId}.bin`);
            writeFileSync(blobPath, text, "utf8");
          } else {
            const serialized = JSON.stringify(args.value);
            sizeBytes = Buffer.byteLength(serialized, "utf8");
            if (sizeBytes > MAX_JSON_BYTES) {
              const error = `Artifact JSON exceeds ${MAX_JSON_BYTES} bytes`;
              logArtifactAccess({
                timestamp: Date.now(),
                taskId: ctx.taskId,
                roleId: ctx.roleId,
                executionId: ctx.executionId,
                stepId: ctx.stepId,
                tool: "write_artifact",
                artifactKey: args.key,
                sizeBytes,
                outcome: "denied",
                errorReason: error,
              });
              return toCallToolResult({ error });
            }
          }

          createArtifact({
            id: artifactId,
            sourceKind: "template_step",
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            key: effectiveKey,
            ...(storeAsText
              ? { kind: "file" as const, blobPath, mime: "text/markdown", originalFilename: `${effectiveKey}.md` }
              : { kind: "json" as const, value: args.value }),
            sizeBytes,
            createdAt: Date.now(),
            roleId: ctx.roleId,
            priority: args.priority,
          });

          // Phase 4: write entity_mutation receipt
          writeMutationReceipt({
            toolName: "write_artifact",
            entityType: "artifact",
            verb: "create",
            entityId: artifactId,
            fieldChanges: [{ path: "_entity", op: "set", before: null, after: { artifactId, key: effectiveKey, kind: storeAsText ? "file" : "json", taskId: ctx.taskId } }],
            taskId: ctx.taskId,
            roleId: ctx.roleId,
          });

          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "write_artifact",
            artifactKey: effectiveKey,
            artifactId,
            sizeBytes,
            outcome: "success",
          });
          return toCallToolResult({
            success: true,
            artifactId,
            sizeBytes,
            ...(keyOverrideNote ? { note: keyOverrideNote } : {}),
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "write_artifact",
            artifactKey: args.key,
            outcome: "error",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }
      },
    ),

    tool(
      "read_artifact",
      "Read a structured value previously written by an upstream step's write_artifact. Returns the JSON value. For files, use fetch_artifact_file instead.",
      {
        stepId: stepIdSchema.describe("TemplateExecution step ID of the artifact's source step."),
        key: z.string().describe("Artifact key — a unique identifier for this value within the template execution."),
      },
      async (args) => {
        const ctx = await resolveTemplateExecutionCtx();
        if ("error" in ctx) return toCallToolResult({ error: ctx.error });

        const stepIdError = validateStepId(args.stepId);
        const keyError = validateKey(args.key);
        const validationError = stepIdError ?? keyError;
        if (validationError) {
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "read_artifact",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: validationError,
          });
          return toCallToolResult({ error: validationError });
        }

        const artifact = getArtifact(ctx.executionId, args.stepId, args.key);
        if (!artifact) {
          const error = `no artifact at ${args.stepId}/${args.key}`;
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "read_artifact",
            artifactKey: args.key,
            outcome: "error",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        if (artifact.kind !== "json") {
          const error = "artifact is a file; use fetch_artifact_file";
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "read_artifact",
            artifactKey: args.key,
            artifactId: artifact.id,
            sizeBytes: artifact.sizeBytes,
            outcome: "denied",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        logArtifactAccess({
          timestamp: Date.now(),
          taskId: ctx.taskId,
          roleId: ctx.roleId,
          executionId: ctx.executionId,
          stepId: ctx.stepId,
          tool: "read_artifact",
          artifactKey: args.key,
          artifactId: artifact.id,
          sizeBytes: artifact.sizeBytes,
          outcome: "success",
        });
        return toCallToolResult({ value: artifact.value, sizeBytes: artifact.sizeBytes });
      },
    ),

    // TODO(architecture): Lens-D review (2026-05-20) flagged that this tool's "must be called" contract
    // is a surface-level patch — the LLM forgetting to call it leaks files (memory
    // project_adam_podcast_fallback_delivery_drops_files; today the nudge path catches most cases
    // via task_files lookup). Root-cause fix: auto-publish on stop. ExecutionManager already records
    // every file the task wrote via the workspace-snapshot diff at task end (insertTaskFilesDiff).
    // When a TemplateExecution step has outputAs declared AND no artifact published AND task_files
    // has an unambiguous candidate (single added file with extension matching declared mime or
    // outputContract.format hint), we could auto-publish without needing a nudge round-trip.
    // This is deliberately NOT done in the current commit because: (a) "unambiguous candidate"
    // disambiguation policy needs design discussion (single-file vs largest-file vs mime-match),
    // (b) needs a new step_logs type for audit, (c) blast radius covers every template step in
    // production. Scope for a follow-up plan once task_files behavior has burned in.
    tool(
      "publish_artifact_file",
      "REQUIRED final action for any TemplateExecution step that produces a file deliverable. If your step declares outputAs and you finish work (writing audio/video/report/image to disk via Write, Edit, or Bash) WITHOUT calling this tool, the step is marked FAILED — downstream steps and delivery rules will not see your file, regardless of whether your work succeeded. \"I wrote a file to my workspace\" is NOT the same as \"I published an artifact\": the file must be registered through this call to count. Call this AFTER the file is fully written to disk, BEFORE ending your turn. The file is COPIED to template execution shared storage. USE for: generated audio, video, reports, images, large outputs. Do NOT use for small structured JSON values (<=256KB) — use write_artifact instead. sourcePath must be inside your role workspace (~/.adam/roles/<your-role>/...); if your file was written to an additionalDirectories location (InfoHub/PKOS/Code/etc.), Bash-copy it into the workspace first then publish from there. cleanup=true deletes the source after publish — only set when you no longer need the source file (the step becomes non-retryable through publish).",
      {
        key: z.string().describe("Artifact key — a unique identifier for this value within the template execution."),
        sourcePath: localFilePathSchema.describe("Source file path in the Role workspace to publish as a TemplateExecution artifact."),
        mime: z.string().optional().describe("MIME type of the file (e.g., 'image/png', 'audio/mp3'). Auto-detected if omitted."),
        cleanup: z.boolean().optional().describe("If true, delete the source file after publishing. Only use when the source file is no longer needed."),
        priority: z.number().int().min(0).max(1000).optional().describe("Lower = higher priority for delivery packing. Use 10 for primary deliverables (audio/video), 50 for text/markdown, 100 for images. Omit to use server-side heuristic."),
        role: z.string().optional().describe("Logical artifact role. REQUIRED when the step's outputContract declares expectedArtifacts — use one of the declared roles (e.g. 'podcast', 'song'). Publishing more than the declared count for a role, or an undeclared role, is rejected."),
      },
      async (args) => {
        const taskCtx = await resolveTaskCtx();
        if ("error" in taskCtx) return toCallToolResult({ error: taskCtx.error });

        if (args.priority !== undefined && (args.priority < 0 || args.priority > 1000 || !Number.isInteger(args.priority))) {
          return toCallToolResult({ error: `Invalid priority: ${args.priority}. Must be an integer between 0 and 1000.` });
        }

        const task = getTask(taskCtx.taskId)!;
        const isTemplateStep = !!(task.parentId && task.templateId && task.stepId);

        if (!isTemplateStep) {
          // === New task_published path ===
          if (args.mime && !MIME_REGEX.test(args.mime)) {
            return toCallToolResult({ error: `Invalid MIME type: ${args.mime}` });
          }
          try {
            validatePathInWorkspace(args.sourcePath, taskCtx.roleWorkspacePath, true);
          } catch (err) {
            return toCallToolResult({ error: err instanceof Error ? err.message : String(err) });
          }

          const artifactId = uuidv4();
          let blobPath: string | null = null;
          let artifactCreated = false;
          try {
            const published = publishBlobByKind({
              kind: "task",
              artifactId,
              sourcePath: args.sourcePath,
            });
            blobPath = published.blobPath;

            const newArtifact: Artifact = {
              id: artifactId,
              sourceKind: "task_published",
              taskId: taskCtx.taskId,
              roleId: taskCtx.roleId,
              kind: "file",
              blobPath,
              mime: args.mime ?? inferMimeFromPath(args.sourcePath),
              originalFilename: basename(args.sourcePath),
              sizeBytes: published.sizeBytes,
              createdAt: Date.now(),
              priority: args.priority,
            };
            createArtifact(newArtifact);
            artifactCreated = true;

            if (args.cleanup === true) {
              unlinkSourceFileStrict(args.sourcePath);
            }

            writeMutationReceipt({
              toolName: "publish_artifact_file",
              entityType: "artifact",
              verb: "create",
              entityId: artifactId,
              fieldChanges: [{ path: "_entity", op: "set", before: null, after: { artifactId, kind: "file", filename: basename(args.sourcePath), taskId: taskCtx.taskId, sourceKind: "task_published" } }],
              taskId: taskCtx.taskId,
              roleId: taskCtx.roleId,
            });

            log.info({ taskId: taskCtx.taskId, roleId: taskCtx.roleId, artifactId, sizeBytes: published.sizeBytes }, "publish_artifact_file task_published: success");
            return toCallToolResult({ success: true, artifactId, sizeBytes: published.sizeBytes });
          } catch (err) {
            if (artifactCreated) {
              try { deleteArtifactById(artifactId); } catch { /* best-effort */ }
            }
            if (blobPath) {
              try { unlinkBlob(blobPath); } catch { /* best-effort */ }
            }
            const error = err instanceof Error ? err.message : String(err);
            log.warn({ taskId: taskCtx.taskId, roleId: taskCtx.roleId, artifactId, err }, "publish_artifact_file task_published: failed");
            return toCallToolResult({ error });
          }
        }

        // === Existing template_step path ===
        const ctx: TemplateExecutionCtx = {
          executionId: task.parentId!,
          stepId: task.stepId!,
          roleId: taskCtx.roleId,
          roleWorkspacePath: taskCtx.roleWorkspacePath,
          taskId: taskCtx.taskId,
        };

        const keyError = validateKey(args.key);
        if (keyError) {
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: keyError,
          });
          return toCallToolResult({ error: keyError });
        }

        if (args.mime && !MIME_REGEX.test(args.mime)) {
          const error = `Invalid MIME type: ${args.mime}`;
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        // Resolve step.outputAs and apply key enforcement (DP-001 Option C + DP-002 outputAs-required)
        const declaredOutputAs = resolveStepOutputAs(ctx.executionId, ctx.stepId);
        const exec = getTemplateExecution(ctx.executionId);
        const template = exec ? getTaskTemplate(exec.templateId) : null;
        const stepDef = template ? (template.steps as TaskStep[]).find((s) => s.id === ctx.stepId) ?? null : null;
        const stepFoundInTemplate = stepDef != null;

        let effectiveKey = args.key;
        let keyOverrideNote: string | undefined;
        // Per DP-002 + threat model: reject when this step is found in a MIGRATED template (one
        // where at least one step has outputAs declared) but THIS step lacks outputAs.
        // Legacy templates (all steps without outputAs) stay in legacy-compat mode until migrated.
        const templateIsMigrated =
          template != null && (template.steps as TaskStep[]).some((s) => !!s.outputAs);
        if (declaredOutputAs === null && stepFoundInTemplate && templateIsMigrated) {
          // Step exists in a migrated template but has no outputAs declared — reject per DP-002
          const errorMsg = `Step "${ctx.stepId}" in template "${exec!.templateId}" has no outputAs declared. This template must be migrated before its steps can publish artifacts. Operator action required: run \`pnpm tsx scripts/migrate-all-templates-outputAs.ts --apply\` from the project root, or have the operator ask ChatManager in chat to upgrade the template.`;
          log.warn({ taskId: ctx.taskId, stepId: ctx.stepId, templateId: exec!.templateId }, "publish_artifact_file: step has no outputAs in migrated template");
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: errorMsg,
          });
          return toCallToolResult({ error: errorMsg });
        }
        if (declaredOutputAs && args.key !== declaredOutputAs) {
          effectiveKey = declaredOutputAs;
          keyOverrideNote = `key '${args.key}' replaced with step.outputAs '${declaredOutputAs}'`;
          log.warn({ taskId: ctx.taskId, llmKey: args.key, outputAs: declaredOutputAs }, "publish_artifact_file: server key override");
        }

        // D6: per-role expectedArtifacts enforcement removed. Contract granularity is the key;
        // `role` is accepted (transitional, ignored) but no longer gates publish. File quality is
        // checked post-publish by Track B (PostToolUse); failure unlinks + fails the step (D8).

        try {
          validatePathInWorkspace(args.sourcePath, ctx.roleWorkspacePath, true);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: effectiveKey,
            outcome: "denied",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        // Freshness guard (2026-06-03): a step's file deliverable must be PRODUCED during THIS
        // execution. Catches cross-execution stale-file republish — e.g. a fixed-name audio.mp3
        // left in the persistent role workspace by a prior run, grabbed when this run's synth
        // failed. birthtime is the load-bearing signal: mtime gets bumped by a copy/touch, but
        // birthtime only resets when the file is actually recreated. Pairs with producer-side
        // unique output naming (synth writes a fresh path per run) so a fresh deliverable never
        // inherits an old birthtime via in-place overwrite.
        if (exec?.startedAt !== undefined) {
          try {
            const st = statSync(args.sourcePath);
            const { stale, fileTimeMs } = isStalePublish(st, exec.startedAt);
            if (stale) {
              const error = `Stale deliverable refused: "${basename(args.sourcePath)}" was created ${new Date(fileTimeMs).toISOString()}, before this execution started ${new Date(exec.startedAt).toISOString()}. Publish only a file produced in THIS run — regenerate it, or report no_content if production failed. Never republish a leftover file from a previous run.`;
              logArtifactAccess({
                timestamp: Date.now(),
                taskId: ctx.taskId,
                roleId: ctx.roleId,
                executionId: ctx.executionId,
                stepId: ctx.stepId,
                tool: "publish_artifact_file",
                artifactKey: effectiveKey,
                outcome: "denied",
                errorReason: error,
              });
              log.warn({ taskId: ctx.taskId, stepId: ctx.stepId, sourcePath: args.sourcePath, fileTimeMs, startedAt: exec.startedAt }, "publish_artifact_file: refused stale deliverable (pre-execution birthtime)");
              return toCallToolResult({ error });
            }
          } catch {
            // stat failed (missing/inaccessible) — let downstream publishBlob surface the real error.
          }
        }

        const artifactId = uuidv4();
        let blobPath: string | null = null;
        let artifactCreated = false;
        let storedArtifact: Artifact | null = null;
        try {
          const published = publishBlob({
            executionId: ctx.executionId,
            artifactId,
            sourcePath: args.sourcePath,
          });
          blobPath = published.blobPath;

          // Phase 3 content validator gate — runs after blob is copied, before artifact row is created.
          // On throw: existing catch block on line 608 fires → unlinkBlob(blobPath) + log + return {error}
          const assertions = stepDef?.assertions ?? [];
          if (assertions.length > 0) {
            await validateArtifact(blobPath, assertions);
          }

          const newArtifact: Artifact = {
            id: artifactId,
            sourceKind: "template_step",
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            key: effectiveKey,
            kind: "file",
            blobPath,
            mime: args.mime ?? inferMimeFromPath(args.sourcePath),
            originalFilename: basename(args.sourcePath),
            sizeBytes: published.sizeBytes,
            createdAt: Date.now(),
            roleId: ctx.roleId,
            priority: args.priority,
            ...(args.role !== undefined ? { artifactRole: args.role } : {}),
          };

          if (declaredOutputAs && templateIsMigrated) {
            const existingPrimary = getArtifact(ctx.executionId, ctx.stepId, declaredOutputAs);
            if (!existingPrimary) {
              createArtifact(newArtifact);
              artifactCreated = true;
              storedArtifact = newArtifact;
            } else if (existingPrimary.kind === "file") {
              const result = convertPrimaryFileToCollectionInTransaction(
                ctx.executionId,
                ctx.stepId,
                declaredOutputAs,
                existingPrimary,
                {
                  ...newArtifact,
                  key: requestedCollectionChildKey(args.key, declaredOutputAs, args.sourcePath),
                },
              );
              storedArtifact = result.childArtifact;
            } else if (existingPrimary.kind === "json" && isArtifactCollectionManifest(existingPrimary.value)) {
              const result = appendArtifactToCollection(
                ctx.executionId,
                ctx.stepId,
                declaredOutputAs,
                {
                  ...newArtifact,
                  key: requestedCollectionChildKey(args.key, declaredOutputAs, args.sourcePath),
                },
              );
              storedArtifact = result.childArtifact;
            } else {
              throw new Error(`Artifact key "${declaredOutputAs}" already contains a non-collection JSON artifact`);
            }
          } else {
            createArtifact(newArtifact);
            artifactCreated = true;
            storedArtifact = newArtifact;
          }

          if (args.cleanup === true) {
            unlinkSourceFileStrict(args.sourcePath);
          }

          // Phase 4: write entity_mutation receipt
          writeMutationReceipt({
            toolName: "publish_artifact_file",
            entityType: "artifact",
            verb: "create",
            entityId: artifactId,
            fieldChanges: [{ path: "_entity", op: "set", before: null, after: { artifactId, key: storedArtifact?.key ?? effectiveKey, kind: "file", filename: basename(args.sourcePath), taskId: ctx.taskId } }],
            taskId: ctx.taskId,
            roleId: ctx.roleId,
          });

          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: storedArtifact?.key ?? effectiveKey,
            artifactId,
            sizeBytes: published.sizeBytes,
            outcome: "success",
          });
          return toCallToolResult({
            success: true,
            artifactId,
            sizeBytes: published.sizeBytes,
            ...(keyOverrideNote ? { note: keyOverrideNote } : {}),
          });
        } catch (err) {
          if (artifactCreated) {
            try {
              deleteArtifactById(artifactId);
            } catch {
              // Best-effort rollback; watchdog/orphan GC handles leftovers.
            }
          }
          if (blobPath && (!storedArtifact || artifactCreated)) {
            try {
              unlinkBlob(blobPath);
            } catch {
              // Best-effort rollback; watchdog/orphan GC handles leftovers.
            }
          }
          const error = err instanceof Error ? err.message : String(err);
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "publish_artifact_file",
            artifactKey: effectiveKey,
            artifactId,
            outcome: "error",
            errorReason: error,
          });
          // Phase 4: write structured validator error signal for template-executor retry detection.
          if (err instanceof AssertionFailedError || err instanceof NoHandlerError) {
            try {
              const countRow = getDb().prepare(
                "SELECT COUNT(*) as n FROM step_logs WHERE task_id = ?",
              ).get(ctx.taskId) as { n: number } | undefined;
              const nextIndex = (countRow?.n ?? 0) + 1;
              createStepLog({
                id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                taskId: ctx.taskId,
                index: nextIndex,
                type: "validator_error",
                content: err.message,
                toolName: "publish_artifact_file",
                timestamp: Date.now(),
              });
            } catch {
              // Signal write is best-effort — if it fails, the retry never fires,
              // but the LLM still sees the error in the tool response.
            }
          }
          return toCallToolResult({ error });
        }
      },
    ),

    tool(
      "fetch_artifact_file",
      "Copy an upstream step's published file into your current Role workspace. Use this when an earlier step published audio, video, reports, or other files you need to process.",
      {
        stepId: stepIdSchema.describe("TemplateExecution step ID of the artifact's source step."),
        key: z.string().describe("Artifact key — a unique identifier for this value within the template execution."),
        destPath: localFilePathSchema.describe("Destination path in the Role workspace where the file will be copied."),
      },
      async (args) => {
        const ctx = await resolveTemplateExecutionCtx();
        if ("error" in ctx) return toCallToolResult({ error: ctx.error });

        const stepIdError = validateStepId(args.stepId);
        const keyError = validateKey(args.key);
        const validationError = stepIdError ?? keyError;
        if (validationError) {
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: validationError,
          });
          return toCallToolResult({ error: validationError });
        }

        try {
          validatePathInWorkspace(args.destPath, ctx.roleWorkspacePath, false);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            outcome: "denied",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        const artifact = getArtifact(ctx.executionId, args.stepId, args.key);
        if (!artifact) {
          const error = `no artifact at ${args.stepId}/${args.key}`;
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            outcome: "error",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        if (artifact.kind !== "file" || !artifact.blobPath) {
          const error = "artifact is not a file";
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            artifactId: artifact.id,
            outcome: "denied",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }

        try {
          const fetched = fetchBlob({
            blobPath: artifact.blobPath,
            destPath: args.destPath,
          });
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            artifactId: artifact.id,
            sizeBytes: fetched.sizeBytes,
            outcome: "success",
          });
          return toCallToolResult({
            success: true,
            sizeBytes: fetched.sizeBytes,
            mime: artifact.mime,
            destPath: args.destPath,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "fetch_artifact_file",
            artifactKey: args.key,
            artifactId: artifact.id,
            outcome: "error",
            errorReason: error,
          });
          return toCallToolResult({ error });
        }
      },
    ),

    tool(
      "list_artifacts",
      "Discover artifacts published by upstream steps in this template execution. Returns step_id, key, kind ('json' or 'file'), size, mime. Use this to learn what is available before calling read_artifact or fetch_artifact_file.",
      {
        stepId: stepIdSchema.optional().describe("Filter to a specific TemplateExecution step (omit to list all artifacts in the execution)."),
      },
      async (args) => {
        const ctx = await resolveTemplateExecutionCtx();
        if ("error" in ctx) return toCallToolResult({ error: ctx.error });

        const stepIdError = args.stepId ? validateStepId(args.stepId) : null;
        if (stepIdError) {
          logArtifactAccess({
            timestamp: Date.now(),
            taskId: ctx.taskId,
            roleId: ctx.roleId,
            executionId: ctx.executionId,
            stepId: ctx.stepId,
            tool: "list_artifacts",
            outcome: "denied",
            errorReason: stepIdError,
          });
          return toCallToolResult({ error: stepIdError });
        }

        const artifacts = listArtifactsByExecution(ctx.executionId, args.stepId);
        logArtifactAccess({
          timestamp: Date.now(),
          taskId: ctx.taskId,
          roleId: ctx.roleId,
          executionId: ctx.executionId,
          stepId: ctx.stepId,
          tool: "list_artifacts",
          sizeBytes: artifacts.length,
          outcome: "success",
        });
        return toCallToolResult({
          artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            stepId: artifact.stepId,
            key: artifact.key,
            kind: artifact.kind,
            sizeBytes: artifact.sizeBytes,
            mime: artifact.mime,
            createdAt: artifact.createdAt,
          })),
        });
      },
    ),

    tool(
      "report_blocked",
      "Report that the task cannot proceed due to a missing prerequisite (e.g., missing credential, missing input, missing target). This sets the task status to 'blocked', stores the reason for the UI to display, and aborts the execution loop.",
      {
        reason: z.string().describe("Short reason, e.g. 'missing_credential', 'missing_target', 'missing_input'"),
        missingPrereqs: z.array(z.string()).optional().describe("Specific keys/IDs that are missing, e.g. ['MINIMAX_API_KEY']"),
        resumeHint: z.string().optional().describe("How the user can unblock, e.g. 'set MINIMAX_API_KEY in role env'"),
      },
      async (args) => {
        if (!taskId) {
          return toCallToolResult({ error: "report_blocked requires a task context (taskId not available)" });
        }
        const task = getTask(taskId);
        if (!task) {
          return toCallToolResult({ error: `task not found: ${taskId}` });
        }

        const blockReason = {
          reason: args.reason,
          missingPrereqs: args.missingPrereqs,
          resumeHint: args.resumeHint,
        };

        updateTask(taskId, {
          status: "blocked",
          blockReason,
          completedAt: Date.now(),
        });

        serverBus.emit({
          type: "task_status_change",
          taskId: taskId,
          oldStatus: task.status,
          newStatus: "blocked",
        });

        // Phase 4: write entity_mutation receipt
        writeMutationReceipt({
          toolName: "report_blocked",
          entityType: "task",
          verb: "update",
          entityId: taskId,
          fieldChanges: [
            { path: "status", op: "set", before: task.status, after: "blocked" },
            { path: "blockReason", op: "set", before: undefined, after: args.reason },
            { path: "completedAt", op: "set", before: undefined, after: Date.now() },
          ],
          taskId,
          roleId: task.roleId,
        });

        // Signal ExecutionManager to abort the SDK loop
        doReportBlocked();

        return toCallToolResult({ success: true, blocked: true, reason: args.reason });
      },
    ),

    tool(
      "commit_claim",
      "Declare structured claims about what this worker task just did so the audit engine can verify against effect receipts. Call this in the SAME task turn before reporting completion text. Mirror of the ChatManager tool — workers may also need to declare claims for actions taken inside template execution steps.",
      {
        claims: z.array(z.object({
          verb: z.string().min(1).describe("What was done: 'send', 'update', 'create', 'delete', 'cancel', 'enable', 'disable', 'bind', 'unbind', etc."),
          entityType: z.string().min(1).describe("What kind of thing was affected: 'channel_message', 'task_template', 'task', 'goal', 'role', 'delivery_rule', 'plugin', 'mcp_binding', 'config_field', etc."),
          expected: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("outbound").describe("Used when verb='send' — declares a channel message was sent."),
              target: z.object({
                channelId: z.string().min(1).describe("Channel that received the message."),
                chatId: z.string().min(1).optional().describe("Specific chat within the channel; omit for any chat."),
              }).describe("Where the message went."),
              attachmentCount: z.number().int().min(0).optional().describe("How many attachments were sent. Verifier requires receipt.attachmentCount >= this."),
              textPresent: z.boolean().optional().describe("Whether the message body had non-empty text. Verifier requires receipt.textChars > 0 when true."),
            }),
            z.object({
              kind: z.literal("field_change").describe("Used for single-entity updates — declares a specific field on a specific entity changed."),
              entityId: z.string().min(1).describe("Identifier of the entity that was changed."),
              fieldPath: z.string().min(1).describe("Dotted path to the field that changed, e.g. 'deliverTo', 'cron', 'config.timeout'."),
              op: z.enum(["set", "list_add", "list_remove"]).describe("How the field changed: scalar set, list append, or list removal."),
              added: z.array(z.unknown()).min(1).optional().describe("Items appended when op='list_add'. Verifier accepts a superset (receipt may have appended more items)."),
              removed: z.array(z.unknown()).min(1).optional().describe("Items removed when op='list_remove'. Verifier accepts a superset."),
              after: z.unknown().optional().describe("New value when op='set'. Verifier requires deep-equal match."),
            }),
            z.object({
              kind: z.literal("batch").describe("Used for batch operations like cancel-many or delete-many."),
              entityType: z.string().min(1).describe("Restrict matching to this entity type."),
              entityIds: z.array(z.string()).min(1).optional().describe("Specific entity IDs affected. Verifier checks receipt.entityIds is a superset."),
              scope: z.object({
                filter: z.string().min(1).describe("Free-text description of the filter applied (e.g., 'status=running AND role_id=role-x'). Verifier ignores this; human-readable only."),
                expectedCount: z.number().int().min(0).describe("Minimum number of entities expected to have been affected. Verifier requires receipt.scope.matchedCount >= this."),
              }).optional().describe("Filter+count for scope-based batches when individual IDs aren't enumerated."),
            }),
          ]).describe("Structured expectation matched against effect_receipts. Pick the kind that fits the action."),
          note: z.string().optional().describe("Free-text human note kept in the audit log only. Verifier ignores this."),
        })).min(1).max(20).describe("One or more claims declaring exactly what just happened. Each claim is verified independently against receipts."),
      },
      async (args) => {
        // Worker-side trace context: AsyncLocalStorage is populated by ExecutionManager.runQuery's withTrace(...)
        // wrap (execution-manager.ts:659), so getCurrentTraceId() returns the active trace during tool invocation.
        // Worker calls do NOT propagate sessionId — that field stays NULL for worker-originated claims.
        const traceId = getCurrentTraceId();
        if (!traceId) {
          return toCallToolResult({ error: "commit_claim requires an active trace context" });
        }
        try {
          const row = writeClaims({
            traceId,
            taskId,
            claims: args.claims as ClaimSpec[],
          });
          return toCallToolResult({
            claimRowId: row.id,
            claimsCount: row.claims.length,
            declaredAt: row.declaredAt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return toCallToolResult({ error: msg });
        }
      },
    ),
  ];

  const registeredTools = isTemplateExecutionStepTask(taskId)
    ? tools.filter((registeredTool: { name: string }) => registeredTool.name !== "list_channels" && registeredTool.name !== "send_to_channel")
    : tools;

  return createSdkMcpServer({
    name: EXECUTION_TOOLS_MCP_NAME,
    version: "1.0.0",
    tools: registeredTools,
  });
}
