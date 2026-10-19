import { getMessagesBySession } from "../store/messages.js";
import { generateEmbedding } from "../lib/embedding.js";
import { createMemory } from "../store/memories.js";
import { v4 as uuidv4 } from "uuid";
import type { MemoryNode, MemoryNodeType } from "../shared/types.js";

interface SessionExtractionResult {
  facts: Array<{ content: string; importance: number; type: MemoryNodeType }>;
}

function extractFromUserMessage(content: string): { content: string; importance: number; type: MemoryNodeType } | null {
  if (content.length < 20) return null;
  const trimmed = content.trim();
  if (trimmed.length > 300) {
    return { content: `User request: ${trimmed.slice(0, 280)}...`, importance: 3, type: "thought" };
  }
  return { content: `User request: ${trimmed}`, importance: 3, type: "thought" };
}

function extractFromAssistantMessage(content: string): { content: string; importance: number; type: MemoryNodeType } | null {
  if (content.length < 20) return null;
  const trimmed = content.trim();
  if (trimmed.length > 400) {
    return { content: `Assistant response: ${trimmed.slice(0, 370)}...`, importance: 2, type: "event" };
  }
  return { content: `Assistant response: ${trimmed}`, importance: 2, type: "event" };
}

export function extractFromSessionMessages(sessionId: string): SessionExtractionResult {
  const messages = getMessagesBySession(sessionId, 200, 0);
  const facts: Array<{ content: string; importance: number; type: MemoryNodeType }> = [];

  for (const msg of messages) {
    const extracted = msg.role === "user"
      ? extractFromUserMessage(msg.content)
      : extractFromAssistantMessage(msg.content);
    if (extracted) {
      facts.push(extracted);
    }
  }

  return { facts };
}

function extractKeywords(content: string): string[] {
  const words = content.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  return [...new Set(words)].slice(0, 20);
}

/**
 * Extract key memory nodes from a chat session and store them for the agent.
 * @param sessionId - chat session ID
 * @param roleId - Role to store memories under (undefined = use "role-chat-manager" via hooks context)
 * Returns the number of memories stored.
 */
export async function processSessionArchive(
  sessionId: string,
  roleId: string,
): Promise<number> {
  const { facts } = extractFromSessionMessages(sessionId);
  let stored = 0;

  for (const fact of facts) {
    const content = fact.content.slice(0, 500);
    let embedding: Float32Array | undefined;
    try {
      embedding = await generateEmbedding(content);
    } catch {
      // Embedding unavailable; store without embedding
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
      sourceType: "session_archive",
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
