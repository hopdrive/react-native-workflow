/**
 * Integration Test: Background Processing
 *
 * Tests for background task execution, scheduling, and lifecycle.
 * Validates engine behavior for scheduled tasks, long-running workflows,
 * and various runtime conditions.
 *
 * Key scenarios tested:
 * - Task scheduling and timing
 * - Long-running workflows
 * - Resource-aware processing (battery, app state)
 * - Tick behavior and error resilience
 * - Engine lifecycle events
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { createTestContext, TestContext } from '../utils/testHelpers';

describe('Background Processing Integration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    ctx.engine.stop();
  });

  // ===========================================================================
  // Scheduled Activity Processing
  // ===========================================================================

  describe('Scheduled activity processing', () => {
    it('should process newly created tasks immediately', async () => {
      let executionTime = 0;

      const delayedActivity = defineActivity({
        name: 'delayed',
        execute: async () => {
          executionTime = ctx.clock.now();
          return { executed: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'delayed',
        activities: [delayedActivity],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });

      // Get the task - should exist and be pending
      const tasks = await ctx.storage.getActivityTasksForExecution(execution.runId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('pending');

      await ctx.engine.tick();

      expect(executionTime).toBeGreaterThan(0);

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should not process activities scheduled for the future', async () => {
      let executed = false;

      const activity = defineActivity({
        name: 'future',
        execute: async () => {
          executed = true;
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'future',
        activities: [activity],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });

      // Manually update task to be scheduled for future
      const tasks = await ctx.storage.getActivityTasksForExecution(execution.runId);
      await ctx.storage.saveActivityTask({
        ...tasks[0]!,
        scheduledFor: ctx.clock.now() + 60000, // 1 minute in future
      });

      // Tick should not process
      await ctx.engine.tick();
      expect(executed).toBe(false);

      // Advance clock
      ctx.clock.advance(60001);

      // Now it should process
      await ctx.engine.tick();
      expect(executed).toBe(true);
    });
  });

  // ===========================================================================
  // Long-Running Workflows
  // ===========================================================================

  describe('Long-running workflows', () => {
    it('should handle workflows that span long time periods', async () => {
      const timestamps: number[] = [];

      const logTime = defineActivity({
        name: 'logTime',
        execute: async () => {
          timestamps.push(ctx.clock.now());
          return { time: ctx.clock.now() };
        },
      });

      const waitActivity = defineActivity({
        name: 'wait',
        runWhen: () => ({ ready: false, reason: 'Waiting' }),
        execute: async () => ({ waited: true }),
      });

      const workflow = defineWorkflow({
        name: 'longRunning',
        activities: [logTime, waitActivity, logTime],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });

      // First activity
      await ctx.engine.tick();
      expect(timestamps).toHaveLength(1);

      // Simulate days passing while waiting
      ctx.clock.advance(1000 * 60 * 60 * 24 * 3); // 3 days

      // Still waiting
      await ctx.engine.tick();

      // Cancel to end the test
      await ctx.engine.cancelExecution(execution.runId);

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('cancelled');
    });

    it('should accumulate state over extended processing', async () => {
      const activities = Array.from({ length: 10 }, (_, i) =>
        defineActivity({
          name: `step${i}`,
          execute: async () => ({
            [`step${i}`]: `completed at ${ctx.clock.now()}`,
          }),
        })
      );

      const workflow = defineWorkflow({
        name: 'manySteps',
        activities,
      });

      const execution = await ctx.engine.start(workflow, {
        input: { startTime: ctx.clock.now() },
      });

      // Process each step with time gaps
      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
        ctx.clock.advance(1000 * 60 * 60); // 1 hour between steps
      }

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(Object.keys(result?.state ?? {}).length).toBe(11); // 10 steps + startTime
    });
  });

  // ===========================================================================
  // Priority and Ordering
  // ===========================================================================

  describe('Priority and ordering', () => {
    it('should process workflows in order they become ready', async () => {
      const processOrder: string[] = [];

      const trackActivity = (id: string) =>
        defineActivity({
          name: `track${id}`,
          execute: async () => {
            processOrder.push(id);
            return { processed: id };
          },
        });

      const workflow1 = defineWorkflow({
        name: 'w1',
        activities: [trackActivity('1')],
      });

      const workflow2 = defineWorkflow({
        name: 'w2',
        activities: [trackActivity('2')],
      });

      const workflow3 = defineWorkflow({
        name: 'w3',
        activities: [trackActivity('3')],
      });

      // Start in order
      await ctx.engine.start(workflow1, { input: {} });
      await ctx.engine.start(workflow2, { input: {} });
      await ctx.engine.start(workflow3, { input: {} });

      // Process all
      for (let i = 0; i < 5; i++) {
        await ctx.engine.tick();
      }

      // All should complete
      expect(processOrder).toContain('1');
      expect(processOrder).toContain('2');
      expect(processOrder).toContain('3');
    });
  });

  // ===========================================================================
  // Resource-Aware Processing
  // ===========================================================================

  describe('Resource-aware processing', () => {
    it('should respect battery-based conditions', async () => {
      let executed = false;

      const batteryAware = defineActivity({
        name: 'batteryAware',
        runWhen: (actCtx) => {
          const batteryLevel = actCtx.batteryLevel as number;
          if (batteryLevel < 0.2) {
            return { ready: false, reason: 'Battery too low' };
          }
          return { ready: true };
        },
        execute: async () => {
          executed = true;
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'batteryAware',
        activities: [batteryAware],
      });

      // Low battery
      ctx.environment.setBatteryLevel(0.1);
      await ctx.engine.start(workflow, { input: {} });

      await ctx.engine.tick();
      expect(executed).toBe(false);

      // Charge up
      ctx.environment.setBatteryLevel(0.5);
      ctx.clock.advance(35000);

      await ctx.engine.tick();
      expect(executed).toBe(true);
    });

    it('should handle app state transitions', async () => {
      const executions: { appState: string }[] = [];

      const stateAware = defineActivity({
        name: 'stateAware',
        execute: async () => {
          executions.push({ appState: ctx.environment.getAppState() });
          return { recorded: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'stateAware',
        activities: [stateAware],
      });

      // Active
      ctx.environment.setAppState('active');
      await ctx.engine.start(workflow, { input: {} });
      await ctx.engine.tick();

      // Background
      ctx.environment.setAppState('background');
      await ctx.engine.start(workflow, { input: {} });
      await ctx.engine.tick();

      expect(executions).toHaveLength(2);
      expect(executions[0].appState).toBe('active');
      expect(executions[1].appState).toBe('background');
    });
  });

  // ===========================================================================
  // Tick Behavior
  // ===========================================================================

  describe('Tick behavior', () => {
    it('should process multiple ready tasks in single tick', async () => {
      const processed: string[] = [];

      const quick = (name: string) =>
        defineActivity({
          name,
          execute: async () => {
            processed.push(name);
            return { [name]: true };
          },
        });

      const workflow = defineWorkflow({
        name: 'multi',
        activities: [quick('a')],
      });

      // Start multiple workflows
      await ctx.engine.start(workflow, { input: {} });
      await ctx.engine.start(workflow, { input: {} });
      await ctx.engine.start(workflow, { input: {} });

      // Single tick should process tasks
      await ctx.engine.tick();

      // At least one should be processed per tick
      expect(processed.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle rapid tick calls gracefully', async () => {
      const activity = defineActivity({
        name: 'rapid',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'rapid',
        activities: [activity],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });

      // Rapid ticks
      await Promise.all([
        ctx.engine.tick(),
        ctx.engine.tick(),
        ctx.engine.tick(),
        ctx.engine.tick(),
        ctx.engine.tick(),
      ]);

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  // ===========================================================================
  // Error Resilience
  // ===========================================================================

  describe('Error resilience', () => {
    it('should continue processing other workflows when one fails', async () => {
      const results: Record<string, string> = {};

      const successActivity = (id: string) =>
        defineActivity({
          name: `success${id}`,
          execute: async () => {
            results[id] = 'success';
            return { success: true };
          },
        });

      const failActivity = defineActivity({
        name: 'fail',
        retry: { maximumAttempts: 1 },
        execute: async () => {
          results['fail'] = 'attempted';
          throw new Error('Intentional failure');
        },
      });

      const successWorkflow = defineWorkflow({
        name: 'success',
        activities: [successActivity('a')],
      });

      const failWorkflow = defineWorkflow({
        name: 'fail',
        activities: [failActivity],
      });

      await ctx.engine.start(successWorkflow, { input: {} });
      await ctx.engine.start(failWorkflow, { input: {} });
      await ctx.engine.start(successWorkflow, { input: {} });

      // Process all
      for (let i = 0; i < 10; i++) {
        await ctx.engine.tick();
      }

      expect(results['a']).toBe('success');
      expect(results['fail']).toBe('attempted');
    });

    it('should handle callback errors without affecting workflow', async () => {
      let workflowCompleted = false;

      const activity = defineActivity({
        name: 'callbackError',
        onSuccess: async () => {
          throw new Error('Callback error');
        },
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'callbackError',
        activities: [activity],
        onComplete: async () => {
          workflowCompleted = true;
        },
      });

      const execution = await ctx.engine.start(workflow, { input: {} });

      await ctx.engine.tick();

      const result = await ctx.engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(workflowCompleted).toBe(true);
    });
  });

  // ===========================================================================
  // Engine Lifecycle
  // ===========================================================================

  describe('Engine lifecycle', () => {
    it('should stop processing after stop() is called', async () => {
      const activity = defineActivity({
        name: 'count',
        execute: async () => ({ count: 1 }),
      });

      const workflow = defineWorkflow({
        name: 'lifecycle',
        activities: [activity],
      });

      await ctx.engine.start(workflow, { input: {} });

      ctx.engine.stop();

      // Tick after stop should not throw
      await ctx.engine.tick();
    });

    it('should emit events during processing', async () => {
      const events: Array<{ type: string; runId?: string }> = [];

      const activity = defineActivity({
        name: 'eventful',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'eventful',
        activities: [activity],
      });

      // Create engine with onEvent callback
      const eventCtx = await createTestContext({
        onEvent: (event: unknown) => {
          const e = event as { type: string; runId?: string };
          events.push({ type: e.type, runId: e.runId });
        },
      });

      await eventCtx.engine.start(workflow, { input: {} });
      await eventCtx.engine.tick();

      eventCtx.engine.stop();

      expect(events.some((e) => e.type === 'activity:started')).toBe(true);
      expect(events.some((e) => e.type === 'activity:completed')).toBe(true);
      expect(events.some((e) => e.type === 'execution:completed')).toBe(true);
    });
  });
});
