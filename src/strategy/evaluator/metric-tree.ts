import type { MetricNode, MetricLevel } from "../../shared/types.js";
import { listMetricsByGoal } from "../../store/metrics.js";

const LEVEL_WEIGHTS: Record<MetricLevel, number> = {
  L0: 0.20,
  L1: 0.15,
  L2: 0.35,
  L3: 0.30,
};

/**
 * MetricTree - hierarchical metric aggregation utility.
 * Crystal ref: D-012
 *
 * Stateless aggregation: collectors compute scores externally,
 * MetricTree combines them using weights and calibration factors.
 * DP-001-P4: aggregateScores accepts Map<string, number>.
 */
export class MetricTree {
  readonly goalId: string;
  readonly nodes: Map<string, MetricNode>;
  private children: Map<string | undefined, MetricNode[]>;

  private constructor(goalId: string, nodes: MetricNode[]) {
    this.goalId = goalId;
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.children = new Map();

    for (const node of nodes) {
      const parentKey = node.parentId;
      const siblings = this.children.get(parentKey) ?? [];
      siblings.push(node);
      this.children.set(parentKey, siblings);
    }

    this.validateAcyclicity();
  }

  private validateAcyclicity(): void {
    for (const node of this.nodes.values()) {
      if (node.parentId && !this.nodes.has(node.parentId)) {
        // Parent references non-existent node; treat as root
        continue;
      }
      // Walk up to detect cycles
      const visited = new Set<string>();
      let current: string | undefined = node.id;
      while (current) {
        if (visited.has(current)) {
          throw new Error(`Cycle detected in metric tree at node ${current}`);
        }
        visited.add(current);
        current = this.nodes.get(current)?.parentId;
      }
    }
  }

  static buildFromGoal(goalId: string): MetricTree {
    const nodes = listMetricsByGoal(goalId);
    return new MetricTree(goalId, nodes);
  }

  static fromNodes(goalId: string, nodes: MetricNode[]): MetricTree {
    return new MetricTree(goalId, nodes);
  }

  queryPath(level: MetricLevel): MetricNode[] {
    const result: MetricNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.level === level) {
        result.push(node);
      }
    }
    return result.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Aggregate scores for a specific level.
   * Scores map: nodeId → score (0-1).
   * Returns weighted sum normalized by total weight.
   */
  aggregateScores(level: MetricLevel, scores: Map<string, number>): number {
    const levelNodes = this.queryPath(level);
    if (levelNodes.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const node of levelNodes) {
      const score = scores.get(node.id) ?? 0;
      const weight = node.weight * node.calibrationFactor;
      weightedSum += score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Compute overall weighted score across all levels.
   * Crystal D-013: TS runs on L2/L3 (higher weights).
   */
  getWeightedScore(allScores: Map<string, number>): number {
    let total = 0;

    for (const [level, levelWeight] of Object.entries(LEVEL_WEIGHTS) as [MetricLevel, number][]) {
      const levelScore = this.aggregateScores(level, allScores);
      total += levelScore * levelWeight;
    }

    return Math.max(0, Math.min(1, total));
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  getChildren(parentId: string | undefined): MetricNode[] {
    return this.children.get(parentId) ?? [];
  }
}
