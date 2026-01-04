/**
 * Test utilities for workflow engine testing.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { WorkflowExecution, ActivityContext } from '../../src/core/types';
import { InMemoryStorage } from '../../src/core/storage';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';

/**
 * Options for creating a test engine.
 */
export interface TestEngineOptions {
  storage?: InMemoryStorage;
  clock?: MockClock;
  scheduler?: MockScheduler;
  environment?: MockEnvironment;
  isConnected?: boolean;
  batteryLevel?: number;
}

/**
 * Create a test engine with common defaults.
 */
export async function createTestEngine(
  options?: TestEngineOptions
): Promise<WorkflowEngine> {
  const storage = options?.storage ?? new InMemoryStorage();
  const clock = options?.clock ?? new MockClock(1000000);
  const scheduler = options?.scheduler ?? new MockScheduler(clock);
  const environment = options?.environment ?? new MockEnvironment({
    isConnected: options?.isConnected ?? true,
    batteryLevel: options?.batteryLevel,
  });

  return WorkflowEngine.create({
    storage,
    clock,
    scheduler,
    environment,
  });
}

/**
 * Run engine until workflow completes, fails, or times out.
 */
export async function runUntilComplete(
  engine: WorkflowEngine,
  runId: string,
  options?: { timeout?: number; tickInterval?: number; clock?: MockClock }
): Promise<WorkflowExecution> {
  const { timeout = 5000, tickInterval = 10, clock } = options ?? {};
  const start = Date.now();

  while (Date.now() - start < timeout) {
    // Advance mock clock if provided (for gated activities)
    if (clock) {
      clock.advance(35000); // Advance past default 30s gating delay
    }

    await engine.tick();
    const execution = await engine.getExecution(runId);

    if (!execution) {
      throw new Error(`Execution ${runId} not found`);
    }

    if (execution.status !== 'running') {
      return execution;
    }

    await sleep(tickInterval);
  }

  throw new Error(`Workflow ${runId} did not complete within ${timeout}ms`);
}

/**
 * Options for creating a test activity.
 */
export interface TestActivityOptions {
  execute?: (ctx: ActivityContext) => Promise<Record<string, unknown>>;
  shouldFail?: boolean;
  failUntilAttempt?: number;
  delay?: number;
  startToCloseTimeout?: number;
  retry?: {
    maximumAttempts?: number;
    initialInterval?: number;
    backoffCoefficient?: number;
    maximumInterval?: number;
  };
}

/**
 * Create a simple test activity.
 */
export function createTestActivity(
  name: string,
  options?: TestActivityOptions
) {
  const {
    execute,
    shouldFail = false,
    failUntilAttempt = 0,
    delay = 0,
    startToCloseTimeout,
    retry,
  } = options ?? {};

  return defineActivity({
    name,
    startToCloseTimeout,
    retry,
    execute: async (ctx) => {
      if (delay) await sleep(delay);

      if (shouldFail) {
        throw new Error(`${name} intentionally failed`);
      }

      if (failUntilAttempt > 0 && ctx.attempt < failUntilAttempt) {
        throw new Error(`${name} failed on attempt ${ctx.attempt}`);
      }

      if (execute) {
        return execute(ctx);
      }

      return { [name]: 'done', attempt: ctx.attempt };
    },
  });
}

/**
 * Sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for condition to be true.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options ?? {};
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Create test dependencies (clock, scheduler, environment).
 */
export function createTestDeps(options?: {
  startTime?: number;
  isConnected?: boolean;
  batteryLevel?: number;
}) {
  const clock = new MockClock(options?.startTime ?? 1000000);
  const scheduler = new MockScheduler(clock);
  const environment = new MockEnvironment({
    isConnected: options?.isConnected ?? true,
    batteryLevel: options?.batteryLevel,
  });

  return { clock, scheduler, environment };
}
