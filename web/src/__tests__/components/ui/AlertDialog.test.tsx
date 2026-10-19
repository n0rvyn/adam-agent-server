import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../utils/test-utils";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";

function TestDialog({ onAction, onCancel }: { onAction?: () => void; onCancel?: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button>Open</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm Action</AlertDialogTitle>
          <AlertDialogDescription>Are you sure?</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onAction}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("AlertDialog", () => {
  it("renders trigger button", () => {
    render(<TestDialog />);
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });

  it("does not show dialog content initially", () => {
    render(<TestDialog />);
    expect(screen.queryByText("Confirm Action")).not.toBeInTheDocument();
  });

  it("opens dialog when trigger clicked", () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Confirm Action")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("shows action and cancel buttons when open", () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("fires action callback on action click", () => {
    const onAction = vi.fn();
    render(<TestDialog onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("fires cancel callback on cancel click", () => {
    const onCancel = vi.fn();
    render(<TestDialog onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes dialog after action", () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Confirm Action")).not.toBeInTheDocument();
  });

  it("closes dialog after cancel", () => {
    render(<TestDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm Action")).not.toBeInTheDocument();
  });

  it("applies className to AlertDialogContent", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent className="custom-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Test</AlertDialogTitle>
            <AlertDialogDescription>Desc</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = document.querySelector('[role="alertdialog"]');
    expect(content?.className).toContain("custom-dialog");
    expect(content?.className).toContain("border-[var(--app-border)]");
  });

  it("has slide animation classes on AlertDialogContent", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Test</AlertDialogTitle>
            <AlertDialogDescription>Desc</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = document.querySelector('[role="alertdialog"]');
    expect(content?.className).toContain("slide-in-from-left-1/2");
    expect(content?.className).toContain("slide-in-from-top-[48%]");
    expect(content?.className).toContain("slide-out-to-left-1/2");
    expect(content?.className).toContain("slide-out-to-top-[48%]");
  });
});
