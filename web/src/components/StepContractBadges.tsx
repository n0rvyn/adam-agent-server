import { useState } from "react";
import type { AuditViolation } from "@/lib/types";

export interface StepContractData {
  layerAPassed: boolean;
  layerBPassed: boolean | null;
  layerCPassed: boolean | null;
  violations: AuditViolation[];
}

interface StepContractBadgesProps {
  contract: StepContractData;
  retried?: boolean;
}

/** Returns the violation message for a given contract field, if any. */
function getViolationMessage(
  violations: AuditViolation[],
  field: AuditViolation["contractField"],
): string | null {
  const v = violations.find((v) => v.contractField === field);
  return v?.message ?? null;
}

/** Checkbox-style badge: green tick / red cross / gray dash */
function Badge({
  label,
  status,
  tooltip,
}: {
  label: string;
  status: "pass" | "fail" | "na";
  tooltip?: string | null;
}) {
  const [showTip, setShowTip] = useState(false);

  const color =
    status === "pass"
      ? "text-[var(--app-success-soft-text)]"
      : status === "fail"
        ? "text-[var(--app-danger-soft-text)]"
        : "text-[var(--app-text-subtle)]";

  const icon =
    status === "pass" ? "✓" : status === "fail" ? "✗" : "—";

  return (
    <span className="relative inline-flex items-center gap-0.5">
      <span
        className={`cursor-default text-xs font-medium ${color}`}
        onClick={() => setShowTip((v) => !v)}
        title={tooltip ?? undefined}
      >
        {label}:{icon}
      </span>
      {showTip && tooltip && (
        <span className="absolute bottom-full left-0 z-50 mb-1 w-48 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] shadow-md">
          {tooltip}
        </span>
      )}
    </span>
  );
}

export function StepContractBadges({ contract, retried }: StepContractBadgesProps) {
  const { violations, layerCPassed } = contract;

  const lengthViolation = getViolationMessage(violations, "lengthTarget");
  const identityViolation = getViolationMessage(violations, "persona.speakAs");
  const upstreamViolation = getViolationMessage(violations, "mustReferenceArtifacts");
  const customAssertionViolation = getViolationMessage(violations, "customAssertions");

  // Layer C badge state:
  //   layerCPassed === null  → step has no customAssertions configured → render N/A
  //   layerCPassed === true  → all custom assertions passed
  //   layerCPassed === false → at least one failed (tooltip shows the violation message)
  const layerCStatus: "pass" | "fail" | "na" =
    layerCPassed === null ? "na" : layerCPassed ? "pass" : "fail";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Badge
        label="长度"
        status={lengthViolation ? "fail" : "pass"}
        tooltip={lengthViolation}
      />
      <Badge
        label="身份"
        status={identityViolation ? "fail" : "pass"}
        tooltip={identityViolation}
      />
      <Badge
        label="上游引用"
        status={upstreamViolation ? "fail" : "pass"}
        tooltip={upstreamViolation}
      />
      <Badge
        label="自定义"
        status={layerCStatus}
        tooltip={customAssertionViolation}
      />
      {retried && (
        <span className="ml-1 rounded-full bg-[var(--app-warning-soft-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-warning-soft-text)]">
          重试 #1
        </span>
      )}
    </span>
  );
}
