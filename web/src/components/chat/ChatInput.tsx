import { useState, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/Button.tsx";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
  starterActions?: Array<{ label: string; value: string }>;
  showStarterActions?: boolean;
  compact?: boolean;
}

export function ChatInput({
  onSend,
  disabled,
  placeholder = "Type a message...",
  starterActions = [],
  showStarterActions = true,
  compact = false,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  };

  return (
    <div className={compact ? "rounded-xl border border-[var(--app-border)] bg-white/[0.03] p-3" : "surface-panel-elevated rounded-xl p-3"}>
      {showStarterActions && starterActions.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {starterActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setValue(action.value);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              className="rounded-full border border-[var(--app-border)] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-12 flex-1 resize-none rounded-lg border border-[var(--app-border)] bg-white/[0.04] px-4 py-3 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-border-strong)] focus:outline-none focus:ring-1 focus:ring-[var(--app-accent)] disabled:opacity-50"
        />
        <Button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          size="default"
          aria-label="Send message"
        >
          <Send size={16} />
          Send
        </Button>
      </div>
      <div className="mt-2 text-xs text-[var(--app-text-subtle)]">
        Enter to send; Shift+Enter for a new line.
      </div>
    </div>
  );
}
