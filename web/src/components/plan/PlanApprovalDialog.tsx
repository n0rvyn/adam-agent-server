import { useState, useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/AlertDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

const APPROVAL_TIMEOUT_SECONDS = 300;

function riskVariant(risk: string): "default" | "destructive" | "outline" | "secondary" {
  if (risk === "high") return "destructive";
  if (risk === "medium") return "outline";
  return "secondary";
}

export function PlanApprovalDialog() {
  const pendingPlanApproval = useAppStore((s) => s.pendingPlanApproval);
  const approvePlan = useAppStore((s) => s.approvePlan);
  const denyPlan = useAppStore((s) => s.denyPlan);
  const planTimeoutNotice = useAppStore((s) => s.planTimeoutNotice);
  const clearPlanTimeoutNotice = useAppStore((s) => s.clearPlanTimeoutNotice);

  const [secondsLeft, setSecondsLeft] = useState(APPROVAL_TIMEOUT_SECONDS);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!pendingPlanApproval) {
      setSecondsLeft(APPROVAL_TIMEOUT_SECONDS);
      setSubmitting(false);
      return;
    }
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [pendingPlanApproval?.planId]);

  // Auto-deny on timeout
  useEffect(() => {
    if (secondsLeft === 0 && pendingPlanApproval && !submitting) {
      setSubmitting(true);
      denyPlan(pendingPlanApproval.taskId, pendingPlanApproval.planId, "timeout").catch(() => {});
    }
  }, [secondsLeft, pendingPlanApproval, submitting, denyPlan]);

  const handleApprove = async (approvalType: "once" | "permanent") => {
    if (!pendingPlanApproval) return;
    setSubmitting(true);
    try {
      await approvePlan(pendingPlanApproval.taskId, pendingPlanApproval.planId, approvalType);
    } catch {
      setSubmitting(false);
    }
  };

  const handleDeny = async () => {
    if (!pendingPlanApproval) return;
    setSubmitting(true);
    try {
      await denyPlan(pendingPlanApproval.taskId, pendingPlanApproval.planId);
    } catch {
      setSubmitting(false);
    }
  };

  const plan = pendingPlanApproval?.plan;

  return (
    <>
      <AlertDialog open={!!pendingPlanApproval}>
        <AlertDialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              Execution Plan — Approval Required
              {plan && (
                <Badge variant={riskVariant(plan.overallRisk)}>
                  {plan.overallRisk.toUpperCase()} RISK
                </Badge>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-[var(--app-text-muted)]">
              Plan {pendingPlanApproval?.planId} | Task {pendingPlanApproval?.taskId} | {secondsLeft}s remaining
            </AlertDialogDescription>
          </AlertDialogHeader>

          {plan && (
            <div className="space-y-4 py-2">
              <div>
                <h4 className="text-sm font-medium text-[var(--app-text)] mb-2">
                  Plan Steps ({plan.steps.length})
                </h4>
                <div className="space-y-2">
                  {plan.steps.map((step) => (
                    <div key={step.index} className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)]/50 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-[var(--app-text-subtle)]">#{step.index}</span>
                          <span className="text-sm text-[var(--app-text)]">{step.description}</span>
                        </div>
                        <Badge variant={riskVariant(step.riskLevel)}>
                          {step.riskLevel}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-[var(--app-text-muted)]">
                        Tools: {step.toolsNeeded.join(", ") || "none"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {Object.keys(plan.requiredPermissions).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-[var(--app-text)] mb-1">Required Permissions</h4>
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(plan.requiredPermissions).map((perm) => (
                      <Badge key={perm} variant="secondary">{perm}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <Button variant="destructive" onClick={handleDeny} disabled={submitting}>
              Deny
            </Button>
            <Button variant="outline" onClick={() => handleApprove("permanent")} disabled={submitting}>
              Allow Permanent
            </Button>
            <Button onClick={() => handleApprove("once")} disabled={submitting}>
              Allow Once
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {planTimeoutNotice && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] px-4 py-2 text-sm text-[var(--app-warning-soft-text)] shadow-[var(--app-shadow-lg)]">
          {planTimeoutNotice}
          <button
            className="ml-3 text-[var(--app-warning)] hover:text-[var(--app-warning-soft-text)]"
            onClick={clearPlanTimeoutNotice}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
