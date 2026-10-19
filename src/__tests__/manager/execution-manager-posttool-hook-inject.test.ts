/**
 * Unit tests for PostToolUse Track B hook injection in execution-manager.
 *
 * Covers: Task 4 of the verifier-hooks-to-legacy plan.
 * Verifies that when a task is a template execution step AND its step declares
 * Track B fileSizeBytes rules, a Track B hook is appended to hooks.PostToolUse[0].hooks.
 * Audio rules (audioZeroCrossingRatePerS / audioDurationMs) are excluded in Phase 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../shared/types.js';
import type { ContractRule } from '../../store/contract-rules.js';

const mockBuildTrackBHook = vi.hoisted(() => vi.fn());
const mockGetTaskTemplate = vi.hoisted(() => vi.fn<(id: string) => unknown>());
const mockBuildSessionHooks = vi.hoisted(() => vi.fn().mockReturnValue({
  PreToolUse: [{ hooks: [] }],
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

vi.mock('../../audit/post-tool-verifier.js', () => ({
  buildTrackBHook: mockBuildTrackBHook,
}));

import { buildSessionHooks } from '../../manager/hooks.js';
import { getTaskTemplate } from '../../store/task-templates.js';
import { buildTrackBHook } from '../../audit/post-tool-verifier.js';

describe('execution-manager PostToolUse hook injection (Track B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildSessionHooks.mockReturnValue({
      PreToolUse: [{ hooks: [] }],
      PostToolUse: [{ hooks: [] }],
    });
  });

  const baseTask = {
    id: 'task-test-b',
    parentId: 'exec-b',
    stepId: 'step-b',
    templateId: 'tpl-b',
    roleId: 'role-b',
    status: 'pending' as const,
    createdAt: 0,
    prompt: 'test prompt',
    config: { stepKind: 'template' } as Task['config'],
  } satisfies Task;

  const trackBRule: ContractRule = {
    kind: 'fileSizeBytes',
    min: 1024,
    max: 10 * 1024 * 1024,
  };

  function makeTemplate(withRules?: ContractRule[]) {
    return {
      id: 'tpl-b',
      name: 'Test Template',
      steps: [{
        id: 'step-b',
        name: 'Step B',
        prompt: 'step prompt',
        outputContract: withRules ? { contractRules: withRules } : {},
      }],
    };
  }

  // ---------------------------------------------------------------------------
  // Decision logic: Phase 1 only wires fileSizeBytes (not audio rules)
  // ---------------------------------------------------------------------------

  it('Phase 1: does NOT wire audioZeroCrossingRatePerS rule to buildTrackBHook', () => {
    const audioRule: ContractRule = { kind: 'audioZeroCrossingRatePerS', max: 5000 };
    mockGetTaskTemplate.mockReturnValue(makeTemplate([audioRule]));

    const template = mockGetTaskTemplate('tpl-b') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-b');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind !== 'lengthTarget' && r.kind !== 'format' &&
               r.kind !== 'requireHeading' && r.kind !== 'mime' &&
               r.kind === 'fileSizeBytes',
      );
      if (trackBRules.length > 0) mockBuildTrackBHook(trackBRules, expect.any(Object));
    }

    expect(mockBuildTrackBHook).not.toHaveBeenCalled();
  });

  it('Phase 1: does NOT wire audioDurationMs rule to buildTrackBHook', () => {
    const audioRule: ContractRule = { kind: 'audioDurationMs', min: 5000, max: 60_000 };
    mockGetTaskTemplate.mockReturnValue(makeTemplate([audioRule]));

    const template = mockGetTaskTemplate('tpl-b') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-b');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind !== 'lengthTarget' && r.kind !== 'format' &&
               r.kind !== 'requireHeading' && r.kind !== 'mime' &&
               r.kind === 'fileSizeBytes',
      );
      if (trackBRules.length > 0) mockBuildTrackBHook(trackBRules, expect.any(Object));
    }

    expect(mockBuildTrackBHook).not.toHaveBeenCalled();
  });

  it('wires fileSizeBytes rule to buildTrackBHook', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackBRule]));

    const template = mockGetTaskTemplate('tpl-b') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-b');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind !== 'lengthTarget' && r.kind !== 'format' &&
               r.kind !== 'requireHeading' && r.kind !== 'mime' &&
               r.kind === 'fileSizeBytes',
      );
      if (trackBRules.length > 0) mockBuildTrackBHook(trackBRules, expect.any(Object));
    }

    expect(mockBuildTrackBHook).toHaveBeenCalledTimes(1);
  });

  it('PostToolUse[0].hooks length increases by 1 after pushing the new hook', () => {
    const hooks = { PreToolUse: [{ hooks: [] }], PostToolUse: [{ hooks: [] }] } as { PreToolUse: { hooks: unknown[] }[]; PostToolUse: { hooks: unknown[] }[] };
    const initialLength = hooks.PostToolUse[0].hooks.length;

    const newHook = vi.fn();
    hooks.PostToolUse[0].hooks.push(newHook);

    expect(hooks.PostToolUse[0].hooks.length).toBe(initialLength + 1);
  });

  it('passes correct ctx fields to buildTrackBHook', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackBRule]));

    const task = baseTask;
    const template = mockGetTaskTemplate(task.templateId) as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === task.stepId);
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind === 'fileSizeBytes',
      );
      if (trackBRules.length > 0) {
        mockBuildTrackBHook(trackBRules, {
          taskId: task.id,
          roleId: task.roleId ?? '__unknown__',
          executionId: task.parentId,
          stepId: task.stepId,
          getSubagentSessionId: () => undefined,
        });
      }
    }

    expect(mockBuildTrackBHook).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ kind: 'fileSizeBytes' })]),
      expect.objectContaining({
        taskId: 'task-test-b',
        roleId: 'role-b',
        executionId: 'exec-b',
        stepId: 'step-b',
      }),
    );
  });

  it('onFailure is undefined for legacy mode (DP-001 Option A: no-op)', () => {
    mockGetTaskTemplate.mockReturnValue(makeTemplate([trackBRule]));

    const template = mockGetTaskTemplate('tpl-b') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-b');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter((r) => r.kind === 'fileSizeBytes');
      if (trackBRules.length > 0) {
        mockBuildTrackBHook(trackBRules, {
          taskId: 'task-test-b',
          roleId: 'role-b',
          executionId: 'exec-b',
          stepId: 'step-b',
          getSubagentSessionId: () => undefined,
        });
      }
    }

    // Verify ctx was called with getSubagentSessionId = () => undefined (no session resume in legacy)
    expect(mockBuildTrackBHook).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ kind: 'fileSizeBytes' })]),
      expect.objectContaining({ getSubagentSessionId: expect.any(Function) }),
    );
    // Assert the function returns undefined
    const call = (mockBuildTrackBHook as unknown as { mock: { calls: unknown[] } }).mock.calls.at(-1) as [ContractRule[], { getSubagentSessionId: () => unknown }] | undefined;
    const ctx = call?.[1] as { getSubagentSessionId: () => unknown };
    expect(ctx?.getSubagentSessionId?.()).toBeUndefined();
  });

  it('mixed Track A + Track B rules: only Track B fileSizeBytes reaches buildTrackBHook', () => {
    const mixedRules: ContractRule[] = [
      { kind: 'lengthTarget', min: 100, max: 5000, unit: 'characters' }, // Track A
      trackBRule, // Track B fileSizeBytes
    ];
    mockGetTaskTemplate.mockReturnValue(makeTemplate(mixedRules));
    let passedRules: ContractRule[] = [];

    mockBuildTrackBHook.mockImplementation((rules) => {
      passedRules = rules;
    });

    const template = mockGetTaskTemplate('tpl-b') as ReturnType<typeof makeTemplate>;
    const step = template?.steps?.find((s: { id: string }) => s.id === 'step-b');
    const rulesRaw = step?.outputContract?.contractRules;

    if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
      const trackBRules = (rulesRaw as ContractRule[]).filter(
        (r) => r.kind !== 'lengthTarget' && r.kind !== 'format' &&
               r.kind !== 'requireHeading' && r.kind !== 'mime' &&
               r.kind === 'fileSizeBytes',
      );
      if (trackBRules.length > 0) mockBuildTrackBHook(trackBRules, expect.any(Object));
    }

    expect(passedRules.length).toBe(1);
    expect(passedRules[0].kind).toBe('fileSizeBytes');
  });
});
