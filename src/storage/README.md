# Storage

Storage adapters implement the `Storage` interface from core, providing persistence for workflow executions, activity tasks, and dead letter records.

## Available Adapters

- **sqlite/** - SQLite-based storage using expo-sqlite (for React Native) or better-sqlite3 (for testing)
- **memory/** - In-memory storage for testing and development

## Usage

```typescript
import { SQLiteStorage } from 'endura/storage/sqlite';
import { InMemoryStorage } from 'endura/storage/memory';
```
