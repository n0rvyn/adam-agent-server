import type { GoalStatus } from "../shared/types.js";

export interface GoalState {
  name: string;
  description?: string;
  metric: string;
  targetValue: number;
  currentValue: number;
  deadline: number;
  budget: number;
  roleId: string;
  status: GoalStatus;
}

export interface SMARTValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ParsedGoal {
  goalState: GoalState;
  validationResult: SMARTValidationResult;
  rawInput: string;
}
