import type { Task } from "../shared/types.js";

export function isTemplateExecutionStepTask(task: Pick<Task, "templateId" | "stepId" | "parentId">): boolean {
  return Boolean(task.templateId && task.stepId && task.parentId);
}
