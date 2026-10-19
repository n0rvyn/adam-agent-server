import { getStepLogs } from "../store/logs.js";
import { generateEmbedding } from "../lib/embedding.js";
import { createMemory } from "../store/memories.js";
import { v4 as uuidv4 } from "uuid";
import type { StepLog, MemoryNode, MemorySourceType, MemoryNodeType } from "../shared/types.js";

interface ExtractionResult {
  facts: Array<{ content: string; importance: number; type: MemoryNodeType }>;
}

function extractFromToolResult(
  log: StepLog,
): { content: string; importance: number; type: MemoryNodeType } | null {
  const toolName = log.toolName;
  const content = log.toolOutput || log.content;

  if (toolName === "Write" || toolName === "Edit") {
    return {
      content: `Modified file via ${toolName}: ${content.slice(0, 400)}`,
      importance: 4,
      type: "event",
    };
  }

  if (toolName === "Bash") {
    const cmd = (log.toolInput?.command as string)?.slice(0, 100) || "Bash";
    if (content.includes("FAIL") || content.includes("error:") || content.includes("Error:")) {
      return {
        content: `Command failed: ${cmd} ${content.slice(0, 300)}`,
        importance: 4,
        type: "event",
      };
    }
    if (content.includes("success") || content.includes("done") || content.includes("OK")) {
      return {
        content: `Command succeeded: ${cmd}`,
        importance: 2,
        type: "event",
      };
    }
    // Generic Bash execution — still worth recording at low importance
    return {
      content: `Executed: ${cmd}`,
      importance: 1,
      type: "event",
    };
  }

  return null;
}

export function extractKeyFacts(taskId: string): ExtractionResult {
  const logs = getStepLogs(taskId, 500, 0);
  const facts: Array<{ content: string; importance: number; type: MemoryNodeType }> = [];

  for (const log of logs) {
    if ((log.type === "tool_result" || log.type === "tool_call") && log.toolName) {
      const extracted = extractFromToolResult(log);
      if (extracted) {
        facts.push(extracted);
      }
    } else if (log.type === "error") {
      facts.push({
        content: `Error occurred: ${log.content.slice(0, 400)}`,
        importance: 4,
        type: "event",
      });
    }
  }

  return { facts };
}

function extractKeywords(content: string): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return [...new Set(words)].slice(0, 20);
}

export async function processTaskCompletion(
  taskId: string,
  roleId: string,
): Promise<number> {
  // processTaskCompletion is the sole writer of type="event" memories per task.
  // SubagentStop handles type="thought" (reasoning transcript). No cross-type
  // dedup needed — type spaces do not overlap (GAP-08 fix).

  const { facts } = extractKeyFacts(taskId);
  // Invariant: post-GAP-08, all extracted facts must be type="event"
  for (const fact of facts) {
    if (fact.type !== "event") {
      throw new Error(`extractKeyFacts produced non-event fact (type=${fact.type}) — GAP-08 invariant violated`);
    }
  }
  let stored = 0;
  for (const fact of facts) {
    const content = fact.content.slice(0, 500);
    let embedding: Float32Array | undefined;
    try {
      embedding = await generateEmbedding(content);
    } catch {
      // Embedding unavailable (model not downloaded yet); store without embedding
    }
    const keywords = extractKeywords(content);

    const memory: MemoryNode = {
      id: uuidv4(),
      roleId: roleId,
      type: fact.type,
      content,
      embedding,
      keywords,
      importance: fact.importance,
      sourceType: "task_complete" as MemorySourceType,
      sourceTaskId: taskId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "episodic",
    };

    createMemory(memory);
    stored++;
  }

  return stored;
}
