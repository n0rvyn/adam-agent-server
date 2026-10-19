import type { TaskRequirements } from "../shared/types.js";

export const REQUIREMENTS_EMPTY = "REQUIREMENTS_EMPTY";
export const TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY = "TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY";

export function hasNonEmptyRequirements(requirements: TaskRequirements | undefined): boolean {
  if (!requirements) return false;
  return Boolean(
    requirements.tools?.length ||
    requirements.paths?.length ||
    requirements.osCapabilities?.length ||
    requirements.plugins?.length ||
    requirements.network === true,
  );
}

export function validateTaskInstructionContract(
  taskInstruction: string,
): { ok: true } | { ok: false; code: string; error: string } {
  const trimmed = taskInstruction.trim();
  if (!trimmed) {
    return { ok: false, code: "TASK_INSTRUCTION_EMPTY", error: "taskInstruction must not be empty." };
  }
  const firstSentence = trimmed.split(/[\n。.!?]/, 1)[0] ?? "";
  const identityDirective = /^\s*((你(现在)?是|作为|扮演)\s*\S+|(you are|act as)\s+\S+)/i.test(firstSentence);
  if (identityDirective) {
    return {
      ok: false,
      code: TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY,
      error:
        "taskInstruction must describe the work only. Select the Role with roleId; Role CAG prompt supplies identity/persona.",
    };
  }
  return { ok: true };
}
