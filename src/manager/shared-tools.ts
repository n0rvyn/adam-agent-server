import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { queryMemory } from "../agent/memory-service.js";
import { createMemory, updateMemory, deleteMemory, getMemory } from "../store/memories.js";
import { generateEmbedding } from "../lib/embedding.js";
import { v4 as uuidv4 } from "uuid";
import type { MemoryNodeType } from "../shared/types.js";
import { roleIdSchema } from "../lib/tool-schemas.js";
import { writeMutationReceipt } from "../audit/mutation-receipt-writer.js";

function toCallToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// Full schemas (adam-tools: cross-role access)
const searchSchemaFull = {
  query: z.string().describe("Search query for memory retrieval"),
  roleId: roleIdSchema.optional().describe("Role ID to scope search (omit for cross-role)"),
  topK: z.number().optional().describe("Max results to return (default 5)"),
};

const searchSchemaScoped = {
  query: z.string().describe("Search query for memory retrieval"),
  topK: z.number().optional().describe("Max results to return (default 5)"),
};

const saveSchemaFull = {
  id: z.string().optional().describe("Memory ID to update. Omit to create new."),
  roleId: roleIdSchema.describe("Role ID to save memory under"),
  content: z.string().describe("Memory content text"),
  type: z.enum(["event", "thought", "reflection"]).optional().describe("Memory type (default: thought)"),
  keywords: z.array(z.string()).optional().describe("Keywords for BM25 search"),
  importance: z.number().min(1).max(5).optional().describe("Importance 1-5 (default: 3)"),
  tier: z.enum(["working", "episodic", "semantic"]).optional().describe("Memory tier (default: episodic)"),
};

const saveSchemaScoped = {
  id: z.string().optional().describe("Memory ID to update. Omit to create new."),
  content: z.string().describe("Memory content text"),
  type: z.enum(["event", "thought", "reflection"]).optional().describe("Memory type (default: thought)"),
  keywords: z.array(z.string()).optional().describe("Keywords for BM25 search"),
  importance: z.number().min(1).max(5).optional().describe("Importance 1-5 (default: 3)"),
  tier: z.enum(["working", "episodic", "semantic"]).optional().describe("Memory tier (default: episodic)"),
};

const deleteSchema = {
  id: z.string().describe("Memory ID to delete"),
};

// Shared handler implementations
async function handleSearch(
  scopedRoleId: string | undefined,
  args: { query: string; roleId?: string; topK?: number },
) {
  const roleId = scopedRoleId ?? args.roleId;
  const topK = args.topK ?? 5;
  const results = await queryMemory(roleId, args.query, { topK });
  return toCallToolResult({
    results: results.map((m) => ({
      id: m.id,
      type: m.type,
      content: m.content,
      keywords: m.keywords,
      importance: m.importance,
      score: m.score,
    })),
  });
}

async function handleSave(
  scopedRoleId: string | undefined,
  args: { id?: string; roleId?: string; content: string; type?: MemoryNodeType; keywords?: string[]; importance?: number; tier?: "working" | "episodic" | "semantic" },
) {
  const roleId = scopedRoleId ?? args.roleId;
  if (!roleId) {
    return toCallToolResult({ error: "roleId is required" });
  }

  let embedding: Float32Array | undefined;
  let embeddingGenerated = true;
  try {
    embedding = await generateEmbedding(args.content);
  } catch {
    embeddingGenerated = false;
  }

  if (args.id) {
    const existing = getMemory(args.id);
    if (!existing) {
      return toCallToolResult({ error: `Memory ${args.id} not found` });
    }
    const updated = updateMemory(args.id, {
      content: args.content,
      embedding,
      keywords: args.keywords,
      importance: args.importance,
      type: args.type,
    });
    // Phase 4: write entity_mutation receipt (update branch)
    writeMutationReceipt({
      toolName: "save_memory",
      entityType: "memory",
      verb: "update",
      entityId: args.id,
      fieldChanges: [{ path: "content", op: "set", before: existing.content, after: args.content }],
      roleId,
    });
    return toCallToolResult({ id: args.id, action: "updated", success: updated, embeddingUpdated: embeddingGenerated });
  }

  const id = `mem-${uuidv4().slice(0, 8)}`;
  const now = Date.now();
  createMemory({
    id,
    roleId,
    type: args.type ?? "thought",
    content: args.content,
    embedding,
    keywords: args.keywords ?? [],
    importance: args.importance ?? 3,
    sourceType: "manual",
    createdAt: now,
    lastAccessed: now,
    retrievedCount: 0,
    tier: args.tier ?? "episodic",
  });
  // Phase 4: write entity_mutation receipt (create branch)
  writeMutationReceipt({
    toolName: "save_memory",
    entityType: "memory",
    verb: "create",
    entityId: id,
    fieldChanges: [{
      path: "_entity",
      op: "set",
      before: null,
      after: {
        id,
        roleId,
        type: args.type ?? "thought",
        content: args.content.length > 200 ? `${args.content.slice(0, 200)}…` : args.content,
        tier: args.tier ?? "episodic",
      },
    }],
    roleId,
  });
  return toCallToolResult({ id, action: "created", success: true, embeddingUpdated: embeddingGenerated });
}

async function handleDelete(scopedRoleId: string | undefined, args: { id: string }) {
  const existing = getMemory(args.id);
  if (scopedRoleId) {
    if (!existing) {
      return toCallToolResult({ error: `Memory ${args.id} not found` });
    }
    if (existing.roleId !== scopedRoleId) {
      return toCallToolResult({ error: `Memory ${args.id} does not belong to this role` });
    }
  }
  deleteMemory(args.id);
  // Phase 4: write entity_mutation receipt
  writeMutationReceipt({
    toolName: "delete_memory",
    entityType: "memory",
    verb: "delete",
    entityId: args.id,
    fieldChanges: [{
      path: "_entity",
      op: "set",
      before: existing ? { id: existing.id, roleId: existing.roleId, content: existing.content.length > 200 ? `${existing.content.slice(0, 200)}…` : existing.content } : null,
      after: null,
    }],
    roleId: scopedRoleId ?? existing?.roleId,
  });
  return toCallToolResult({ id: args.id, deleted: true });
}

/**
 * Shared memory tool factories for adam-tools and execution-tools.
 *
 * @param scopedRoleId — if provided, locks all operations to this role (RBAC, D-026).
 *   adam-tools: undefined (LLM can specify any roleId)
 *   execution-tools: locked to the executing role's ID
 */
// `tool` defaults to the SDK factory; ChatManager passes its per-session traced wrapper so
// memory mutation receipts attribute to the in-flight turn. The param is named `tool` (not
// `toolFactory`) so the literal `tool("name"` call sites stay greppable by the static
// receipt-coverage scanner (src/__tests__/audit/tool-receipt-coverage.test.ts).
export function createSharedMemoryTools(scopedRoleId?: string, tool: typeof sdkTool = sdkTool) {
  if (scopedRoleId) {
    return [
      tool("search_memories", "Search agent memory using hybrid vector + keyword search. Returns scored memories ranked by relevance, recency, and importance.", searchSchemaScoped, async (args) => handleSearch(scopedRoleId, args)),
      tool("save_memory", "Create a new memory or update an existing one. Provide 'id' to update, omit to create. Embedding is auto-generated from content.", saveSchemaScoped, async (args) => handleSave(scopedRoleId, args)),
      tool("delete_memory", "Delete a memory by ID.", deleteSchema, async (args) => handleDelete(scopedRoleId, args)),
    ];
  }

  return [
    tool("search_memories", "Search agent memory using hybrid vector + keyword search. Returns scored memories ranked by relevance, recency, and importance.", searchSchemaFull, async (args) => handleSearch(undefined, args)),
    tool("save_memory", "Create a new memory or update an existing one. Provide 'id' to update, omit to create. Embedding is auto-generated from content.", saveSchemaFull, async (args) => handleSave(undefined, args)),
    tool("delete_memory", "Delete a memory by ID.", deleteSchema, async (args) => handleDelete(undefined, args)),
  ];
}
