// @vitest-environment happy-dom
/**
 * Focus-switch behavior: InputBar visibility under inline approval states.
 * Tests the same useReducer + Set<string> pattern App.tsx uses.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef, useReducer } from "react";

describe("Inline approval focus-switch", () => {
  function useFocusState(messages: Array<{ kind?: string; promptId?: string }>) {
    const submitted = useRef<Set<string>>(new Set());
    const failed = useRef<Set<string>>(new Set());
    const [, force] = useReducer((x: number) => x + 1, 0);
    const hasUnresolved = messages.some(
      (m) =>
        m.kind === "approval_prompt" &&
        m.promptId &&
        !submitted.current.has(m.promptId) &&
        !failed.current.has(m.promptId),
    );
    return {
      hasUnresolved,
      markSubmitted: (id: string) => {
        submitted.current.add(id);
        force();
      },
      markFailed: (id: string) => {
        failed.current.add(id);
        force();
      },
      clearBoth: () => {
        submitted.current.clear();
        failed.current.clear();
        force();
      },
    };
  }

  it("inline approval present → hasUnresolved is true (InputBar would hide)", () => {
    const messages = [{ kind: "approval_prompt", promptId: "A2K7" }];
    const { result } = renderHook(() => useFocusState(messages));
    expect(result.current.hasUnresolved).toBe(true);
  });

  it("after onSubmitted → hasUnresolved false (InputBar restored)", () => {
    const messages = [{ kind: "approval_prompt", promptId: "A2K7" }];
    const { result, rerender } = renderHook(
      ({ msgs }) => useFocusState(msgs),
      { initialProps: { msgs: messages } },
    );
    expect(result.current.hasUnresolved).toBe(true);
    act(() => result.current.markSubmitted("A2K7"));
    rerender({ msgs: messages });
    expect(result.current.hasUnresolved).toBe(false);
  });

  it("after onSubmitFailure → hasUnresolved false (InputBar restored, user can recover via token)", () => {
    const messages = [{ kind: "approval_prompt", promptId: "A2K7" }];
    const { result, rerender } = renderHook(
      ({ msgs }) => useFocusState(msgs),
      { initialProps: { msgs: messages } },
    );
    expect(result.current.hasUnresolved).toBe(true);
    act(() => result.current.markFailed("A2K7"));
    rerender({ msgs: messages });
    expect(result.current.hasUnresolved).toBe(false);
  });

  it("clearBoth (mirrors /new archive) resets both sets", () => {
    const messages = [{ kind: "approval_prompt", promptId: "A2K7" }];
    const { result, rerender } = renderHook(
      ({ msgs }) => useFocusState(msgs),
      { initialProps: { msgs: messages } },
    );
    act(() => result.current.markSubmitted("A2K7"));
    rerender({ msgs: messages });
    expect(result.current.hasUnresolved).toBe(false);
    act(() => result.current.clearBoth());
    rerender({ msgs: messages });
    // After clear, the same approval_prompt is unresolved again
    expect(result.current.hasUnresolved).toBe(true);
  });

  it("non-approval messages do not affect focus", () => {
    const messages = [
      { kind: "result_delivery" },
      { kind: "system_note" },
      { kind: "status_report" },
    ];
    const { result } = renderHook(() => useFocusState(messages));
    expect(result.current.hasUnresolved).toBe(false);
  });

  it("multiple approvals: any unresolved → hasUnresolved true", () => {
    const messages = [
      { kind: "approval_prompt", promptId: "A2K7" },
      { kind: "approval_prompt", promptId: "B3M4" },
    ];
    const { result, rerender } = renderHook(
      ({ msgs }) => useFocusState(msgs),
      { initialProps: { msgs: messages } },
    );
    act(() => result.current.markSubmitted("A2K7"));
    rerender({ msgs: messages });
    // B3M4 still unresolved
    expect(result.current.hasUnresolved).toBe(true);
    act(() => result.current.markFailed("B3M4"));
    rerender({ msgs: messages });
    expect(result.current.hasUnresolved).toBe(false);
  });
});
