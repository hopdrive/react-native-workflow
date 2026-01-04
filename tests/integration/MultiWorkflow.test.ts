/**
 * Integration Test: Multiple Workflow Types
 *
 * Tests running different workflow types concurrently with proper isolation.
 * Validates that the engine can handle heterogeneous workloads without
 * cross-contamination between workflow instances.
 *
 * Key scenarios tested:
 * - Different workflow types running concurrently
 * - State isolation between workflows
 * - UniqueKey handling across workflow types
 * - Mixed online/offline workflow handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { createTestContext, runToCompletion, TestContext } from '../utils/testHelpers';

describe('Multi-Workflow Integration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    ctx.engine.stop();
  });

  // ===========================================================================
  // Workflow Definitions
  // ===========================================================================

  // Photo workflow - captures and uploads photos
  const photoCapture = defineActivity({
    name: 'photoCapture',
    execute: async (actCtx) => ({
      photoId: `photo_${Date.now()}`,
      moveId: actCtx.input.moveId,
    }),
  });

  const photoUpload = defineActivity({
    name: 'photoUpload',
    runWhen: conditions.whenConnected,
    execute: async (actCtx) => ({
      s3Key: `photos/${actCtx.input.photoId}.jpg`,
      uploadedAt: Date.now(),
    }),
  });

  const photoWorkflow = defineWorkflow({
    name: 'photo',
    activities: [photoCapture, photoUpload],
  });

  // Sync workflow - fetches and merges remote data
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
    execute: async (actCtx) => ({
      merged: true,
      itemCount: (actCtx.input.remoteData as { items: string[] }).items.length,
    }),
  });

  const syncWorkflow = defineWorkflow({
    name: 'sync',
    activities: [fetchRemoteData, mergeLocalData],
  });

  // Cleanup workflow - performs local maintenance
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

  // ===========================================================================
  // Test Cases
  // ===========================================================================

  describe('Different workflow types concurrently', () => {
    it('should run multiple different workflows independently', async () => {
      const photoExec = await ctx.engine.start(photoWorkflow, { input: { moveId: 123 } });
      const syncExec = await ctx.engine.start(syncWorkflow, { input: {} });
      const cleanupExec = await ctx.engine.start(cleanupWorkflow, { input: {} });

      // Process all workflows
      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
      }

      const photoResult = await ctx.engine.getExecution(photoExec.runId);
      const syncResult = await ctx.engine.getExecution(syncExec.runId);
      const cleanupResult = await ctx.engine.getExecution(cleanupExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
      expect(cleanupResult?.status).toBe('completed');

      // Each workflow should have its own state
      expect(photoResult?.state.s3Key).toBeDefined();
      expect(syncResult?.state.merged).toBe(true);
      expect(cleanupResult?.state.filesDeleted).toBe(5);
    });

    it('should isolate state between different workflow types', async () => {
      const exec1 = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 1, customField: 'photo' },
      });
      const exec2 = await ctx.engine.start(syncWorkflow, {
        input: { customField: 'sync' },
      });

      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
      }

      const result1 = await ctx.engine.getExecution(exec1.runId);
      const result2 = await ctx.engine.getExecution(exec2.runId);

      // Photo workflow state should not affect sync workflow state
      expect(result1?.state.photoId).toBeDefined();
      expect(result2?.state.photoId).toBeUndefined();

      expect(result2?.state.remoteData).toBeDefined();
      expect(result1?.state.remoteData).toBeUndefined();
    });

    it('should allow same uniqueKey for different workflow types', async () => {
      // Same key, different workflow types - should be allowed
      const photoExec = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 1 },
        uniqueKey: 'shared-key',
      });
      const syncExec = await ctx.engine.start(syncWorkflow, {
        input: {},
        uniqueKey: 'shared-key',
      });

      expect(photoExec.runId).not.toBe(syncExec.runId);

      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
      }

      const photoResult = await ctx.engine.getExecution(photoExec.runId);
      const syncResult = await ctx.engine.getExecution(syncExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
    });
  });

  describe('Same workflow type multiple times', () => {
    it('should run multiple instances of same workflow type', async () => {
      const executions = await Promise.all([
        ctx.engine.start(photoWorkflow, { input: { moveId: 1 } }),
        ctx.engine.start(photoWorkflow, { input: { moveId: 2 } }),
        ctx.engine.start(photoWorkflow, { input: { moveId: 3 } }),
      ]);

      for (let i = 0; i < 15; i++) {
        await ctx.engine.tick();
      }

      for (const exec of executions) {
        const result = await ctx.engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }
    });

    it('should prevent duplicate uniqueKey for same workflow type', async () => {
      await ctx.engine.start(photoWorkflow, {
        input: { moveId: 1 },
        uniqueKey: 'unique-photo',
      });

      // Second start with same key should throw
      await expect(
        ctx.engine.start(photoWorkflow, {
          input: { moveId: 2 },
          uniqueKey: 'unique-photo',
        })
      ).rejects.toThrow();
    });
  });

  describe('Mixed online/offline workflows', () => {
    it('should allow offline workflow to complete while online workflow waits', async () => {
      ctx.environment.setConnected(false);

      // Cleanup doesn't need network
      const cleanupExec = await ctx.engine.start(cleanupWorkflow, { input: {} });
      // Sync needs network
      const syncExec = await ctx.engine.start(syncWorkflow, { input: {} });

      // Process both
      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
        ctx.clock.advance(1000);
      }

      const cleanupResult = await ctx.engine.getExecution(cleanupExec.runId);
      const syncResult = await ctx.engine.getExecution(syncExec.runId);

      expect(cleanupResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('running'); // Still waiting for network
    });

    it('should resume all gated workflows when connectivity returns', async () => {
      ctx.environment.setConnected(false);

      const photoExec = await ctx.engine.start(photoWorkflow, { input: { moveId: 1 } });
      const syncExec = await ctx.engine.start(syncWorkflow, { input: {} });

      // Both have network-dependent activities
      for (let i = 0; i < 5; i++) {
        await ctx.engine.tick();
      }

      // Connect and run to completion
      ctx.environment.setConnected(true);

      await runToCompletion(ctx, photoExec.runId, { advanceClock: true });
      await runToCompletion(ctx, syncExec.runId, { advanceClock: true });

      const photoResult = await ctx.engine.getExecution(photoExec.runId);
      const syncResult = await ctx.engine.getExecution(syncExec.runId);

      expect(photoResult?.status).toBe('completed');
      expect(syncResult?.status).toBe('completed');
    });
  });

  describe('Query and filtering', () => {
    it('should query executions by status', async () => {
      await ctx.engine.start(photoWorkflow, { input: { moveId: 1 } });
      await ctx.engine.start(syncWorkflow, { input: {} });
      await ctx.engine.start(cleanupWorkflow, { input: {} });

      const running = await ctx.engine.getExecutionsByStatus('running');
      expect(running.length).toBe(3);

      // Complete one
      await ctx.engine.tick();

      const stillRunning = await ctx.engine.getExecutionsByStatus('running');
      const completed = await ctx.engine.getExecutionsByStatus('completed');

      expect(stillRunning.length + completed.length).toBe(3);
    });

    it('should get execution by runId across workflow types', async () => {
      const photoExec = await ctx.engine.start(photoWorkflow, { input: { moveId: 1 } });
      const syncExec = await ctx.engine.start(syncWorkflow, { input: {} });

      const fetchedPhoto = await ctx.engine.getExecution(photoExec.runId);
      const fetchedSync = await ctx.engine.getExecution(syncExec.runId);

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

      const photoExec = await ctx.engine.start(photoWithCallback, { input: { moveId: 1 } });
      const syncExec = await ctx.engine.start(syncWithCallback, { input: {} });

      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
      }

      expect(completedCallbacks).toHaveLength(2);
      expect(completedCallbacks.find((c) => c.workflow === 'photo')?.runId).toBe(photoExec.runId);
      expect(completedCallbacks.find((c) => c.workflow === 'sync')?.runId).toBe(syncExec.runId);
    });
  });
});
