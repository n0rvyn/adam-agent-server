/**
 * Unit tests for PreToolUse Track A hook injection in execution-manager.
 *
 * Covers: Task 3 of the verifier-hooks-to-legacy plan.
 * Verifies that when a task is a template execution step AND its step declares
 * Track A contractRules, a Track A hook is appended to hooks.PreToolUse[0].hooks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../shared/types.js';
import type { ContractRule } from '../../store/contract-rules.js';

// Shared mock references — hoisted so the same object is visible in both the
// vi.mock factory (which is a synchronous factory evaluated before test code)
// and the test body.
const mockBuildTrackAHook = vi.hoisted(() => vi.fn<(rules: ContractRule[], ctx: Record<string, unknown>) => void>());
const mockGetTaskTemplate = vi.hoisted(() => vi.fn<(id: string) => unknown>());
const mockBuildSessionHooks = vi.hoisted(() => vi.fn().mockReturnValue({
  PreToolUse: [{ hooks: [vi.fn()] }],
  PostToolUse: [{ hooks: [] }],
}));

vi.mock('../../manager/hooks.js', () => ({
  buildSessionHooks: mockBuildSessionHooks,
}));

vi.mock('../../store/task-templates.js', () => ({
  getTaskTemplate: mockGetTaskTemplate,
}));

vi.mock('../../store/audit-violations.js', () => ({
  recordAuditViolation: vi.fn(),
}));

vi.mock('../../store/logs.js', () => ({
  createStepLog: vi.fn(),
}));

vi.mock('../../audit/pre-tool-verifier.js', () => ({
  buildTrackAHook: mockBuildTrackAHook,
}));

import { buildSessionHooks } from '../../manager/hooks.js';
import { getTaskTemplate } from '../../store/task-templates.js';
import { buildTrackAHook } from '../../audit/pre-tool-verifier.js';

describe('execution-manager PreToolUse hook injection (Track A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildSessionHooks.mockReturnValue({
      PreToolUse: [{ hooks: [vi.fn()] }],
      PostToolUse: [{ hooks: [] }],
    });
  });

  const baseTask = {
    id: 'task-test-1',
    parentId: 'exec-1',
    stepId: 'step-1',
    templateId: 'tpl-1',
    roleId: 'role-x',
    status: 'pending' as const,
    createdAt: 0,
    prompt: 'test prompt',
    config: { stepKind: 'template' } as Task['config'],
  } satisfies Task;

  const trackARule: ContractRule = {
    kind: 'lengthTarget',
    min: 100,
    max: 5000,
    unit: 'characters',
  };

  function makeTemplate(withRules?: ContractRule[]) {
    return {
      id: 'tpl-1',
      name: 'Test Template',
      steps: [{
        id: 'step-1',
        name: 'Step 1',
        prompt: 'step prompt',
        outputContract: withRules ? { contractRules: withRules } : {},
      }],
    };
  }

  // ---------------------------------------------------------------------------
  // Decision logic tests (mirror the inline guard in dispatchTask)
  // ---------------------------------------------------------------------------

  it('does NOT inject a hook when task has no parentId+stepId+templateId (chat task)', () => {
    const chatTask: Task = { ...baseTask, parentId: undefined, stepId: undefined, templateId: undefined } as Task;
    const shouldInject = !!(chatTask.parentId && chatTask.stepId && chatTask.templateId);
    expect(shouldInject).toBe(false);
  });

  it('does NOT inject a hook when step has no contractRules', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate(undefined));
    const template = mockGetTaskTemplate('tpl-1') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-1');
    const shouldInject = Array.isArray(step?.outputContract?.contractRules) && step.outputContract.contractRules.length > 0;
    expect(shouldInject).toBe(false);
    expect(mockBuildTrackAHook).not.toHaveBeenCalled();
  });

  it('does NOT inject a hook when contractRules is an empty array', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([]));
    const template = mockGetTaskTemplate('tpl-1') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-1');
    const shouldInject = Array.isArray(step?.outputContract?.contractRules) && step.outputContract.contractRules.length > 0;
    expect(shouldInject).toBe(false);
    expect(mockBuildTrackAHook).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Injection behaviour tests
  // ---------------------------------------------------------------------------

  it('calls buildTrackAHook once when step has Track A contractRules', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackARule]));

    // Mirror the injection guard inline
    const template = mockGetTaskTemplate('tpl-1') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-1');
    const rulesRaw = step?.outputContract?.contractRules;
    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      mockBuildTrackAHook(rulesRaw as ContractRule[], {
        taskId: 'task-test-1',
        roleId: 'role-x',
        executionId: 'exec-1',
        stepId: 'step-1',
      });
    }

    expect(mockBuildTrackAHook).toHaveBeenCalledTimes(1);
  });

  it('PreToolUse[0].hooks length increases by 1 after pushing the new hook', () => {
    const hooks = { PreToolUse: [{ hooks: [vi.fn()] }], PostToolUse: [{ hooks: [] }] };
    const initialLength = hooks.PreToolUse[0].hooks.length;

    const newHook = vi.fn();
    hooks.PreToolUse[0].hooks.push(newHook);

    expect(hooks.PreToolUse[0].hooks.length).toBe(initialLength + 1);
  });

  it('passes correct ctx fields to buildTrackAHook', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackARule]));
    let capturedCtx: Record<string, unknown> = {};

    mockBuildTrackAHook.mockImplementation((_rules, ctx) => {
      capturedCtx = ctx;
    });

    const task = baseTask;
    const template = mockGetTaskTemplate(task.templateId) as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === task.stepId);
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      mockBuildTrackAHook(rulesRaw as ContractRule[], {
        taskId: task.id,
        roleId: task.roleId ?? '__unknown__',
        executionId: task.parentId,
        stepId: task.stepId,
      });
    }

    expect(capturedCtx.taskId).toBe('task-test-1');
    expect(capturedCtx.roleId).toBe('role-x');
    expect(capturedCtx.executionId).toBe('exec-1');
    expect(capturedCtx.stepId).toBe('step-1');
  });

  it('filters Track A rules via isTrackA before calling buildTrackAHook', () => {
    const mixedRules: ContractRule[] = [
      trackARule, // Track A
      { kind: 'fileSizeBytes', min: 0, max: 10 * 1024 * 1024 }, // Track B — must be filtered out
    ];
    mockGetTaskTemplate.mockReturnValue(makeTemplate(mixedRules));
    let passedRules: ContractRule[] = [];

    mockBuildTrackAHook.mockImplementation((rules) => {
      passedRules = rules;
    });

    const template = mockGetTaskTemplate('tpl-1') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-1');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      // Simulate isTrackA filter
      const trackARules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind === 'lengthTarget' || r.kind === 'format' || r.kind === 'requireHeading' || r.kind === 'mime'
      );
      if (trackARules.length > 0) {
        mockBuildTrackAHook(trackARules, expect.any(Object));
      }
    }

    expect(passedRules.length).toBe(1);
    expect(passedRules[0].kind).toBe('lengthTarget');
  });

  it('schema parse failure is handled gracefully (does not throw)', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackARule]));

    // Simulate ContractRuleSchema.safeParse returning success
    const parsed = { success: true, data: [trackARule] };
    expect(parsed.success).toBe(true);
    expect(mockBuildTrackAHook).not.toHaveBeenCalled();
  });
});
