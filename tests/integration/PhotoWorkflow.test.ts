/**
 * Integration Test - Photo Workflow
 * Simulates the HopDrive photo pipeline: capture -> upload -> notify
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/engine';
import { InMemoryStorage } from '../../src/core/storage';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { runUntilComplete, sleep } from '../utils/testHelpers';

describe('Photo Workflow Integration', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let completedCallbacks: Array<{ runId: string; state: Record<string, unknown> }>;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment({ isConnected: true });
    completedCallbacks = [];
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  // Define photo workflow activities
  const capturePhoto = defineActivity({
    name: 'capturePhoto',
    startToCloseTimeout: 5000,
    retry: { maximumAttempts: 3 },
    execute: async (ctx) => {
      const uri = ctx.input.uri as string;
      const hash = `hash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return { hash, processedUri: uri, capturedAt: clock.now() };
    },
  });

  const uploadPhoto = defineActivity({
    name: 'uploadPhoto',
    startToCloseTimeout: 60000,
    retry: { maximumAttempts: 10, initialInterval: 5000, backoffCoefficient: 2 },
    runWhen: conditions.whenConnected,
    execute: async (ctx) => {
      const hash = ctx.input.hash as string;
      if (!ctx.isConnected) {
        throw new Error('No network connection');
      }
      await sleep(10);
      return {
        s3Key: `uploads/${hash}.jpg`,
        uploadedAt: clock.now(),
        contentLength: 1024000,
      };
    },
  });

  const notifyServer = defineActivity({
    name: 'notifyServer',
    startToCloseTimeout: 30000,
    retry: { maximumAttempts: 5, initialInterval: 1000 },
    runWhen: conditions.whenConnected,
    execute: async (ctx) => {
      if (!ctx.isConnected) {
        throw new Error('No network connection');
      }
      await sleep(5);
      return { notifiedAt: clock.now(), photoId: `photo_${Date.now()}` };
    },
  });

  function createPhotoWorkflow() {
    return defineWorkflow({
      name: 'photo',
      activities: [capturePhoto, uploadPhoto, notifyServer],
      onComplete: async (runId, state) => {
        completedCallbacks.push({ runId, state });
      },
    });
  }

  describe('Happy path', () => {
    it('should complete full photo workflow when online', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      const result = await runUntilComplete(engine, execution.runId);

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
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 456, uri: 'file://test.jpg' },
      });

      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.input.moveId).toBe(456);
      expect(result?.state.moveId).toBe(456);
    });

    it('should maintain execution history through completion', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 789, uri: 'file://history.jpg' },
      });

      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      // currentActivityIndex is 2 (0-indexed last activity) when workflow completes
      expect(result?.currentActivityIndex).toBe(2);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Offline handling', () => {
    it('should complete capturePhoto but gate uploadPhoto when offline', async () => {
      environment.setConnected(false);

      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await engine.tick(); // capturePhoto completes
      await engine.tick(); // uploadPhoto skipped (no network)

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('running');
      expect(result?.currentActivityName).toBe('uploadPhoto');
      expect(result?.state.hash).toBeDefined(); // capturePhoto completed
      expect(result?.state.s3Key).toBeUndefined(); // uploadPhoto didn't run
    });

    it('should resume uploadPhoto when connectivity returns', async () => {
      environment.setConnected(false);

      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await engine.tick(); // capturePhoto
      await engine.tick(); // uploadPhoto skipped

      // Connectivity restored
      environment.setConnected(true);

      // Pass clock to advance past gating delay
      await runUntilComplete(engine, execution.runId, { clock });

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state.s3Key).toBeDefined();
    });

    it('should handle multiple connectivity transitions', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      // Capture works (doesn't need network)
      await engine.tick();

      // Upload gated
      environment.setConnected(false);
      await engine.tick();

      let result = await engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('uploadPhoto');

      // Network back - advance clock past gating delay, then upload completes
      environment.setConnected(true);
      clock.advance(35000);
      await engine.tick();

      // Network drops again
      environment.setConnected(false);
      await engine.tick(); // notifyServer skipped

      result = await engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('notifyServer');
      expect(result?.state.s3Key).toBeDefined();
      expect(result?.state.notifiedAt).toBeUndefined();

      // Finally back online - advance clock
      environment.setConnected(true);
      clock.advance(35000);
      await engine.tick();

      result = await engine.getExecution(execution.runId);
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
          return { s3Key: 'uploads/success.jpg', uploadedAt: clock.now() };
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'photo',
        activities: [capturePhoto, flakyUpload, notifyServer],
      });

      const engine = await createEngine();

      const execution = await engine.start(flakyWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      // Process with retries
      for (let i = 0; i < 10; i++) {
        await engine.tick();
        clock.advance(50);
      }

      expect(uploadAttempts).toBe(3);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Concurrent workflows', () => {
    it('should process multiple photo workflows independently', async () => {
      const photoWorkflow = createPhotoWorkflow();
      const engine = await createEngine();

      const executions = await Promise.all([
        engine.start(photoWorkflow, { input: { moveId: 1, uri: 'photo1.jpg' } }),
        engine.start(photoWorkflow, { input: { moveId: 2, uri: 'photo2.jpg' } }),
        engine.start(photoWorkflow, { input: { moveId: 3, uri: 'photo3.jpg' } }),
      ]);

      // Process all
      for (let i = 0; i < 15; i++) {
        await engine.tick();
      }

      for (const exec of executions) {
        const result = await engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }

      expect(completedCallbacks).toHaveLength(3);
    });

    it('should isolate failures between workflows', async () => {
      let failedWorkflowId: string | null = null;

      const flakyActivity = defineActivity({
        name: 'capturePhoto',
        retry: { maximumAttempts: 1 },
        execute: async (ctx) => {
          if (ctx.input.shouldFail) {
            failedWorkflowId = ctx.runId;
            throw new Error('Intentional failure');
          }
          return { hash: 'success' };
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'photo',
        activities: [flakyActivity, uploadPhoto, notifyServer],
      });

      const engine = await createEngine();

      const executions = await Promise.all([
        engine.start(flakyWorkflow, { input: { moveId: 1, shouldFail: false } }),
        engine.start(flakyWorkflow, { input: { moveId: 2, shouldFail: true } }),
        engine.start(flakyWorkflow, { input: { moveId: 3, shouldFail: false } }),
      ]);

      // Process all
      for (let i = 0; i < 15; i++) {
        await engine.tick();
      }

      const results = await Promise.all(
        executions.map((e) => engine.getExecution(e.runId))
      );

      const completed = results.filter((r) => r?.status === 'completed');
      const failed = results.filter((r) => r?.status === 'failed');

      expect(completed).toHaveLength(2);
      expect(failed).toHaveLength(1);
      expect(failedWorkflowId).toBe(executions[1].runId);
    });
  });
});
