// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlashMessage } from "../../../cli/tui/hooks/useFlashMessage.js";

describe("useFlashMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sets message and returns clear function", () => {
    const { result } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("Hello", "success");
    });

    expect(result.current.message).toEqual({ text: "Hello", type: "success" });

    act(() => {
      result.current.clearMessage();
    });

    expect(result.current.message).toBeNull();
  });

  it("auto-dismisses success message after 3 seconds", () => {
    const { result } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("Success!", "success");
    });

    expect(result.current.message).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.message).toBeNull();
  });

  it("does not auto-dismiss error messages", () => {
    const { result } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("Error!", "error");
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.message).toEqual({ text: "Error!", type: "error" });
  });

  it("does not auto-dismiss loading messages", () => {
    const { result } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("Loading...", "loading");
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.message).toEqual({ text: "Loading...", type: "loading" });
  });

  it("resets timer on repeated success messages", () => {
    const { result } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("First", "success");
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      result.current.setMessage("Second", "success");
    });

    // 500ms after second message — should still be visible
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.message).toEqual({ text: "Second", type: "success" });

    // 3000ms after second message — should be gone
    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(result.current.message).toBeNull();
  });

  it("cleans up timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const { result, unmount } = renderHook(() => useFlashMessage());

    act(() => {
      result.current.setMessage("Test", "success");
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
