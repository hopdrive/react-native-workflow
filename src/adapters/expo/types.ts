/**
 * Expo adapter types.
 */

import { WorkflowEngineConfig, Logger } from '../../core/types';

/**
 * Options for creating an Expo-configured engine.
 */
export interface ExpoEngineOptions {
  /** Optional custom logger */
  logger?: Logger;
  /** Database name for SQLite storage (default: 'workflow-engine.db') */
  databaseName?: string;
  /** Event handler for observability */
  onEvent?: WorkflowEngineConfig['onEvent'];
  /** Cleanup configuration */
  cleanup?: WorkflowEngineConfig['cleanup'];
}

/**
 * Background fetch result type (mirrors expo-background-fetch).
 */
export type BackgroundFetchResult = 'newData' | 'noData' | 'failed';
