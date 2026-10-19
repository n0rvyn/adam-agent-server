import { v4 as uuidv4 } from "uuid";
import { createGoal, getGoal, updateGoal } from "../store/goals.js";
import { createMetricNode } from "../store/metrics.js";
import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { getLogger } from "../lib/logger.js";
import type { Goal, NotifyTarget, MetricNode, Role } from "../shared/types.js";
import type { GoalState, SMARTValidationResult, ParsedGoal } from "./types.js";

const log = getLogger("goal-manager");
const VALID_ROLES: string[] = [];  // Phase 1: roleId is a free-form string FK, not enum

/**
 * Parse goal input into a GoalState.
 * JSON input → direct field extraction (sync path).
 * Natural language input → LLM extracts SMART fields (async path).
 */
export async function parseGoal(input: string): Promise<ParsedGoal> {
  let goalState: GoalState;

  try {
    const parsed = JSON.parse(input);
    goalState = {
      name: parsed.name ?? "",
      description: parsed.description,
      metric: parsed.metric ?? "",
      targetValue: parsed.targetValue ?? 0,
      currentValue: parsed.currentValue ?? 0,
      deadline: parsed.deadline ?? 0,
      budget: parsed.budget ?? 0,
      roleId: parsed.roleId ?? "engineer",
      status: "active",
    };
  } catch {
    // Natural language input — use LLM to extract SMART fields
    goalState = await parseGoalWithLlm(input);
  }

  const validationResult = validateSMART(goalState);

  return {
    goalState,
    validationResult,
    rawInput: input,
  };
}

/**
 * Use LLM to extract SMART goal fields from natural language input.
 */
async function parseGoalWithLlm(input: string): Promise<GoalState> {
  const prompt = `Extract SMART goal fields from this natural language input.

Input: "${input}"

Respond ONLY with a JSON object:
{
  "name": "short goal name (max 100 chars)",
  "description": "detailed description of what the goal aims to achieve",
  "metric": "measurable metric name (e.g. completion, reports_written, accuracy_score)",
  "targetValue": <number, the target to reach>,
  "deadline_days": <number, days from now to complete>,
  "budget": <number, estimated budget in USD>,
  "role": "<best matching role: engineer | analyst | content_creator | reviewer>"
}

Rules:
- name: concise, actionable title
- metric: quantifiable measure of success; use "completion" if the goal is binary (done/not done)
- targetValue: realistic target for the metric; use 1 for binary goals
- deadline_days: reasonable timeframe; default 7 if unclear
- budget: estimated cost in USD; default 5 if unclear
- role: match to the nature of work (research=analyst, writing=content_creator, coding=engineer, review=reviewer)`;

  try {
    const result = await callClaudeForEvaluation(
      prompt,
      "You extract structured SMART goal fields from natural language. Reply with only valid JSON.",
    );

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const deadlineDays = parsed.deadline_days ?? 7;
      return {
        name: (parsed.name ?? input.slice(0, 100)).slice(0, 100),
        description: parsed.description ?? input,
        metric: parsed.metric ?? "completion",
        targetValue: parsed.targetValue ?? 1,
        currentValue: 0,
        deadline: Date.now() + deadlineDays * 24 * 60 * 60 * 1000,
        budget: parsed.budget ?? 5,
        roleId: parsed.roleId ?? "engineer",
        status: "active",
      };
    }
  } catch (err) {
    log.warn({ error: err }, "LLM goal parsing failed, using fallback");
  }

  // Fallback: if LLM is unavailable, fill sensible defaults
  return {
    name: input.trim().slice(0, 100),
    description: input.trim(),
    metric: "completion",
    targetValue: 1,
    currentValue: 0,
    deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
    budget: 5,
    roleId: "engineer",
    status: "active",
  };
}

export function validateSMART(goal: GoalState): SMARTValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!goal.name || goal.name.trim().length === 0) {
    errors.push("S: name must be non-empty");
  }
  if (!goal.description || goal.description.trim().length === 0) {
    errors.push("S: description must be non-empty");
  }
  if (!goal.metric || goal.metric.trim().length === 0) {
    errors.push("M: metric must be specified");
  }
  if (goal.targetValue <= 0) {
    errors.push("A: targetValue must be > 0");
  }
  if (!goal.roleId || goal.roleId.trim().length === 0) {
    errors.push("R: roleId must be non-empty");
  }
  if (goal.deadline <= Date.now()) {
    errors.push("T: deadline must be in the future");
  }
  if (goal.budget <= 0) {
    warnings.push("budget is zero or negative; goal will have no spending limit");
  }

  return { isValid: errors.length === 0, errors, warnings };
}

export function persistGoal(goalState: GoalState, deliverTo?: NotifyTarget[], reportTo?: NotifyTarget[]): Goal {
  const id = uuidv4();
  const now = Date.now();

  const goal: Goal = {
    id,
    name: goalState.name,
    description: goalState.description,
    roleId: goalState.roleId,
    metricType: goalState.metric,
    targetValue: goalState.targetValue,
    currentValue: goalState.currentValue,
    deadline: goalState.deadline,
    budgetUsd: goalState.budget,
    status: goalState.status,
    createdAt: now,
    deliverTo,
    reportTo,
  };

  createGoal(goal);
  return goal;
}

export function buildMetricTree(goalId: string, metricType: string): MetricNode[] {
  const now = Date.now();
  const nodes: MetricNode[] = [];

  const l0: MetricNode = {
    id: uuidv4(), goalId, level: "L0",
    name: `${metricType}_goal_progress`,
    description: `Goal-level ${metricType} progress (monthly)`,
    weight: 1.0, calibrationFactor: 1.0, createdAt: now,
  };
  nodes.push(l0);
  createMetricNode(l0);

  const l1: MetricNode = {
    id: uuidv4(), goalId, level: "L1", parentId: l0.id,
    name: `${metricType}_weekly_trend`,
    description: `Weekly trend for ${metricType}`,
    weight: 0.8, calibrationFactor: 1.0, createdAt: now,
  };
  nodes.push(l1);
  createMetricNode(l1);

  const l2: MetricNode = {
    id: uuidv4(), goalId, level: "L2", parentId: l1.id,
    name: `${metricType}_daily_process`,
    description: `Daily process metric for ${metricType}`,
    weight: 0.6, calibrationFactor: 1.0, createdAt: now,
  };
  nodes.push(l2);
  createMetricNode(l2);

  const l3: MetricNode = {
    id: uuidv4(), goalId, level: "L3", parentId: l2.id,
    name: `${metricType}_per_task`,
    description: `Per-task instant metric for ${metricType}`,
    weight: 0.4, calibrationFactor: 1.0, createdAt: now,
  };
  nodes.push(l3);
  createMetricNode(l3);

  return nodes;
}

export function getGoalState(goalId: string): GoalState | undefined {
  const goal = getGoal(goalId);
  if (!goal) return undefined;

  return {
    name: goal.name,
    description: goal.description,
    metric: goal.metricType,
    targetValue: goal.targetValue,
    currentValue: goal.currentValue,
    deadline: goal.deadline,
    budget: goal.budgetUsd,
    roleId: goal.roleId,
    status: goal.status,
  };
}

export function updateGoalProgress(goalId: string, currentValue: number): void {
  updateGoal(goalId, { currentValue, updatedAt: Date.now() });
}
