import { describe, it, expect } from "vitest";
import { MetricTree } from "../../../strategy/evaluator/metric-tree.js";
import type { MetricNode } from "../../../shared/types.js";

function makeNodes(): MetricNode[] {
  const now = Date.now();
  return [
    { id: "l0-1", goalId: "g1", level: "L0", name: "progress", weight: 1.0, calibrationFactor: 1.0, createdAt: now },
    { id: "l1-1", goalId: "g1", level: "L1", parentId: "l0-1", name: "weekly", weight: 0.8, calibrationFactor: 1.0, createdAt: now },
    { id: "l2-1", goalId: "g1", level: "L2", parentId: "l1-1", name: "daily", weight: 0.6, calibrationFactor: 1.0, createdAt: now },
    { id: "l3-1", goalId: "g1", level: "L3", parentId: "l2-1", name: "instant", weight: 0.4, calibrationFactor: 1.0, createdAt: now },
  ];
}

describe("MetricTree", () => {
  describe("fromNodes()", () => {
    it("builds tree with correct node count", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      expect(tree.getNodeCount()).toBe(4);
    });

    it("establishes parent-child relationships", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const l1Children = tree.getChildren("l0-1");
      expect(l1Children).toHaveLength(1);
      expect(l1Children[0].id).toBe("l1-1");
    });
  });

  describe("queryPath()", () => {
    it("returns nodes at specified level", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const l0 = tree.queryPath("L0");
      expect(l0).toHaveLength(1);
      expect(l0[0].level).toBe("L0");
    });

    it("returns empty array for level with no nodes", () => {
      const tree = MetricTree.fromNodes("g1", [makeNodes()[0]]);
      expect(tree.queryPath("L3")).toHaveLength(0);
    });

    it("orders by weight descending", () => {
      const nodes = makeNodes();
      nodes.push({ id: "l3-2", goalId: "g1", level: "L3", parentId: "l2-1", name: "instant2", weight: 0.8, calibrationFactor: 1.0, createdAt: Date.now() });
      const tree = MetricTree.fromNodes("g1", nodes);
      const l3 = tree.queryPath("L3");
      expect(l3[0].weight).toBeGreaterThanOrEqual(l3[1].weight);
    });
  });

  describe("aggregateScores()", () => {
    it("computes weighted score for a level", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const scores = new Map([["l3-1", 0.8]]);
      const result = tree.aggregateScores("L3", scores);
      // 0.8 * 0.4 * 1.0 / 0.4 = 0.8
      expect(result).toBeCloseTo(0.8, 5);
    });

    it("returns 0 for level with no nodes", () => {
      const tree = MetricTree.fromNodes("g1", [makeNodes()[0]]);
      expect(tree.aggregateScores("L3", new Map())).toBe(0);
    });

    it("handles missing scores as 0", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const scores = new Map<string, number>(); // empty
      const result = tree.aggregateScores("L0", scores);
      expect(result).toBe(0);
    });

    it("respects calibration factor", () => {
      const nodes = makeNodes();
      nodes[3].calibrationFactor = 0.5; // L3 node
      const tree = MetricTree.fromNodes("g1", nodes);
      const scores = new Map([["l3-1", 1.0]]);
      const result = tree.aggregateScores("L3", scores);
      // 1.0 * 0.4 * 0.5 / (0.4 * 0.5) = 1.0 (normalized)
      expect(result).toBeCloseTo(1.0, 5);
    });
  });

  describe("getWeightedScore()", () => {
    it("combines all levels into 0-1 score", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const scores = new Map([
        ["l0-1", 0.5],
        ["l1-1", 0.6],
        ["l2-1", 0.7],
        ["l3-1", 0.8],
      ]);
      const result = tree.getWeightedScore(scores);
      // 0.20*0.5 + 0.15*0.6 + 0.35*0.7 + 0.30*0.8 = 0.1+0.09+0.245+0.24 = 0.675
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
      expect(result).toBeCloseTo(0.675, 2);
    });

    it("returns 0 when no scores provided", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      expect(tree.getWeightedScore(new Map())).toBe(0);
    });

    it("clamps to 0-1 range", () => {
      const tree = MetricTree.fromNodes("g1", makeNodes());
      const scores = new Map([
        ["l0-1", 1.5], // over 1
        ["l1-1", 1.0],
        ["l2-1", 1.0],
        ["l3-1", 1.0],
      ]);
      const result = tree.getWeightedScore(scores);
      expect(result).toBeLessThanOrEqual(1);
    });
  });
});
