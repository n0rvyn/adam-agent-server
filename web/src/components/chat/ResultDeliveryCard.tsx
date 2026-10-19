import { clsx } from "clsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";
import { roleColorToken, taskShortId } from "@/lib/chatRendering.ts";
import { timeAgo } from "@/lib/format.ts";

interface ResultDeliveryCardProps {
  message: ChatMessageInfo;
}

export function ResultDeliveryCard({ message }: ResultDeliveryCardProps) {
  const color = roleColorToken(message.roleId);
  const shortId = taskShortId(message.taskId);
  const hasMirror =
    message.mirroredToTargets && message.mirroredToTargets.length > 0;

  return (
    <div
      className={clsx(
        "chat-result-delivery surface-panel-elevated rounded-xl px-4 py-3 text-sm leading-7",
      )}
      data-testid="result-delivery-card"
      data-task-short-id={shortId}
    >
      {/* Header: Role pill + task short ID + timestamp */}
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em]">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold"
          style={{ borderColor: color, color }}
          data-testid="role-pill"
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: color }}
            aria-hidden="true"
          />
          {shortId || "Adam"}
        </span>
        <span className="text-[var(--app-text-subtle)]">
          {timeAgo(
            typeof message.createdAt === "number"
              ? message.createdAt
              : new Date(message.createdAt).getTime(),
          )}
        </span>
      </div>

      {/* Body: summary text */}
      <div className="whitespace-pre-wrap break-words text-[var(--app-text)]">
        {message.content}
      </div>

      {/* Attachments */}
      {message.attachments && message.attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--app-border)] pt-3">
          {message.attachments.map((a) => (
            <AttachmentChip key={a.artifactId} attachment={a} />
          ))}
        </div>
      ) : null}

      {/* Mirror suffix — crystal D-022 字面格式: "(also delivered to: <list> @ <HH:MM>)" */}
      {hasMirror ? (
        <div
          className="chat-mirror-suffix mt-2 text-[11px] italic text-[var(--app-text-subtle)]"
          data-testid="mirror-suffix"
        >
          (also delivered to:{" "}
          {message.mirroredToTargets!
            .map((t) => t.channelId ?? t.sessionId ?? "unknown")
            .join(", ")}{" "}
          @{" "}
          {new Date(
            typeof message.createdAt === "number"
              ? message.createdAt
              : new Date(message.createdAt).getTime(),
          )
            .toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}
          )
        </div>
      ) : null}
    </div>
  );
}
