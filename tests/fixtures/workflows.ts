/**
 * Test fixtures - reusable workflow definitions for testing.
 */

import { defineWorkflow, defineActivity } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { createTestActivity } from '../utils/testHelpers';

/**
 * Single activity workflow for basic tests.
 */
export const singleActivityWorkflow = defineWorkflow({
  name: 'single',
  activities: [
    defineActivity({
      name: 'only',
      execute: async () => ({ result: 'done' }),
    }),
  ],
});

/**
 * Three-stage workflow for sequential testing.
 */
export const threeStageWorkflow = defineWorkflow({
  name: 'threeStage',
  activities: [
    createTestActivity('stage1'),
    createTestActivity('stage2'),
    createTestActivity('stage3'),
  ],
});

/**
 * Workflow with network-dependent activity.
 */
export const networkDependentWorkflow = defineWorkflow({
  name: 'networkDependent',
  activities: [
    createTestActivity('offline'),
    defineActivity({
      name: 'online',
      runWhen: conditions.whenConnected,
      execute: async (ctx) => {
        if (!ctx.isConnected) throw new Error('No network');
        return { synced: true };
      },
    }),
    createTestActivity('final'),
  ],
});

/**
 * Create a workflow that fails on specific attempts.
 */
export function createRetryWorkflow(succeedOnAttempt: number) {
  return defineWorkflow({
    name: `retry-${succeedOnAttempt}`,
    activities: [
      createTestActivity('flaky', {
        failUntilAttempt: succeedOnAttempt,
        retry: { maximumAttempts: succeedOnAttempt + 2, initialInterval: 10 },
      }),
    ],
  });
}

/**
 * Workflow with all callback hooks for callback testing.
 */
export function createCallbackTestWorkflow(callbacks: {
  onComplete?: (runId: string, finalState: Record<string, unknown>) => Promise<void>;
  onFailed?: (runId: string, error: Error, state: Record<string, unknown>) => Promise<void>;
  onCancelled?: (runId: string, state: Record<string, unknown>) => Promise<void>;
}) {
  return defineWorkflow({
    name: 'callbackTest',
    activities: [createTestActivity('testActivity')],
    ...callbacks,
  });
}

/**
 * Create a slow activity workflow for cancellation testing.
 */
export function createSlowWorkflow(delayMs: number = 10000) {
  return defineWorkflow({
    name: 'slow',
    activities: [
      defineActivity({
        name: 'slowActivity',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, delayMs);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { completed: true };
        },
      }),
    ],
  });
}

/**
 * Create a workflow with multiple activities that tracks execution order.
 */
export function createOrderTrackingWorkflow(
  activityNames: string[],
  executionLog: string[]
) {
  return defineWorkflow({
    name: 'orderTracking',
    activities: activityNames.map((name) =>
      defineActivity({
        name,
        execute: async () => {
          executionLog.push(name);
          return { [name]: 'done' };
        },
      })
    ),
  });
}

/**
 * Photo upload workflow for integration testing.
 */
export function createPhotoUploadWorkflow(options?: {
  onProgress?: (step: string) => void;
}) {
  return defineWorkflow({
    name: 'photoUpload',
    activities: [
      defineActivity({
        name: 'compress',
        execute: async (ctx) => {
          options?.onProgress?.('compress');
          return {
            ...ctx.input,
            compressed: true,
            compressedSize: Math.floor((ctx.input.originalSize as number) * 0.7),
          };
        },
      }),
      defineActivity({
        name: 'upload',
        runWhen: conditions.whenConnected,
        execute: async (ctx) => {
          options?.onProgress?.('upload');
          return {
            ...ctx.input,
            uploaded: true,
            uploadedAt: Date.now(),
          };
        },
      }),
      defineActivity({
        name: 'cleanup',
        execute: async (ctx) => {
          options?.onProgress?.('cleanup');
          return {
            ...ctx.input,
            cleanedUp: true,
          };
        },
      }),
    ],
  });
}
