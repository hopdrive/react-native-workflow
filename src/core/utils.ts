/**
 * Utility functions for the workflow engine.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique identifier.
 */
export function generateId(): string {
  return uuidv4();
}

/**
 * Calculate backoff delay for a retry attempt.
 */
export function calculateBackoffDelay(
  attempt: number,
  initialInterval: number,
  backoffCoefficient: number,
  maximumInterval?: number
): number {
  // Attempt is 1-based, so for attempt 1, we use initialInterval
  // For attempt 2, we use initialInterval * coefficient
  // For attempt 3, we use initialInterval * coefficient^2
  const delay = initialInterval * Math.pow(backoffCoefficient, attempt - 1);

  if (maximumInterval !== undefined) {
    return Math.min(delay, maximumInterval);
  }
  return delay;
}

/**
 * Create a logger that adds context to all log messages.
 */
export function createContextLogger(
  baseFn: (...args: unknown[]) => void,
  context: Record<string, unknown>
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    baseFn(...args, context);
  };
}

/**
 * Shallow merge objects, handling undefined return values.
 */
export function mergeState(
  base: Record<string, unknown>,
  additions: Record<string, unknown> | undefined | null | void
): Record<string, unknown> {
  if (!additions || typeof additions !== 'object') {
    return base;
  }
  return { ...base, ...additions };
}

/**
 * Create an AbortController-like API that works in Node.
 */
export function createAbortController(): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  };
}

/**
 * Default logger that does nothing (silent).
 */
export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Console logger for development.
 */
export const consoleLogger = {
  debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`[Workflow] ${msg}`, meta ?? ''),
  info: (msg: string, meta?: Record<string, unknown>) => console.info(`[Workflow] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[Workflow] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`[Workflow] ${msg}`, meta ?? ''),
};
