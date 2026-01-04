/**
 * Built-in conditions for activity runWhen configuration.
 */

import { RunConditionFn } from './types';

/**
 * Always ready - default condition.
 */
export const always: RunConditionFn = () => ({ ready: true });

/**
 * Ready when network is connected.
 */
export const whenConnected: RunConditionFn = (ctx) => {
  if (ctx.isConnected) {
    return { ready: true };
  }
  return { ready: false, reason: 'No network connection' };
};

/**
 * Ready when network is disconnected (for offline-only work).
 */
export const whenDisconnected: RunConditionFn = (ctx) => {
  if (!ctx.isConnected) {
    return { ready: true };
  }
  return { ready: false, reason: 'Network is connected' };
};

/**
 * Creates a condition that is ready after the activity has been pending for a given delay.
 * Note: This requires tracking when the task was created, which is available via task.createdAt.
 * The engine will check this against the current time.
 */
export function afterDelay(delayMs: number): RunConditionFn {
  return (_ctx) => {
    // The engine will handle this by checking scheduledFor
    // This condition just signals to the engine to use delay scheduling
    return { ready: true, retryInMs: delayMs };
  };
}

/**
 * Combines multiple conditions - ready when ALL are ready.
 */
export function all(...conditions: RunConditionFn[]): RunConditionFn {
  return (ctx) => {
    const reasons: string[] = [];
    let maxRetryInMs: number | undefined;

    for (const condition of conditions) {
      const result = condition(ctx);
      if (!result.ready) {
        reasons.push(result.reason ?? 'Condition not met');
      }
      if (result.retryInMs !== undefined) {
        maxRetryInMs = maxRetryInMs !== undefined
          ? Math.max(maxRetryInMs, result.retryInMs)
          : result.retryInMs;
      }
    }

    if (reasons.length > 0) {
      return {
        ready: false,
        reason: reasons.join('; '),
        retryInMs: maxRetryInMs,
      };
    }

    return { ready: true, retryInMs: maxRetryInMs };
  };
}

/**
 * Combines multiple conditions - ready when ANY is ready.
 */
export function any(...conditions: RunConditionFn[]): RunConditionFn {
  return (ctx) => {
    const reasons: string[] = [];
    let minRetryInMs: number | undefined;

    for (const condition of conditions) {
      const result = condition(ctx);
      if (result.ready) {
        return { ready: true };
      }
      reasons.push(result.reason ?? 'Condition not met');
      if (result.retryInMs !== undefined) {
        minRetryInMs = minRetryInMs !== undefined
          ? Math.min(minRetryInMs, result.retryInMs)
          : result.retryInMs;
      }
    }

    return {
      ready: false,
      reason: reasons.join(' OR '),
      retryInMs: minRetryInMs,
    };
  };
}

/**
 * Inverts a condition.
 */
export function not(condition: RunConditionFn): RunConditionFn {
  return (ctx) => {
    const result = condition(ctx);
    if (result.ready) {
      return { ready: false, reason: 'Inverse condition not met' };
    }
    return { ready: true };
  };
}

/**
 * Export all conditions as a namespace.
 */
export const conditions = {
  always,
  whenConnected,
  whenDisconnected,
  afterDelay,
  all,
  any,
  not,
};
