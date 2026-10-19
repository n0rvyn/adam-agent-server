import type { ChatMessage } from "../shared/types.js";
import { getTask } from "../store/tasks.js";
import { getRole } from "../store/roles.js";
import { listOpenPromptsByTask } from "../store/pending-prompts.js";

export interface ThreadBlock {
  taskId: string;
  taskShortId: string;        // "T-" + first 8 chars of taskId
  roleName: string;           // "?" if role lookup fails
  brief: string;              // task.prompt.slice(0, 30)
  active: boolean;           // task non-terminal OR has open prompts
  envelopes: ChatMessage[];   // chronological
}

export interface GroupedTimeline {
  freeConversation: ChatMessage[];
  threads: ThreadBlock[];     // ordered by first envelope's createdAt
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Group session envelopes into free conversation + thread blocks.
 *
 * Grouping key (in order):
 *   1. envelope.taskId — direct membership (status_report, result_delivery, approval_prompt)
 *   2. envelope.parentMessageId → parent.taskId — for user_message envelopes that
 *      resolved a prompt (Phase 5 sets parentMessageId on the user reply, but not
 *      taskId; we inherit the parent's taskId so the reply renders inside the thread
 *      per design doc Journey 1 example lines 268-269)
 *   3. otherwise → free conversation
 *
 * Thread metadata (short id, role name, brief, active flag) derived from
 * tasks / roles / pending_prompts stores.
 */
export function groupEnvelopesByThread(messages: ChatMessage[]): GroupedTimeline {
  const free: ChatMessage[] = [];
  const byTaskId = new Map<string, ChatMessage[]>();
  const byMessageId = new Map<string, ChatMessage>();
  for (const m of messages) byMessageId.set(m.id, m);

  for (const m of messages) {
    let taskId: string | undefined = m.taskId;
    if (!taskId && m.parentMessageId) {
      const parent = byMessageId.get(m.parentMessageId);
      if (parent?.taskId) taskId = parent.taskId;
    }
    if (taskId) {
      const arr = byTaskId.get(taskId) ?? [];
      arr.push(m);
      byTaskId.set(taskId, arr);
    } else {
      free.push(m);
    }
  }

  const threads: ThreadBlock[] = [];
  for (const [taskId, envelopes] of byTaskId) {
    // Sort by seq (Phase 1 monotonic-per-session column) when both rows have it;
    // fall back to createdAt otherwise. Caveat: a thread that mixes pre-Phase-1
    // legacy rows (seq=NULL) with Phase-1+ rows can yield non-transitive ordering
    // in pathological cases; in practice such mixed threads only occur during the
    // single migration boundary and are rare. Acceptable.
    envelopes.sort((a, b) => {
      const sa = a.seq, sb = b.seq;
      if (sa !== undefined && sb !== undefined) return sa - sb;
      return a.createdAt - b.createdAt;
    });
    const task = getTask(taskId);
    const role = task?.roleId ? getRole(task.roleId) : undefined;
    const openPrompts = listOpenPromptsByTask(taskId);
    const active = task
      ? (!TERMINAL_STATUSES.has(task.status) || openPrompts.length > 0)
      : false;
    threads.push({
      taskId,
      taskShortId: `T-${taskId.slice(0, 8)}`,
      roleName: role?.name ?? "?",
      brief: (task?.prompt ?? "").slice(0, 30),
      active,
      envelopes,
    });
  }
  threads.sort((a, b) => a.envelopes[0].createdAt - b.envelopes[0].createdAt);

  return { freeConversation: free, threads };
}
