import { useState, useEffect } from "react";
import { Check, X, Send, AlertCircle } from "lucide-react";
import { clsx } from "clsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";
import { useChatStore } from "@/store/useChatStore.ts";
import { Button } from "@/components/ui/Button.tsx";

interface ApprovalCardProps {
  message: ChatMessageInfo;
}

type CardState = "pending" | "submitted" | "stale";

/**
 * Approval prompt rendered per shape:
 * - yes_no: "批准" / "拒绝" two buttons
 * - choose_one: parses choices from message.content (line "选项: A | B | C") OR shows "批准" / "拒绝" fallback
 * - free_input: text input + submit
 *
 * State machine:
 *   pending  → user clicks button → POST /chat/messages with buttonPayload
 *            → result truthy: enter "submitted" (optimistic UI)
 *   submitted → useEffect watches incoming messages.kind === 'system_note' with content
 *               containing `#{promptId}` AND keyword (过期/已处理/未找到) → "stale"
 *   stale    → terminal display showing reason from system_note
 *
 * Why this matters: server-side Phase 5 stale-button branch returns {sessionId, messageId}
 * (HTTP 200) AND emits a system_note. If we naively switched to "submitted" on truthy result,
 * users would see "已批准 ✓" while a system_note "该决策窗口已过期" lands seconds later.
 */
export function ApprovalCard({ message }: ApprovalCardProps) {
  const sendApprovalResponse = useChatStore((s) => s.sendApprovalResponse);
  const messages = useChatStore((s) => s.messages);
  const [state, setState] = useState<CardState>("pending");
  const [submittedValue, setSubmittedValue] = useState<string>("");
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [staleReason, setStaleReason] = useState<string>("");
  const [freeInput, setFreeInput] = useState("");
  const shape = message.approvalShape ?? "yes_no";
  const promptId = message.promptId ?? "";

  // Watch for stale-system-notes after submit (Phase 5 stale-button branch emits these).
  useEffect(() => {
    if (state !== "submitted" || !promptId || submittedAt === null) return;
    const stale = messages.find((m) => {
      if (m.kind !== "system_note") return false;
      if (m.createdAt < submittedAt) return false;
      if (!m.content.includes(`#${promptId}`)) return false;
      return /过期|已处理|未找到/.test(m.content);
    });
    if (stale) {
      setState("stale");
      setStaleReason(stale.content);
    }
  }, [state, messages, promptId, submittedAt]);

  const submit = async (value: string) => {
    if (!promptId || state !== "pending") return;
    const submitTime = Date.now();
    const result = await sendApprovalResponse(promptId, value);
    if (result) {
      setState("submitted");
      setSubmittedValue(value);
      setSubmittedAt(submitTime);
    }
    // result === null indicates store guard (sending=true) or network failure;
    // stay in pending state — user can retry.
  };

  if (state === "stale") {
    return (
      <div
        className="chat-approval-card chat-approval-stale surface-panel rounded-xl px-4 py-3 text-sm opacity-70"
        data-testid="approval-card"
        data-state="stale"
      >
        <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-[var(--app-kicker)]">
          approval · #{promptId}
        </div>
        <div className="text-[var(--app-text-muted)]">{message.content}</div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--app-warning-soft-bg)] px-2 py-1 text-xs font-medium text-[var(--app-warning-soft-text)]">
          <AlertCircle size={12} aria-hidden="true" />
          {staleReason}
        </div>
      </div>
    );
  }

  if (state === "submitted") {
    const time = submittedAt
      ? new Date(submittedAt).toLocaleTimeString([], {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    return (
      <div
        className="chat-approval-card chat-approval-resolved surface-panel rounded-xl px-4 py-3 text-sm opacity-60"
        data-testid="approval-card"
        data-state="submitted"
      >
        <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-[var(--app-kicker)]">
          approval · #{promptId}
        </div>
        <div className="text-[var(--app-text-muted)]">{message.content}</div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--app-success-soft-bg)] px-2 py-1 text-xs font-medium text-[var(--app-success-soft-text)]">
          <Check size={12} aria-hidden="true" />
          已提交「{submittedValue}」 {time}
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "chat-approval-card surface-panel-elevated rounded-xl px-4 py-3 text-sm",
      )}
      data-testid="approval-card"
      data-state="pending"
      data-shape={shape}
    >
      <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-[var(--app-kicker)]">
        approval · #{promptId}
      </div>
      <div className="mb-3 text-[var(--app-text)]">{message.content}</div>

      {shape === "yes_no" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => void submit("批准")}
            aria-label="Approve"
            data-testid="approve-button"
          >
            <Check size={14} aria-hidden="true" />
            批准
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void submit("拒绝")}
            aria-label="Reject"
            data-testid="reject-button"
          >
            <X size={14} aria-hidden="true" />
            拒绝
          </Button>
        </div>
      ) : null}

      {shape === "choose_one" ? (
        <div className="flex flex-wrap gap-2">
          {/* Fallback to yes/no until choices are part of the envelope; choose_one details
             are typed in `expectedShapeJson` server-side and not yet exposed on the wire. */}
          <Button
            size="sm"
            onClick={() => void submit("批准")}
            data-testid="approve-button"
          >
            批准
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void submit("拒绝")}
            data-testid="reject-button"
          >
            拒绝
          </Button>
        </div>
      ) : null}

      {shape === "free_input" ? (
        <div className="flex items-end gap-2">
          <input
            type="text"
            value={freeInput}
            onChange={(e) => setFreeInput(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--app-border)] bg-white/[0.04] px-3 py-2 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-border-strong)] focus:outline-none focus:ring-1 focus:ring-[var(--app-accent)]"
            placeholder="输入回复..."
            data-testid="free-input"
          />
          <Button
            size="sm"
            onClick={() => void submit(freeInput.trim())}
            disabled={!freeInput.trim()}
            data-testid="submit-button"
          >
            <Send size={14} aria-hidden="true" />
            提交
          </Button>
        </div>
      ) : null}

      <div className="mt-2 text-[11px] text-[var(--app-text-subtle)]">
        看不到按钮？回 #{promptId} 表态。
      </div>
    </div>
  );
}
