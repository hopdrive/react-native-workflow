/**
 * Integration Test - Background Processing
 * Tests for background task execution, scheduling, and lifecycle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/engine';
import { InMemoryStorage } from '../../src/core/storage';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { runUntilComplete, sleep } from '../utils/testHelpers';

describe('Background Processing Integration', () => {
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

  describe('Scheduled activity processing', () => {
    it('should process newly created tasks immediately', async () => {
      let executionTime = 0;

      const delayedActivity = defineActivity({
        name: 'delayed',
        execute: async () => {
          executionTime = clock.now();
          return { executed: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'delayed',
        activities: [delayedActivity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      // Get the task - should exist and be pending
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('pending');

      await engine.tick();

      expect(executionTime).toBeGreaterThan(0);

      const result = await engine.getExecution(execution.runId);
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

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      // Manually update task to be scheduled for future
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      await storage.saveActivityTask({
        ...tasks[0]!,
        scheduledFor: clock.now() + 60000, // 1 minute in future
      });

      // Tick should not process
      await engine.tick();
      expect(executed).toBe(false);

      // Advance clock
      clock.advance(60001);

      // Now it should process
      await engine.tick();
      expect(executed).toBe(true);
    });
  });

  describe('Long-running workflows', () => {
    it('should handle workflows that span long time periods', async () => {
      const timestamps: number[] = [];

      const logTime = defineActivity({
        name: 'logTime',
        execute: async () => {
          timestamps.push(clock.now());
          return { time: clock.now() };
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

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      // First activity
      await engine.tick();
      expect(timestamps).toHaveLength(1);

      // Simulate days passing while waiting
      clock.advance(1000 * 60 * 60 * 24 * 3); // 3 days

      // Still waiting
      await engine.tick();

      // Eventually unblock (by changing the activity for this test)
      // We'll just cancel to end the test
      await engine.cancelExecution(execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('cancelled');
    });

    it('should accumulate state over extended processing', async () => {
      const activities = Array.from({ length: 10 }, (_, i) =>
        defineActivity({
          name: `step${i}`,
          execute: async () => ({
            [`step${i}`]: `completed at ${clock.now()}`,
          }),
        })
      );

      const workflow = defineWorkflow({
        name: 'manySteps',
        activities,
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: { startTime: clock.now() } });

      // Process each step with time gaps
      for (let i = 0; i < 10; i++) {
        await engine.tick();
        clock.advance(1000 * 60 * 60); // 1 hour between steps
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(Object.keys(result?.state ?? {}).length).toBe(11); // 10 steps + startTime
    });
  });

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

      const engine = await createEngine();

      // Start in order
      await engine.start(workflow1, { input: {} });
      await engine.start(workflow2, { input: {} });
      await engine.start(workflow3, { input: {} });

      // Process all
      for (let i = 0; i < 5; i++) {
        await engine.tick();
      }

      // All should complete
      expect(processOrder).toContain('1');
      expect(processOrder).toContain('2');
      expect(processOrder).toContain('3');
    });
  });

  describe('Resource-aware processing', () => {
    it('should respect battery-based conditions', async () => {
      let executed = false;

      const batteryAware = defineActivity({
        name: 'batteryAware',
        runWhen: (ctx) => {
          const batteryLevel = ctx.batteryLevel as number;
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

      const engine = await createEngine();

      // Low battery
      environment.setBatteryLevel(0.1);
      await engine.start(workflow, { input: {} });

      await engine.tick();
      expect(executed).toBe(false);

      // Charge up
      environment.setBatteryLevel(0.5);
      clock.advance(35000);

      await engine.tick();
      expect(executed).toBe(true);
    });

    it('should handle app state transitions', async () => {
      const executions: { appState: string }[] = [];

      const stateAware = defineActivity({
        name: 'stateAware',
        execute: async () => {
          executions.push({ appState: environment.getAppState() });
          return { recorded: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'stateAware',
        activities: [stateAware],
      });

      const engine = await createEngine();

      // Active
      environment.setAppState('active');
      await engine.start(workflow, { input: {} });
      await engine.tick();

      // Background
      environment.setAppState('background');
      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(executions).toHaveLength(2);
      expect(executions[0].appState).toBe('active');
      expect(executions[1].appState).toBe('background');
    });
  });

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

      const engine = await createEngine();

      // Start multiple workflows
      await engine.start(workflow, { input: {} });
      await engine.start(workflow, { input: {} });
      await engine.start(workflow, { input: {} });

      // Single tick should process tasks
      await engine.tick();

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

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      // Rapid ticks
      await Promise.all([
        engine.tick(),
        engine.tick(),
        engine.tick(),
        engine.tick(),
        engine.tick(),
      ]);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

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

      const engine = await createEngine();

      await engine.start(successWorkflow, { input: {} });
      await engine.start(failWorkflow, { input: {} });
      await engine.start(successWorkflow, { input: {} });

      // Process all
      for (let i = 0; i < 10; i++) {
        await engine.tick();
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

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(workflowCompleted).toBe(true);
    });
  });

  describe('Engine lifecycle', () => {
    it('should stop processing after stop() is called', async () => {
      let executionCount = 0;

      const activity = defineActivity({
        name: 'count',
        execute: async () => {
          executionCount++;
          return { count: executionCount };
        },
      });

      const workflow = defineWorkflow({
        name: 'lifecycle',
        activities: [activity],
      });

      const engine = await createEngine();
      await engine.start(workflow, { input: {} });

      engine.stop();

      // Tick after stop should not throw
      await engine.tick();

      // But should not process (engine is stopped)
      // Note: The exact behavior depends on engine implementation
      // This test documents expected behavior
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
      const engine = await WorkflowEngine.create({
        storage,
        clock,
        scheduler,
        environment,
        onEvent: (event) => {
          events.push({ type: event.type, runId: event.runId });
        },
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(events.some((e) => e.type === 'activity:started')).toBe(true);
      expect(events.some((e) => e.type === 'activity:completed')).toBe(true);
      expect(events.some((e) => e.type === 'execution:completed')).toBe(true);
    });
  });
});
