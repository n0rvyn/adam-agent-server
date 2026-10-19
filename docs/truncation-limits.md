# Truncation Limits Registry

All content truncation points in the codebase. Each entry records what is truncated, where, the current limit, and the rationale.

Last updated: 2026-04-19

## LLM Input Truncation (affects report quality)

These limits control how much context the LLM sees when generating user-facing reports. Too low = shallow, inaccurate summaries.

| Content | File | Line | Old | Current | Rationale |
|---------|------|------|-----|---------|-----------|
| Event firing payload → list_event_firings display | `src/manager/adam-tools.ts` | 1350 | — (new) | 500 | LLM context economy; full payload available via REST GET /event-defs/:id/firings |
| Task result → completion report | `src/manager/chat-manager.ts` | 417 | 500 | 4000 | #144 root cause. LLM generates completion summary from this input; 500 chars only covered the first paragraph of multi-KB results |
| Error → failure report | `src/manager/chat-manager.ts` | 416 | 300 | 1500 | Stack traces with file paths routinely exceed 300 chars; LLM needs full trace to diagnose accurately |
| Prompt → status report | `src/manager/chat-manager.ts` | 291 | 200 | 1000 | Complex task prompts (multi-step, with context) need more than 200 chars for the LLM to describe what's running |
| Role CAG prompt → execution system prompt | `src/manager/execution-system-prompt.ts` | 13 | 200 | unlimited | CAG prompts define role behavior; 200 chars discarded most of the behavioral instructions during execution |

## Memory Truncation (affects learning quality)

These limits control how much content is persisted to the memory system.

| Content | File | Line | Old | Current | Rationale |
|---------|------|------|-----|---------|-----------|
| Task reasoning transcript → task-complete reasoning memory | `src/manager/hooks.ts` | 312 | 800 | 3000 | Decision chains in complex tasks span thousands of chars; 800 only captured the opening reasoning |
| SDK PostCompact summary → decision memory | `src/manager/hooks.ts` | 384 | 2000 | 5000 | SDK compact summaries carry key decisions made during long sessions; mid/late-session decisions were lost |

## Delivery Truncation (affects result delivery)

| Content | File | Line | Old | Current | Rationale |
|---------|------|------|-----|---------|-----------|
| Task result → origin channel fallback (deliverTo empty) | `src/manager/chat-manager.ts` | 502 | 2000 | 4000 | WeChat flooding guard. Has "查看完整结果请访问 Web UI" suffix. 2000 was too short for code-heavy results |

## Unchanged Truncations (intentional, reviewed 2026-04-10)

These were reviewed and kept at current levels.

| Content | File | Line | Limit | Why kept |
|---------|------|------|-------|----------|
| Tool output → step_log content field | `src/manager/hooks.ts` | 317 | 200 | Display-only summary line; full output is stored in `toolOutput` column |
| stderr → debug log | `src/manager/chat-manager.ts` | 187 | 500 | Log noise control; stderr is diagnostic, not user-facing |
| Memory fact content | `src/agent/memory-extractor.ts` | 125 | 500 | Individual memory nodes; retrieval combines multiple nodes |
| Memory fact content | `src/agent/session-memory-extractor.ts` | 64 | 500 | Same as above |

## UI/CLI Display Truncations (cosmetic, not documented individually)

- UUID display: `slice(0, 8)` — standard short-ID pattern across TUI and CLI
- chatId in logs: `slice(0, 12)` — privacy + readability
- CLI table columns: `truncate(s, N)` functions — terminal width constraint
- API key masking: `slice(0, 4) + "****"` — security

These are presentation-layer only and do not affect data integrity or LLM behavior.
