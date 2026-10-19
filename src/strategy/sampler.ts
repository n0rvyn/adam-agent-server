import type { Strategy } from "../shared/types.js";

/**
 * Thompson Sampling for Beta-Bernoulli bandit.
 * Each strategy has Beta(α, β) posterior; we sample and pick max.
 * Crystal ref: D-008
 * DP-002: Jeffreys prior α=0.5, β=0.5
 */
export class ThompsonSampler {
  /**
   * Sample from Beta distribution using Gamma-based method.
   * Beta(α, β) = Gamma(α, 1) / (Gamma(α, 1) + Gamma(β, 1))
   */
  private static sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }

  /**
   * Sample from Gamma distribution using Marsaglia and Tsang's method.
   */
  private static sampleGamma(alpha: number, beta: number): number {
    if (alpha < 1) {
      return this.sampleGamma(alpha + 1, beta) * Math.pow(Math.random(), 1 / alpha);
    }

    const d = alpha - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x: number, v: number;
      do {
        x = this.randn();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * x * x * x * x) {
        return d * v / beta;
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v / beta;
      }
    }
  }

  /**
   * Standard normal random using Box-Muller.
   */
  private static randn(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Select strategy using Thompson Sampling.
   * For each strategy, sample from Beta(α, β), return strategy with highest sample.
   */
  static sample(strategies: Strategy[]): Strategy | null {
    if (strategies.length === 0) {
      return null;
    }

    let bestStrategy: Strategy | null = null;
    let bestSample = -1;

    for (const strategy of strategies) {
      const s = this.sampleBeta(strategy.alpha, strategy.beta);
      if (s > bestSample) {
        bestSample = s;
        bestStrategy = strategy;
      }
    }

    return bestStrategy;
  }

  /**
   * Get sampling probability for each strategy (for visualization/debugging).
   * Runs many samples and returns empirical probability distribution.
   */
  static getProbabilities(strategies: Strategy[], numSamples = 10000): Map<string, number> {
    const counts = new Map<string, number>();

    for (let i = 0; i < numSamples; i++) {
      const selected = this.sample(strategies);
      if (selected) {
        counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
      }
    }

    const probs = new Map<string, number>();
    for (const [id, count] of counts) {
      probs.set(id, count / numSamples);
    }

    return probs;
  }
}
