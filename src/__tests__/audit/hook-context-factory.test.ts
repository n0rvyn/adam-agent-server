/**
 * Unit tests for src/audit/hook-context-factory.ts
 *
 * Describes the contract that the adapter must satisfy:
 * - buildAuditWriter('A'|'B') wraps recordAuditViolation, supplying id/timestamp/layer/severity
 * - buildStepLogWriter wraps createStepLog, supplying id/index/timestamp/truncated
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store modules before importing the adapter
vi.mock('../../store/audit-violations.js', () => ({
  recordAuditViolation: vi.fn(),
}));

vi.mock('../../store/logs.js', () => ({
  createStepLog: vi.fn(),
}));

// Import after mocks are set up
import type { AuditViolation, StepLog } from '../../shared/types.js';
import { recordAuditViolation } from '../../store/audit-violations.js';
import { createStepLog } from '../../store/logs.js';
import { buildAuditWriter, buildStepLogWriter } from '../../audit/hook-context-factory.js';

describe('hook-context-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- buildAuditWriter ---

  describe('buildAuditWriter', () => {
    it('returns a function', () => {
      expect(typeof buildAuditWriter('A')).toBe('function');
      expect(typeof buildAuditWriter('B')).toBe('function');
    });

    it('calls recordAuditViolation with layer=A and severity=warning by default', () => {
      const writer = buildAuditWriter('A');
      writer({
        stepTaskId: 'task-1',
        roleId: 'role-x',
        contractField: 'lengthTarget',
        message: 'too short',
      });

      expect(recordAuditViolation).toHaveBeenCalledTimes(1);
      const recorded = (recordAuditViolation as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditViolation;
      expect(recorded.layer).toBe('A');
      expect(recorded.severity).toBe('warning');
      expect(typeof recorded.id).toBe('string');
      expect(recorded.id.length).toBeGreaterThan(0);
      expect(typeof recorded.createdAt).toBe('number');
    });

    it('calls recordAuditViolation with layer=B when layer=B passed', () => {
      const writer = buildAuditWriter('B');
      writer({
        stepTaskId: 'task-2',
        roleId: 'role-y',
        contractField: 'expectedArtifacts',
        message: 'file too large',
      });

      expect(recordAuditViolation).toHaveBeenCalledTimes(1);
      const recorded = (recordAuditViolation as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditViolation;
      expect(recorded.layer).toBe('B');
      expect(recorded.severity).toBe('warning');
    });

    it('accepts caller-supplied severity=error and passes it through', () => {
      // This tests the pre-tool-verifier internal error path (severity: 'error' as const)
      const writer = buildAuditWriter('A');
      writer({
        stepTaskId: 'task-3',
        roleId: 'role-x',
        contractField: 'format',
        message: 'internal error',
        severity: 'error',
      });

      const recorded = (recordAuditViolation as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditViolation;
      expect(recorded.severity).toBe('error');
      expect(recorded.layer).toBe('A');
    });

    it('supplies id as a non-empty string (uuid format)', () => {
      const writer = buildAuditWriter('A');
      writer({ stepTaskId: 'task-4', roleId: 'role-x', contractField: 'expectedArtifacts', message: 'ok' });

      const recorded = (recordAuditViolation as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditViolation;
      // UUID v4 has 36 chars: 8-4-4-4-12
      expect(recorded.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('supplies createdAt as a positive number (timestamp ms)', () => {
      const writer = buildAuditWriter('B');
      const before = Date.now();
      writer({ stepTaskId: 'task-5', roleId: 'role-y', contractField: 'expectedArtifacts', message: 'ok' });
      const after = Date.now();

      const recorded = (recordAuditViolation as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditViolation;
      expect(recorded.createdAt).toBeGreaterThanOrEqual(before);
      expect(recorded.createdAt).toBeLessThanOrEqual(after);
    });
  });

  // --- buildStepLogWriter ---

  describe('buildStepLogWriter', () => {
    it('returns a function', () => {
      expect(typeof buildStepLogWriter()).toBe('function');
    });

    it('calls createStepLog with a complete StepLog row', () => {
      const writer = buildStepLogWriter();
      writer({ taskId: 'task-6', type: 'validator_error', content: 'file too small' });

      expect(createStepLog).toHaveBeenCalledTimes(1);
      const recorded = (createStepLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as StepLog;
      expect(recorded.taskId).toBe('task-6');
      expect(recorded.type).toBe('validator_error');
      expect(recorded.content).toBe('file too small');
    });

    it('supplies id as a non-empty string (uuid format)', () => {
      const writer = buildStepLogWriter();
      writer({ taskId: 'task-7', type: 'validator_error', content: 'x' });

      const recorded = (createStepLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as StepLog;
      expect(recorded.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('supplies index as a number (0 is acceptable for negative-base auto-increment)', () => {
      const writer = buildStepLogWriter();
      writer({ taskId: 'task-8', type: 'validator_internal_error', content: 'parse failed' });

      const recorded = (createStepLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as StepLog;
      expect(typeof recorded.index).toBe('number');
      expect(recorded.index).toBeGreaterThanOrEqual(0);
    });

    it('supplies timestamp as a positive number (Date.now ms)', () => {
      const writer = buildStepLogWriter();
      const before = Date.now();
      writer({ taskId: 'task-9', type: 'validator_error', content: 'ok' });
      const after = Date.now();

      const recorded = (createStepLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as StepLog;
      expect(recorded.timestamp).toBeGreaterThanOrEqual(before);
      expect(recorded.timestamp).toBeLessThanOrEqual(after);
    });

    it('sets truncated to false', () => {
      const writer = buildStepLogWriter();
      writer({ taskId: 'task-10', type: 'validator_error', content: 'short' });

      const recorded = (createStepLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as StepLog;
      expect(recorded.truncated).toBe(false);
    });
  });
});
