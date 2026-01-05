/**
 * Expo/React Native scheduler implementation.
 * Uses setTimeout/setInterval for scheduling.
 */

import { Scheduler } from '../../core/types';

/**
 * Real scheduler implementation using setTimeout/setInterval.
 */
export class ExpoScheduler implements Scheduler {
  private handles: Map<unknown, ReturnType<typeof setTimeout>> = new Map();
  private nextHandleId = 1;

  setTimeout(callback: () => void, delay: number): unknown {
    const handleId = this.nextHandleId++;
    const timeoutId = globalThis.setTimeout(() => {
      this.handles.delete(handleId);
      callback();
    }, delay);
    this.handles.set(handleId, timeoutId);
    return handleId;
  }

  clearTimeout(handle: unknown): void {
    const timeoutId = this.handles.get(handle);
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
      this.handles.delete(handle);
    }
  }

  sleep(delay: number): Promise<void> {
    return new Promise(resolve => globalThis.setTimeout(resolve, delay));
  }
}
