/**
 * Expo/React Native clock implementation.
 * Uses real system time.
 */

import { Clock } from '../../../core/types';

/**
 * Real clock implementation for production use.
 * Uses the system clock for accurate timing.
 */
export class ExpoClock implements Clock {
  now(): number {
    return Date.now();
  }
}
