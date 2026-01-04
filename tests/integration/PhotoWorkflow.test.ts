/**
 * Integration Test: Photo Workflow
 *
 * Simulates a real-world photo upload pipeline similar to the HopDrive app.
 * Tests the complete lifecycle: capture -> upload -> notify
 *
 * Key scenarios tested:
 * - Happy path with full connectivity
 * - Offline handling and resume
 * - Retry behavior on transient failures
 * - Concurrent workflow isolation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { createTestContext, runToCompletion, sleep, TestContext } from '../utils/testHelpers';

describe('Photo Workflow Integration', () => {
  let ctx: TestContext;
  let completedCallbacks: Array<{ runId: string; state: Record<string, unknown> }>;

  beforeEach(async () => {
    ctx = await createTestContext();
    completedCallbacks = [];
  });

  afterEach(() => {
    ctx.engine.stop();
  });

  // ===========================================================================
  // Activity Definitions
  // ===========================================================================

  /**
   * Step 1: Capture and process the photo locally.
   * This runs offline - no network needed.
   */
  const capturePhoto = defineActivity({
    name: 'capturePhoto',
    startToCloseTimeout: 5000,
    retry: { maximumAttempts: 3 },
    execute: async (ctxAct) => {
      const uri = ctxAct.input.uri as string;
      const hash = `hash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return { hash, processedUri: uri, capturedAt: Date.now() };
    },
  });

  /**
   * Step 2: Upload photo to cloud storage.
   * Requires network - will gate when offline.
   */
  const uploadPhoto = defineActivity({
    name: 'uploadPhoto',
    startToCloseTimeout: 60000,
    retry: { maximumAttempts: 10, initialInterval: 5000, backoffCoefficient: 2 },
    runWhen: conditions.whenConnected,
    execute: async (ctxAct) => {
      const hash = ctxAct.input.hash as string;
      if (!ctxAct.isConnected) {
        throw new Error('No network connection');
      }
      await sleep(10);
      return {
        s3Key: `uploads/${hash}.jpg`,
        uploadedAt: Date.now(),
        contentLength: 1024000,
      };
    },
  });

  /**
   * Step 3: Notify the server about the upload.
   * Requires network - will gate when offline.
   */
  const notifyServer = defineActivity({
    name: 'notifyServer',
    startToCloseTimeout: 30000,
    retry: { maximumAttempts: 5, initialInterval: 1000 },
    runWhen: conditions.whenConnected,
    execute: async (ctxAct) => {
      if (!ctxAct.isConnected) {
        throw new Error('No network connection');
      }
      await sleep(5);
      return { notifiedAt: Date.now(), photoId: `photo_${Date.now()}` };
    },
  });

  /**
   * Creates the complete photo workflow.
   */
  function createPhotoWorkflow() {
    return defineWorkflow({
      name: 'photo',
      activities: [capturePhoto, uploadPhoto, notifyServer],
      onComplete: async (runId, state) => {
        completedCallbacks.push({ runId, state });
      },
    });
  }

  // ===========================================================================
  // Test Cases
  // ===========================================================================

  describe('Happy path', () => {
    it('should complete full photo workflow when online', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      const result = await runToCompletion(ctx, execution.runId);

      expect(result.status).toBe('completed');
      expect(result.state).toMatchObject({
        moveId: 123,
        uri: 'file://photo.jpg',
        hash: expect.stringMatching(/^hash_/),
        s3Key: expect.stringContaining('uploads/'),
        notifiedAt: expect.any(Number),
        photoId: expect.stringMatching(/^photo_/),
      });
      expect(completedCallbacks).toHaveLength(1);
      expect(completedCallbacks[0].runId).toBe(execution.runId);
    });

    it('should preserve moveId throughout workflow', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 456, uri: 'file://test.jpg' },
      });

      await runToCompletion(ctx, execution.runId);

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.input.moveId).toBe(456);
      expect(result?.state.moveId).toBe(456);
    });

    it('should maintain execution history through completion', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 789, uri: 'file://history.jpg' },
      });

      await runToCompletion(ctx, execution.runId);

      const result = await ctx.engine.getExecution(execution.runId);
      // currentActivityIndex stays at last activity (2) when completed
      expect(result?.currentActivityIndex).toBe(2);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Offline handling', () => {
    it('should complete capturePhoto but gate uploadPhoto when offline', async () => {
      ctx.environment.setConnected(false);
      const photoWorkflow = createPhotoWorkflow();

      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await ctx.engine.tick(); // capturePhoto completes
      await ctx.engine.tick(); // uploadPhoto skipped (no network)

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('running');
      expect(result?.currentActivityName).toBe('uploadPhoto');
      expect(result?.state.hash).toBeDefined(); // capturePhoto completed
      expect(result?.state.s3Key).toBeUndefined(); // uploadPhoto didn't run
    });

    it('should resume uploadPhoto when connectivity returns', async () => {
      ctx.environment.setConnected(false);
      const photoWorkflow = createPhotoWorkflow();

      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await ctx.engine.tick(); // capturePhoto
      await ctx.engine.tick(); // uploadPhoto skipped

      // Connectivity restored
      ctx.environment.setConnected(true);

      // Run with clock advancing to pass gating delay
      await runToCompletion(ctx, execution.runId, { advanceClock: true });

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state.s3Key).toBeDefined();
    });

    it('should handle multiple connectivity transitions', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const execution = await ctx.engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      // Capture works (doesn't need network)
      await ctx.engine.tick();

      // Upload gated
      ctx.environment.setConnected(false);
      await ctx.engine.tick();

      let result = await ctx.engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('uploadPhoto');

      // Network back - advance clock past gating delay
      ctx.environment.setConnected(true);
      ctx.clock.advance(35000);
      await ctx.engine.tick();

      // Network drops again
      ctx.environment.setConnected(false);
      await ctx.engine.tick(); // notifyServer skipped

      result = await ctx.engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('notifyServer');
      expect(result?.state.s3Key).toBeDefined();
      expect(result?.state.notifiedAt).toBeUndefined();

      // Finally back online
      ctx.environment.setConnected(true);
      ctx.clock.advance(35000);
      await ctx.engine.tick();

      result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Retry behavior', () => {
    it('should retry upload on transient failure', async () => {
      let uploadAttempts = 0;

      const flakyUpload = defineActivity({
        name: 'uploadPhoto',
        retry: { maximumAttempts: 5, initialInterval: 10 },
        runWhen: conditions.whenConnected,
        execute: async () => {
          uploadAttempts++;
          if (uploadAttempts < 3) {
            throw new Error('Network timeout');
          }
          return { s3Key: 'uploads/success.jpg', uploadedAt: Date.now() };
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'photo',
        activities: [capturePhoto, flakyUpload, notifyServer],
      });

      const execution = await ctx.engine.start(flakyWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      // Process with retries
      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
        ctx.clock.advance(50);
      }

      expect(uploadAttempts).toBe(3);

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Concurrent workflows', () => {
    it('should process multiple photo workflows independently', async () => {
      const photoWorkflow = createPhotoWorkflow();

      const executions = await Promise.all([
        ctx.engine.start(photoWorkflow, { input: { moveId: 1, uri: 'photo1.jpg' } }),
        ctx.engine.start(photoWorkflow, { input: { moveId: 2, uri: 'photo2.jpg' } }),
        ctx.engine.start(photoWorkflow, { input: { moveId: 3, uri: 'photo3.jpg' } }),
      ]);

      // Process all
      for (let i = 0; i < 15; i++) {
        await ctx.engine.tick();
      }

      for (const exec of executions) {
        const result = await ctx.engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }

      expect(completedCallbacks).toHaveLength(3);
    });

    it('should isolate failures between workflows', async () => {
      let failedWorkflowId: string | null = null;

      const flakyActivity = defineActivity({
        name: 'capturePhoto',
        retry: { maximumAttempts: 1 },
        execute: async (ctxAct) => {
          if (ctxAct.input.shouldFail) {
            failedWorkflowId = ctxAct.runId;
            throw new Error('Intentional failure');
          }
          return { hash: 'success' };
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'photo',
        activities: [flakyActivity, uploadPhoto, notifyServer],
      });

      const executions = await Promise.all([
        ctx.engine.start(flakyWorkflow, { input: { moveId: 1, shouldFail: false } }),
        ctx.engine.start(flakyWorkflow, { input: { moveId: 2, shouldFail: true } }),
        ctx.engine.start(flakyWorkflow, { input: { moveId: 3, shouldFail: false } }),
      ]);

      // Process all
      for (let i = 0; i < 15; i++) {
        await ctx.engine.tick();
      }

      const results = await Promise.all(
        executions.map((e) => ctx.engine.getExecution(e.runId))
      );

      const completed = results.filter((r) => r?.status === 'completed');
      const failed = results.filter((r) => r?.status === 'failed');

      expect(completed).toHaveLength(2);
      expect(failed).toHaveLength(1);
      expect(failedWorkflowId).toBe(executions[1].runId);
    });
  });
});
