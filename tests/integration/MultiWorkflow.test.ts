/**
 * Integration Test - Multiple Workflow Types
 * Tests running different workflow types concurrently with proper isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/engine';
import { InMemoryStorage } from '../../src/core/storage';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { runUntilComplete } from '../utils/testHelpers';

describe('Multi-Workflow Integration', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment({ isConnected: true });
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  // Photo workflow
  const photoCapture = defineActivity({
    name: 'photoCapture',
    execute: async (ctx) => ({
      photoId: `photo_${Date.now()}`,
      moveId: ctx.input.moveId,
    }),
  });

  const photoUpload = defineActivity({
    name: 'photoUpload',
    runWhen: conditions.whenConnected,
    execute: async (ctx) => ({
      s3Key: `photos/${ctx.input.photoId}.jpg`,
      uploadedAt: Date.now(),
    }),
  });

  const photoWorkflow = defineWorkflow({
    name: 'photo',
    activities: [photoCapture, photoUpload],
  });

  // Sync workflow
  const fetchRemoteData = defineActivity({
    name: 'fetchRemoteData',
    runWhen: conditions.whenConnected,
    execute: async () => ({
      remoteData: { items: ['a', 'b', 'c'] },
      fetchedAt: Date.now(),
    }),
  });

  const mergeLocalData = defineActivity({
    name: 'mergeLocalData',
    execute: async (ctx) => ({
      merged: true,
      itemCount: (ctx.input.remoteData as { items: string[] }).items.length,
    }),
  });

  const syncWorkflow = defineWorkflow({
    name: 'sync',
    activities: [fetchRemoteData, mergeLocalData],
  });

  // Cleanup workflow
  const cleanupOldFiles = defineActivity({
    name: 'cleanupOldFiles',
    execute: async () => ({
      filesDeleted: 5,
      spaceRecovered: 1024 * 1024 * 50,
    }),
  });

  const cleanupDatabase = defineActivity({
    name: 'cleanupDatabase',
    execute: async () => ({
      rowsDeleted: 100,
      tablesOptimized: 3,
    }),
  });

  const cleanupWorkflow = defineWorkflow({
    name: 'cleanup',
    activities: [cleanupOldFiles, cleanupDatabase],
  });

  describe('Different workflow types concurrently', () => {
    it('should run multiple different workflows independently', async () => {
      const engine = await createEngine();

      const photoExec = await engine.start(photoWorkflow, {
        input: { moveId: 123 },
      });
      const syncExec = await engine.start(syncWorkflow, {
        input: {},
      });
      const cleanupExec = await engine.start(cleanupWorkflow, {
        input: {},
      });

      // Process all workflows
      for (let i = 0; i < 10; i++) {
        await engine.tick();
      }

      const photoResult = await engine.getExecution(photoExec.runId);
      const syncResult = await engine.getExecution(syncExec.runId);
      const cleanupResult = await engine.getExecution(cleanupExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
      expect(cleanupResult?.status).toBe('completed');

      // Each workflow should have its own state
      expect(photoResult?.state.s3Key).toBeDefined();
      expect(syncResult?.state.merged).toBe(true);
      expect(cleanupResult?.state.filesDeleted).toBe(5);
    });

    it('should isolate state between different workflow types', async () => {
      const engine = await createEngine();

      const exec1 = await engine.start(photoWorkflow, {
        input: { moveId: 1, customField: 'photo' },
      });
      const exec2 = await engine.start(syncWorkflow, {
        input: { customField: 'sync' },
      });

      for (let i = 0; i < 10; i++) {
        await engine.tick();
      }

      const result1 = await engine.getExecution(exec1.runId);
      const result2 = await engine.getExecution(exec2.runId);

      // Photo workflow state should not affect sync workflow state
      expect(result1?.state.photoId).toBeDefined();
      expect(result2?.state.photoId).toBeUndefined();

      expect(result2?.state.remoteData).toBeDefined();
      expect(result1?.state.remoteData).toBeUndefined();
    });

    it('should allow same uniqueKey for different workflow types', async () => {
      const engine = await createEngine();

      // Same key, different workflow types - should be allowed
      const photoExec = await engine.start(photoWorkflow, {
        input: { moveId: 1 },
        uniqueKey: 'shared-key',
      });
      const syncExec = await engine.start(syncWorkflow, {
        input: {},
        uniqueKey: 'shared-key',
      });

      expect(photoExec.runId).not.toBe(syncExec.runId);

      for (let i = 0; i < 10; i++) {
        await engine.tick();
      }

      const photoResult = await engine.getExecution(photoExec.runId);
      const syncResult = await engine.getExecution(syncExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
    });
  });

  describe('Same workflow type multiple times', () => {
    it('should run multiple instances of same workflow type', async () => {
      const engine = await createEngine();

      const executions = await Promise.all([
        engine.start(photoWorkflow, { input: { moveId: 1 } }),
        engine.start(photoWorkflow, { input: { moveId: 2 } }),
        engine.start(photoWorkflow, { input: { moveId: 3 } }),
      ]);

      for (let i = 0; i < 15; i++) {
        await engine.tick();
      }

      for (const exec of executions) {
        const result = await engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }
    });

    it('should prevent duplicate uniqueKey for same workflow type', async () => {
      const engine = await createEngine();

      await engine.start(photoWorkflow, {
        input: { moveId: 1 },
        uniqueKey: 'unique-photo',
      });

      // Second start with same key should throw
      await expect(
        engine.start(photoWorkflow, {
          input: { moveId: 2 },
          uniqueKey: 'unique-photo',
        })
      ).rejects.toThrow();
    });
  });

  describe('Mixed online/offline workflows', () => {
    it('should allow offline workflow to complete while online workflow waits', async () => {
      environment.setConnected(false);
      const engine = await createEngine();

      // Cleanup doesn't need network
      const cleanupExec = await engine.start(cleanupWorkflow, {
        input: {},
      });

      // Sync needs network
      const syncExec = await engine.start(syncWorkflow, {
        input: {},
      });

      // Process both
      for (let i = 0; i < 10; i++) {
        await engine.tick();
        clock.advance(1000);
      }

      const cleanupResult = await engine.getExecution(cleanupExec.runId);
      const syncResult = await engine.getExecution(syncExec.runId);

      expect(cleanupResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('running'); // Still waiting for network
    });

    it('should resume all gated workflows when connectivity returns', async () => {
      environment.setConnected(false);
      const engine = await createEngine();

      const photoExec = await engine.start(photoWorkflow, {
        input: { moveId: 1 },
      });
      const syncExec = await engine.start(syncWorkflow, {
        input: {},
      });

      // Both have network-dependent activities
      for (let i = 0; i < 5; i++) {
        await engine.tick();
      }

      // Connect and advance clock
      environment.setConnected(true);
      clock.advance(35000);

      await runUntilComplete(engine, photoExec.runId, { clock });
      await runUntilComplete(engine, syncExec.runId, { clock });

      const photoResult = await engine.getExecution(photoExec.runId);
      const syncResult = await engine.getExecution(syncExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
    });
  });

  describe('Query and filtering', () => {
    it('should query executions by status', async () => {
      const engine = await createEngine();

      await engine.start(photoWorkflow, { input: { moveId: 1 } });
      await engine.start(syncWorkflow, { input: {} });
      await engine.start(cleanupWorkflow, { input: {} });

      const running = await engine.getExecutionsByStatus('running');
      expect(running.length).toBe(3);

      // Complete one
      await engine.tick();

      const stillRunning = await engine.getExecutionsByStatus('running');
      const completed = await engine.getExecutionsByStatus('completed');

      expect(stillRunning.length + completed.length).toBe(3);
    });

    it('should get execution by runId across workflow types', async () => {
      const engine = await createEngine();

      const photoExec = await engine.start(photoWorkflow, { input: { moveId: 1 } });
      const syncExec = await engine.start(syncWorkflow, { input: {} });

      const fetchedPhoto = await engine.getExecution(photoExec.runId);
      const fetchedSync = await engine.getExecution(syncExec.runId);

      expect(fetchedPhoto?.workflowName).toBe('photo');
      expect(fetchedSync?.workflowName).toBe('sync');
    });
  });

  describe('Callbacks per workflow type', () => {
    it('should invoke correct callbacks for each workflow type', async () => {
      const completedCallbacks: { workflow: string; runId: string }[] = [];

      const photoWithCallback = defineWorkflow({
        name: 'photo',
        activities: [photoCapture, photoUpload],
        onComplete: async (runId) => {
          completedCallbacks.push({ workflow: 'photo', runId });
        },
      });

      const syncWithCallback = defineWorkflow({
        name: 'sync',
        activities: [fetchRemoteData, mergeLocalData],
        onComplete: async (runId) => {
          completedCallbacks.push({ workflow: 'sync', runId });
        },
      });

      const engine = await createEngine();

      const photoExec = await engine.start(photoWithCallback, { input: { moveId: 1 } });
      const syncExec = await engine.start(syncWithCallback, { input: {} });

      for (let i = 0; i < 10; i++) {
        await engine.tick();
      }

      expect(completedCallbacks).toHaveLength(2);
      expect(completedCallbacks.find((c) => c.workflow === 'photo')?.runId).toBe(photoExec.runId);
      expect(completedCallbacks.find((c) => c.workflow === 'sync')?.runId).toBe(syncExec.runId);
    });
  });
});
