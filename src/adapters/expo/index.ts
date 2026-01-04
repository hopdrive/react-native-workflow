/**
 * Expo adapter for react-native-workflow.
 *
 * This module provides Expo-specific implementations for:
 * - SQLite storage (using expo-sqlite)
 * - Runtime adapters (clock, scheduler, environment)
 * - Background task integration (using expo-task-manager)
 * - React hooks for UI integration
 *
 * @example
 * ```typescript
 * import { ExpoWorkflowClient } from 'react-native-workflow/expo';
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
export {
  SQLiteStorage,
  SQLiteDriver,
  SQLiteRow,
  SQLiteResult,
  SQLiteDriverFactory,
  ExpoSqliteDriver,
  ExpoSQLiteFactory,
  getSchemaStatements,
  SCHEMA_VERSION,
  // Test utilities
  BetterSqlite3Driver,
  createBetterSqlite3Driver,
} from './storage';

// Runtime
export {
  ExpoClock,
  ExpoScheduler,
  ExpoEnvironment,
  ExpoEnvironmentOptions,
  NetworkStateProvider,
  BatteryLevelProvider,
} from './runtime';

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
