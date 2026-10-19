import { describe, it, expect } from "vitest";
import { resolveContractRules } from "../../lib/resolve-contract-rules.js";
import type { TaskStep } from "../../shared/types.js";

// Pure function — no DB. Pure design: `contractRules` is the ONE vocabulary. There is no legacy
// derivation; the old lengthTarget/format/expectedArtifacts fields were removed. resolveContractRules
// is a thin passthrough of step.outputContract?.contractRules ?? [].

function step(outputContract: TaskStep["outputContract"]): Pick<TaskStep, "outputContract"> {
  return { outputContract };
}

describe("resolveContractRules", () => {
  it("(a) passes a lengthTarget rule through unchanged", () => {
    const rules = resolveContractRules(
      step({ contractRules: [{ kind: "lengthTarget", min: 600, max: 800, unit: "characters" }] }),
    );
    expect(rules).toEqual([{ kind: "lengthTarget", min: 600, max: 800, unit: "characters" }]);
  });

  it("(b) passes a format rule through unchanged", () => {
    const rules = resolveContractRules(step({ contractRules: [{ kind: "format", value: "markdown" }] }));
    expect(rules).toEqual([{ kind: "format", value: "markdown" }]);
  });

  it("(c) passes a multi-rule array (length + format) through in declaration order", () => {
    const cr = [
      { kind: "lengthTarget", min: 600, max: 800, unit: "characters" },
      { kind: "format", value: "markdown" },
    ] as const;
    const rules = resolveContractRules(step({ contractRules: [...cr] }));
    expect(rules).toEqual(cr);
  });

  it("(d) passes a Track B file rule through unchanged", () => {
    const cr = [{ kind: "mime", declared: "audio/mpeg" }] as const;
    const rules = resolveContractRules(step({ contractRules: [...cr] }));
    expect(rules).toEqual(cr);
  });

  it("(e) undefined / empty outputContract yields []", () => {
    expect(resolveContractRules(step(undefined))).toEqual([]);
    expect(resolveContractRules(step({}))).toEqual([]);
  });

  it("(f) outputContract with no contractRules yields []", () => {
    expect(resolveContractRules(step({ mustReferenceArtifacts: true }))).toEqual([]);
  });
});
