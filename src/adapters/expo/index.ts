/**
 * Expo adapter for endura.
 *
 * This module provides Expo-specific implementations for:
 * - SQLite storage (using expo-sqlite)
 * - Runtime adapters (clock, scheduler, environment)
 * - Background task integration (using expo-task-manager)
 * - React hooks for UI integration
 *
 * @example
 * ```typescript
 * import { ExpoWorkflowClient } from 'endura/adapters/expo';
 * import { openDatabaseAsync } from 'expo-sqlite';
 *
 * const client = await ExpoWorkflowClient.create({
 *   openDatabase: openDatabaseAsync,
 * });
 *
 * client.registerWorkflow(myWorkflow);
 * await client.start();
 * ```
 */

// Main client
export { ExpoWorkflowClient, ExpoWorkflowClientOptions } from './ExpoWorkflowClient';

// Storage
export { SQLiteStorage } from './SQLiteStorage';
export { SQLiteDriver, SQLiteRow, SQLiteResult, SQLiteDriverFactory } from './SQLiteDriver';
export { ExpoSqliteDriver, ExpoSQLiteFactory } from './ExpoSqliteDriver';
export { getSchemaStatements, SCHEMA_VERSION } from './schema';
// Test utilities
export { BetterSqlite3Driver, createBetterSqlite3Driver } from './BetterSqlite3Driver';

// Runtime
export { ExpoClock } from './ExpoClock';
export { ExpoScheduler } from './ExpoScheduler';
export {
  ExpoEnvironment,
  ExpoEnvironmentOptions,
  NetworkStateProvider,
  BatteryLevelProvider,
} from './ExpoEnvironment';

// Background
export {
  WORKFLOW_BACKGROUND_TASK,
  BackgroundFetchResult,
  BackgroundTaskOptions,
  RegisterBackgroundTaskOptions,
  runBackgroundWorkflowTask,
  registerBackgroundTask,
  unregisterBackgroundTask,
} from './background';

// Hooks
export {
  useExecution,
  useExecutionsByStatus,
  useDeadLetters,
  usePendingActivityCount,
  useExecutionStats,
  useWorkflowStarter,
  useEngineRunner,
  ExecutionStats,
} from './hooks';
