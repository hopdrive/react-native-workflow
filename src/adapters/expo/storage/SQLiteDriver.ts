/**
 * Abstract interface for SQLite operations.
 * This allows us to use expo-sqlite in the app and better-sqlite3 in tests.
 */

export interface SQLiteRow {
  [key: string]: unknown;
}

export interface SQLiteResult {
  rows: SQLiteRow[];
  changes?: number;
}

/**
 * Abstract SQLite driver interface.
 * Implementations can be provided for expo-sqlite or better-sqlite3.
 */
export interface SQLiteDriver {
  /**
   * Execute a SQL statement that doesn't return rows.
   */
  execute(sql: string, params?: unknown[]): Promise<SQLiteResult>;

  /**
   * Execute a SQL query that returns rows.
   */
  query(sql: string, params?: unknown[]): Promise<SQLiteRow[]>;

  /**
   * Run multiple statements in a transaction.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Close the database connection.
   */
  close(): Promise<void>;
}

/**
 * Factory type for creating SQLite drivers.
 */
export type SQLiteDriverFactory = (databaseName: string) => Promise<SQLiteDriver>;
