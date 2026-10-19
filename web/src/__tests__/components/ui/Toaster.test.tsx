import { describe, it, expect, vi } from "vitest";
import { render } from "../../utils/test-utils";

vi.mock("sonner", () => ({
  Toaster: vi.fn((props: Record<string, unknown>) => <div data-testid="sonner-toaster" data-theme={props.theme as string} />),
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Toaster } from "@/components/ui/Toaster";
import { Toaster as SonnerMock } from "sonner";

describe("Toaster", () => {
  it("renders without crash", () => {
    const { container } = render(<Toaster />);
    expect(container.querySelector('[data-testid="sonner-toaster"]')).toBeInTheDocument();
  });

  it("passes dark theme to Sonner", () => {
    render(<Toaster />);
    expect(SonnerMock).toHaveBeenCalled();
    const call = (SonnerMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toHaveProperty("theme", "dark");
  });

  it("passes position prop through", () => {
    render(<Toaster position="bottom-center" />);
    const call = (SonnerMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toHaveProperty("position", "bottom-center");
  });

  it("passes toastOptions with dark-themed classNames", () => {
    render(<Toaster />);
    const call = (SonnerMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toHaveProperty("toastOptions");
    const classNames = call.toastOptions.classNames;
    expect(classNames.toast).toContain("bg-[var(--app-panel)]");
    expect(classNames.toast).toContain("text-[var(--app-text)]");
    expect(classNames.toast).toContain("border-[var(--app-border)]");
    expect(classNames.description).toContain("text-[var(--app-text-muted)]");
    expect(classNames.actionButton).toContain("bg-[var(--app-accent)]");
    expect(classNames.cancelButton).toContain("bg-[var(--app-panel-elevated)]");
  });
});
