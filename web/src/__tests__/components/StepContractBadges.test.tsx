import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../utils/test-utils";
import { StepContractBadges, type StepContractData } from "@/components/StepContractBadges";
import type { AuditViolation } from "@/lib/types";

const noViolations: AuditViolation[] = [];

const lengthViolation: AuditViolation = {
  id: "v1",
  stepTaskId: "task-1",
  roleId: "role-1",
  contractField: "lengthTarget",
  layer: "A",
  severity: "error",
  message: "actual 1850 chars / target 2200-2800 chars",
  createdAt: Date.now(),
};

const identityViolation: AuditViolation = {
  id: "v2",
  stepTaskId: "task-1",
  roleId: "role-1",
  contractField: "persona.speakAs",
  layer: "B",
  severity: "error",
  message: "expected first-person as 卞旸, but output self-identifies as 达芬奇",
  createdAt: Date.now(),
};

function makeContract(overrides: Partial<StepContractData>): StepContractData {
  return {
    layerAPassed: true,
    layerBPassed: true,
    violations: [],
    ...overrides,
  };
}

describe("StepContractBadges", () => {
  it("renders three badges when all pass", () => {
    const contract = makeContract({ layerAPassed: true, layerBPassed: true, violations: [] });
    render(<StepContractBadges contract={contract} retried={false} />);
    expect(screen.getByText(/长度:/)).toBeInTheDocument();
    expect(screen.getByText(/身份:/)).toBeInTheDocument();
    expect(screen.getByText(/上游引用:/)).toBeInTheDocument();
    // pass icons
    expect(screen.getByText("长度:✓")).toBeInTheDocument();
    expect(screen.getByText("身份:✓")).toBeInTheDocument();
    expect(screen.getByText("上游引用:✓")).toBeInTheDocument();
  });

  it("renders red cross for length violation with tooltip on click", async () => {
    const contract = makeContract({ layerAPassed: false, layerBPassed: null, violations: [lengthViolation] });
    render(<StepContractBadges contract={contract} retried={false} />);
    const lengthBadge = screen.getByText("长度:✗");
    expect(lengthBadge).toBeInTheDocument();
    // Click to reveal tooltip
    fireEvent.click(lengthBadge);
    expect(screen.getByText("actual 1850 chars / target 2200-2800 chars")).toBeInTheDocument();
  });

  it("renders red cross for identity violation with tooltip on click", () => {
    const contract = makeContract({ layerAPassed: true, layerBPassed: false, violations: [identityViolation] });
    render(<StepContractBadges contract={contract} retried={false} />);
    const identityBadge = screen.getByText("身份:✗");
    fireEvent.click(identityBadge);
    expect(screen.getByText("expected first-person as 卞旸, but output self-identifies as 达芬奇")).toBeInTheDocument();
  });

  it("shows 重试 #1 pill when retried is true", () => {
    const contract = makeContract({ layerAPassed: true, layerBPassed: true, violations: [] });
    render(<StepContractBadges contract={contract} retried={true} />);
    expect(screen.getByText("重试 #1")).toBeInTheDocument();
  });

  it("does not show 重试 pill when retried is false", () => {
    const contract = makeContract({ layerAPassed: true, layerBPassed: true, violations: [] });
    render(<StepContractBadges contract={contract} retried={false} />);
    expect(screen.queryByText("重试 #1")).not.toBeInTheDocument();
  });
});
