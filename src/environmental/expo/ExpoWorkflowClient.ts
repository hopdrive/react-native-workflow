/**
 * Expo Workflow Client - Main entry point for Expo apps.
 * Provides a convenient way to create and configure the workflow engine
 * with Expo-specific adapters.
 */

import { WorkflowEngine } from '../../core/engine';
import { SQLiteStorage, ExpoSqliteDriver, ExpoSQLiteFactory } from '../../storage/sqlite';
import { ExpoClock } from './ExpoClock';
import { ExpoScheduler } from './ExpoScheduler';
import { ExpoEnvironment, ExpoEnvironmentOptions } from './ExpoEnvironment';

/**
 * Configuration options for the Expo workflow client.
 */
export interface ExpoWorkflowClientOptions {
  /**
   * Name of the SQLite database file.
   * @default 'workflow.db'
   */
  databaseName?: string;

  /**
   * The openDatabaseAsync function from expo-sqlite.
   * Required to create the SQLite database.
   *
   * @example
   * ```typescript
   * import { openDatabaseAsync } from 'expo-sqlite';
   *
   * const client = await ExpoWorkflowClient.create({
   *   openDatabase: openDatabaseAsync,
   * });
   * ```
   */
  openDatabase: ExpoSQLiteFactory;

  /**
   * Environment options for network state and battery level.
   */
  environment?: ExpoEnvironmentOptions;

  /**
   * Event handler for workflow engine events.
   */
  onEvent?: (event: {
    type: string;
    runId?: string;
    taskId?: string;
    [key: string]: unknown;
  }) => void;
}

/**
 * Expo Workflow Client.
 * Combines the workflow engine with Expo-specific adapters.
 */
export class ExpoWorkflowClient {
  readonly engine: WorkflowEngine;
  readonly storage: SQLiteStorage;
  readonly environment: ExpoEnvironment;

  private constructor(
    engine: WorkflowEngine,
    storage: SQLiteStorage,
    environment: ExpoEnvironment
  ) {
    this.engine = engine;
    this.storage = storage;
    this.environment = environment;
  }

  /**
   * Create a new Expo workflow client.
   *
   * @example
   * ```typescript
   * import { openDatabaseAsync } from 'expo-sqlite';
   * import NetInfo from '@react-native-community/netinfo';
   *
   * const client = await ExpoWorkflowClient.create({
   *   openDatabase: openDatabaseAsync,
   *   environment: {
   *     getNetworkState: async () => {
   *       const state = await NetInfo.fetch();
   *       return state.isConnected ?? false;
   *     },
   *   },
   * });
   *
   * // Register workflows
   * client.registerWorkflow(photoWorkflow);
   *
   * // Start the engine
   * await client.start();
   * ```
   */
  static async create(options: ExpoWorkflowClientOptions): Promise<ExpoWorkflowClient> {
    const databaseName = options.databaseName ?? 'workflow.db';

    // Create the SQLite driver and storage
    const driver = await ExpoSqliteDriver.create(databaseName, options.openDatabase);
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    // Create runtime adapters
    const clock = new ExpoClock();
    const scheduler = new ExpoScheduler();
    const environment = new ExpoEnvironment(options.environment);

    // Create the engine
    const engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
      onEvent: options.onEvent,
    });

    return new ExpoWorkflowClient(engine, storage, environment);
  }

  /**
   * Start the workflow engine.
   * Begins processing pending activities.
   *
   * @param options - Optional configuration for the tick loop
   * @param options.lifespan - Maximum time to run in milliseconds (useful for background tasks)
   * @param options.tickInterval - Interval between ticks in milliseconds (default: 100)
   */
  async start(options?: { lifespan?: number; tickInterval?: number }): Promise<void> {
    const tickInterval = options?.tickInterval ?? 100;
    const deadline = options?.lifespan ? Date.now() + options.lifespan : null;
    const safetyBuffer = 500;

    while (true) {
      // Check deadline
      if (deadline && Date.now() >= deadline - safetyBuffer) {
        break;
      }

      await this.engine.tick();

      // Wait before next tick
      await new Promise(resolve => setTimeout(resolve, tickInterval));

      // If we processed nothing and no deadline, keep the loop running
      // In a real app, you might want to add an explicit stop() method
    }
  }

  /**
   * Process a single tick of the workflow engine.
   * Useful for manual control or testing.
   */
  async tick(): Promise<void> {
    await this.engine.tick();
  }

  /**
   * Close the client and release resources.
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  // Delegate common methods to the engine for convenience

  get registerWorkflow() {
    return this.engine.registerWorkflow.bind(this.engine);
  }

  get start_workflow() {
    return this.engine.start.bind(this.engine);
  }

  get getExecution() {
    return this.engine.getExecution.bind(this.engine);
  }

  get getExecutionsByStatus() {
    return this.engine.getExecutionsByStatus.bind(this.engine);
  }

  get cancelExecution() {
    return this.engine.cancelExecution.bind(this.engine);
  }

  get getDeadLetters() {
    return this.engine.getDeadLetters.bind(this.engine);
  }

  get getUnacknowledgedDeadLetters() {
    return this.engine.getUnacknowledgedDeadLetters.bind(this.engine);
  }

  get acknowledgeDeadLetter() {
    return this.engine.acknowledgeDeadLetter.bind(this.engine);
  }

  get purgeDeadLetters() {
    return this.engine.purgeDeadLetters.bind(this.engine);
  }
}
