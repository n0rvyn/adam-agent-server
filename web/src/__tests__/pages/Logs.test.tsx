import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "../utils/test-utils";
import { Logs } from "@/pages/Logs";
import { useAppStore } from "@/store/useAppStore";
import { mockLogs } from "../fixtures";

describe("Logs", () => {
  beforeEach(() => {
    useAppStore.setState({ logs: mockLogs });
  });

  it("should render page title", () => {
    render(<Logs />);
    expect(screen.getByRole("heading", { level: 1, name: "Logs" })).toBeInTheDocument();
  });

  it("should render log entries", () => {
    render(<Logs />);
    expect(screen.getByText("Task dispatched to skill agent-001")).toBeInTheDocument();
    expect(screen.getByText("Processing task step 1")).toBeInTheDocument();
    expect(screen.getByText("Rate limit approaching threshold")).toBeInTheDocument();
  });

  it("should show level filter buttons", () => {
    render(<Logs />);
    // Level names appear in both filter buttons and log entries
    expect(screen.getAllByText("debug").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("info").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("warn").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("error").length).toBeGreaterThanOrEqual(1);
  });

  it("should show component filter buttons", () => {
    render(<Logs />);
    // Component names appear in both filter buttons and log entries
    expect(screen.getAllByText("manager").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("api").length).toBeGreaterThanOrEqual(1);
  });

  it("should have auto-scroll toggle button", () => {
    render(<Logs />);
    const pauseButton = document.querySelector('button[title="Pause auto-scroll"]');
    expect(pauseButton).toBeInTheDocument();
  });

  it("should have clear logs button", () => {
    render(<Logs />);
    const clearButton = document.querySelector('button[title="Clear logs"]');
    expect(clearButton).toBeInTheDocument();
  });

  it("should show log count", () => {
    render(<Logs />);
    expect(screen.getByText("3 entries")).toBeInTheDocument();
  });

  it("should clear logs when clear button clicked", () => {
    render(<Logs />);
    const clearButton = document.querySelector('button[title="Clear logs"]')!;
    fireEvent.click(clearButton);
    expect(screen.getByText("No log entries")).toBeInTheDocument();
  });

  it("should show empty state when no logs", () => {
    useAppStore.setState({ logs: [] });
    render(<Logs />);
    expect(screen.getByText("No log entries")).toBeInTheDocument();
  });

  it("should toggle auto-scroll text", () => {
    render(<Logs />);
    expect(screen.getByText("Following live feed")).toBeInTheDocument();

    const toggleButton = document.querySelector('button[title="Pause auto-scroll"]')!;
    fireEvent.click(toggleButton);

    expect(screen.getByText("Scroll paused")).toBeInTheDocument();
  });
});
