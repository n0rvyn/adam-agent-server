import type { Strategy } from "../shared/types.js";
import { StrategyEngine } from "./engine.js";

const DEFAULT_TOP_K = 3;
const DEFAULT_NEW_VARIANTS = 2;

/**
 * Strategy Generator - LLM-driven evolution of strategies.
 * Crystal ref: D-009 (LLM evolution layer)
 *
 * Given top-K performing strategies, generates new prompt_template variants
 * through crossover and mutation. Uses role's evaluationCriteria to guide evolution.
 *
 * Phase 3: heuristic mutation. Phase 5: full LLM-driven evolution via Manager Agent.
 */
export class StrategyGenerator {
  /**
   * Generate new strategy variants from top-K performing strategies.
   */
  static async generateVariants(
    roleId: string,
    taskType: string,
    topK = DEFAULT_TOP_K,
    numVariants = DEFAULT_NEW_VARIANTS,
  ): Promise<string[]> {
    const topStrategies = StrategyEngine.getTopStrategies(roleId, taskType, topK);

    if (topStrategies.length === 0) {
      const baselineName = `baseline-${taskType}-v1`;
      StrategyEngine.addStrategy(
        roleId,
        taskType,
        baselineName,
        this.generateBaselinePrompt(roleId, taskType),
      );
      return [baselineName];
    }

    const newVariantNames: string[] = [];

    for (let i = 0; i < numVariants; i++) {
      const variantNum = topStrategies[0].totalTrials + i + 1;
      const variantName = `${taskType}-evolved-v${variantNum}`;

      const baseTemplate = topStrategies[0].promptTemplate;
      const mutatedTemplate = this.mutateTemplate(baseTemplate);

      StrategyEngine.addStrategy(roleId, taskType, variantName, mutatedTemplate);
      newVariantNames.push(variantName);
    }

    return newVariantNames;
  }

  /**
   * Generate baseline prompt for a role/task_type combination.
   */
  static generateBaselinePrompt(roleId: string, taskType: string): string {
    return `You are a ${roleId} agent specializing in ${taskType}.

## Core Focus
Complete tasks with high quality.

## Approach
1. Understand the task requirements thoroughly
2. Plan your approach before executing
3. Execute systematically, checking your work
4. Verify completion against requirements`;
  }

  /**
   * Mutate a prompt template with heuristic variations.
   * Phase 5 replaces this with LLM-based mutation.
   */
  private static mutateTemplate(baseTemplate: string): string {
    const mutations = [
      this.addProcessEmphasis(),
      this.addQualityFocus(),
      this.addVerificationStep(),
    ];

    const mutation = mutations[Math.floor(Math.random() * mutations.length)];
    return `${baseTemplate}\n\n## Evolution\n${mutation}`;
  }

  private static addProcessEmphasis(): string {
    const processes = [
      "Break down complex tasks into smaller steps",
      "Iterate on solutions, testing each component",
      "Document your reasoning at each step",
    ];
    return `**Process:** ${processes[Math.floor(Math.random() * processes.length)]}`;
  }

  private static addQualityFocus(): string {
    const focuses = [
      "Double-check all outputs before completing",
      "Consider edge cases and error conditions",
      "Optimize for correctness over speed",
    ];
    return `**Quality:** ${focuses[Math.floor(Math.random() * focuses.length)]}`;
  }

  private static addVerificationStep(): string {
    return `**Verification:** After completing, verify your work meets all requirements.`;
  }

  /**
   * Full LLM-driven evolution (Phase 5 integration).
   */
  static async generateWithLLM(
    roleId: string,
    taskType: string,
    _topStrategies: Strategy[],
  ): Promise<{ promptTemplate: string; rationale: string }> {
    const baseline = this.generateBaselinePrompt(roleId, taskType);
    return {
      promptTemplate: baseline,
      rationale: "Generated baseline - LLM integration in Phase 5",
    };
  }
}
