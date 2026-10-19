import { getGoal } from "../store/goals.js";
import { getRole } from "../store/roles.js";
import type { Goal, GoalStatus, TaskStep, TaskTemplate } from "../shared/types.js";

export interface GoalExecutionStepMeta {
  goal: Goal;
  index: number;
  decomposeStepId: string;
  reviewStepId: string;
}

export interface GoalTemplateExpansion {
  steps: TaskStep[];
  goalSteps: GoalExecutionStepMeta[];
}

export interface ParsedGoalReview {
  goalAchieved?: boolean;
  currentValue?: number;
  status?: Extract<GoalStatus, "active" | "completed" | "failed">;
  reason?: string;
}

function cloneStep(step: TaskStep): TaskStep {
  return {
    ...step,
    dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
    requirements: step.requirements ? { ...step.requirements } : undefined,
    config: step.config ? { ...step.config } : undefined,
  };
}

function roleFieldsForGoalStep(
  goal: Goal,
  template: TaskTemplate,
): Pick<TaskStep, "roleId" | "autoSelectRole" | "requirements"> {
  if (template.rolePreference) return {};
  const goalRole = goal.roleId ? getRole(goal.roleId) : undefined;
  if (goalRole?.status === "active") return { roleId: goal.roleId };
  return { autoSelectRole: true, requirements: {} };
}

function buildGoalFacts(goal: Goal): string {
  return [
    `Goal ID: ${goal.id}`,
    `Name: ${goal.name}`,
    `Description: ${goal.description ?? "(none)"}`,
    `Metric: ${goal.metricType}`,
    `Target value: ${goal.targetValue}`,
    `Current value: ${goal.currentValue}`,
    `Deadline ms: ${goal.deadline}`,
    `Budget USD: ${goal.budgetUsd}`,
    `Status: ${goal.status}`,
  ].join("\n");
}

function buildDecomposePrompt(goal: Goal): string {
  return [
    "Decompose this Goal into execution guidance for the following Template steps.",
    "",
    buildGoalFacts(goal),
    "",
    "Return concise guidance that downstream Template steps can use. Do not create tasks. Do not update Goal state.",
  ].join("\n");
}

function buildGoalContextPrefix(goalSteps: GoalExecutionStepMeta[]): string {
  const refs = goalSteps
    .map((meta) => `Goal ${meta.index + 1} decomposition:\n{{${meta.decomposeStepId}.result}}`)
    .join("\n\n");
  return [
    "Goal execution context:",
    refs,
    "",
    "Original Template step:",
  ].join("\n");
}

function buildReviewPrompt(goal: Goal, terminalStepIds: string[]): string {
  const terminalRefs = terminalStepIds.length > 0
    ? terminalStepIds.map((stepId) => `Step ${stepId} result:\n{{${stepId}.result}}`).join("\n\n")
    : "(no user step results)";
  return [
    "Review whether this Goal was achieved by this TemplateExecution.",
    "",
    buildGoalFacts(goal),
    "",
    terminalRefs,
    "",
    "Respond with exactly one JSON object and no markdown:",
    '{"goalAchieved": true, "currentValue": 1, "status": "completed", "reason": "..."}',
    "",
    "Use status \"completed\" only when the Goal is achieved. Use status \"active\" when more work remains. Use status \"failed\" only when the Goal cannot be achieved from this run.",
  ].join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function nextSyntheticStepId(baseId: string, usedStepIds: Set<string>): string {
  let candidate = baseId;
  let suffix = 2;
  while (usedStepIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix++;
  }
  usedStepIds.add(candidate);
  return candidate;
}

export function expandGoalTemplateSteps(template: TaskTemplate): GoalTemplateExpansion {
  const originalSteps = template.steps.map(cloneStep);
  const goals = (template.goalIds ?? [])
    .map((goalId) => getGoal(goalId))
    .filter((goal): goal is Goal => goal !== undefined);

  if (goals.length === 0) {
    return { steps: originalSteps, goalSteps: [] };
  }

  const usedStepIds = new Set(originalSteps.map((step) => step.id));
  const goalSteps: GoalExecutionStepMeta[] = goals.map((goal, index) => ({
    goal,
    index,
    decomposeStepId: nextSyntheticStepId(`goal-${index + 1}-decompose`, usedStepIds),
    reviewStepId: nextSyntheticStepId(`goal-${index + 1}-review`, usedStepIds),
  }));
  const decomposeStepIds = goalSteps.map((meta) => meta.decomposeStepId);
  const goalContextPrefix = buildGoalContextPrefix(goalSteps);

  const decomposeSteps: TaskStep[] = goalSteps.map((meta) => ({
    id: meta.decomposeStepId,
    prompt: buildDecomposePrompt(meta.goal),
    ...roleFieldsForGoalStep(meta.goal, template),
  }));

  const userSteps = originalSteps.map((step) => {
    const existingDependsOn = step.dependsOn ?? [];
    const isRoot = existingDependsOn.length === 0;
    const next: TaskStep = {
      ...step,
      prompt: isRoot ? `${goalContextPrefix}\n\n${step.prompt}` : step.prompt,
    };
    if (isRoot) {
      next.dependsOn = unique([...decomposeStepIds, ...existingDependsOn]);
    } else if (step.dependsOn) {
      next.dependsOn = [...step.dependsOn];
    }
    return next;
  });

  const dependedOn = new Set<string>();
  for (const step of userSteps) {
    for (const depId of step.dependsOn ?? []) dependedOn.add(depId);
  }
  const terminalUserStepIds = userSteps
    .filter((step) => !dependedOn.has(step.id))
    .map((step) => step.id);
  const reviewDependsOn = terminalUserStepIds.length > 0 ? terminalUserStepIds : decomposeStepIds;

  const reviewSteps: TaskStep[] = goalSteps.map((meta) => ({
    id: meta.reviewStepId,
    prompt: buildReviewPrompt(meta.goal, terminalUserStepIds),
    dependsOn: [...reviewDependsOn],
    ...roleFieldsForGoalStep(meta.goal, template),
  }));

  return {
    steps: [...decomposeSteps, ...userSteps, ...reviewSteps],
    goalSteps,
  };
}

export function parseGoalReviewResult(raw: string | undefined): ParsedGoalReview | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const input = parsed as Record<string, unknown>;
  const out: ParsedGoalReview = {};
  if (typeof input.goalAchieved === "boolean") out.goalAchieved = input.goalAchieved;
  if (typeof input.currentValue === "number" && Number.isFinite(input.currentValue)) {
    out.currentValue = input.currentValue;
  }
  if (input.status === "active" || input.status === "completed" || input.status === "failed") {
    out.status = input.status;
  }
  if (typeof input.reason === "string") out.reason = input.reason;

  return Object.keys(out).length > 0 ? out : undefined;
}
