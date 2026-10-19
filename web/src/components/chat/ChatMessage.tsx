import { clsx } from "clsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";
import { timeAgo } from "@/lib/format.ts";
import { StatusReportLine } from "./StatusReport.tsx";
import { ResultDeliveryCard } from "./ResultDeliveryCard.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { SystemNote } from "./SystemNote.tsx";
import { AuditNote } from "./AuditNote.tsx";

interface ChatMessageProps {
  message: ChatMessageInfo;
}

export function ChatMessage({ message }: ChatMessageProps) {
  // Switch on envelope kind (UX-006). Falls back to legacy bubble for missing kind (back-compat).
  const kind = message.kind ?? (message.role === "user" ? "user_message" : "assistant_text");

  switch (kind) {
    case "status_report":
      return <StatusReportLine message={message} />;
    case "result_delivery":
      return <ResultDeliveryCard message={message} />;
    case "approval_prompt":
      return <ApprovalCard message={message} />;
    case "system_note":
      return <SystemNote message={message} />;
    case "audit_note":
      return <AuditNote message={message} />;
    case "user_message":
    case "assistant_text":
    default:
      return <ConversationBubble message={message} />;
  }
}

/** Original user_message / assistant_text bubble (preserved from legacy ChatMessage). */
function ConversationBubble({ message }: { message: ChatMessageInfo }) {
  const isUser = message.role === "user";
  const metaLabel = isUser ? "You" : message.taskId ? "Adam \xb7 execution" : "Adam";

  return (
    <div className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] rounded-lg px-4 py-3 text-sm leading-7 shadow-[var(--app-shadow-md)]",
          isUser ? "surface-accent text-white" : "surface-panel text-[var(--app-text)]",
        )}
      >
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em]">
          <span className={isUser ? "text-white/70" : "text-[var(--app-kicker)]"}>{metaLabel}</span>
          <span className={isUser ? "text-white/45" : "text-[var(--app-text-subtle)]"}>
            {timeAgo(
              typeof message.createdAt === "number"
                ? message.createdAt
                : new Date(message.createdAt).getTime(),
            )}
          </span>
        </div>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    </div>
  );
}
