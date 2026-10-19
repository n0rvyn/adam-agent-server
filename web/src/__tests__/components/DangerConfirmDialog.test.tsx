import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "../utils/test-utils";
import { DangerConfirmDialog } from "@/components/artifacts/DangerConfirmDialog.tsx";

describe("DangerConfirmDialog", () => {
  const defaultProps = {
    open: true,
    dangerClass: "audio",
    originalFilename: "vacation.mp3",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("open=true — dialog is visible in DOM", () => {
    render(<DangerConfirmDialog {...defaultProps} />);
    expect(screen.getByTestId("danger-dialog")).toBeInTheDocument();
  });

  it("open=false — dialog is NOT in DOM", () => {
    render(<DangerConfirmDialog {...defaultProps} open={false} />);
    expect(screen.queryByTestId("danger-dialog")).not.toBeInTheDocument();
  });

  it("click Cancel calls onCancel", () => {
    render(<DangerConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId("danger-dialog-cancel"));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("click Confirm calls onConfirm", () => {
    render(<DangerConfirmDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId("danger-dialog-confirm"));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("press ESC calls onCancel", () => {
    render(<DangerConfirmDialog {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("dialog body text contains 'permanent'", () => {
    render(<DangerConfirmDialog {...defaultProps} />);
    const body = screen.getByTestId("danger-dialog-body");
    expect(body.textContent).toContain("permanent");
  });

  it("dialog body text contains dangerClass and filename is shown", () => {
    render(<DangerConfirmDialog {...defaultProps} dangerClass="video" originalFilename="clip.mp4" />);
    expect(screen.getByTestId("danger-dialog-body").textContent).toContain("video");
    expect(screen.getByTestId("danger-dialog-filename").textContent).toContain("clip.mp4");
  });
});
