# React Native Workflow Engine

A persistent, offline-first workflow orchestration system for React Native. Inspired by [Temporal](https://temporal.io), designed for mobile.

## Quick Start

### 1. Define Activities

Activities are the building blocks—functions that do actual work:

```typescript
import { defineActivity, conditions } from 'react-native-workflow';

const capturePhoto = defineActivity({
  name: 'capturePhoto',
  execute: async (ctx) => {
    const hash = await generateHash(ctx.input.uri);
    return { hash };
  },
});

const uploadPhoto = defineActivity({
  name: 'uploadPhoto',
  runWhen: conditions.whenConnected,  // Only run when online
  retry: { maximumAttempts: 5 },
  execute: async (ctx) => {
    const s3Key = await uploadToS3(ctx.input.uri);
    return { s3Key };
  },
});

const notifyServer = defineActivity({
  name: 'notifyServer',
  runWhen: conditions.whenConnected,
  execute: async (ctx) => {
    await api.post(`/photos`, { s3Key: ctx.input.s3Key });
  },
});
```

### 2. Define a Workflow

Workflows chain activities together:

```typescript
import { defineWorkflow } from 'react-native-workflow';

const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, uploadPhoto, notifyServer],
});
```

### 3. Run the Engine

```typescript
import { WorkflowEngine } from 'react-native-workflow';

// Create the engine
const engine = await WorkflowEngine.create({
  storage: new SQLiteStorage(db),
  environment: new ExpoEnvironment(),
});

// Register workflows
engine.registerWorkflow(photoWorkflow);

// Start a workflow
const execution = await engine.start(photoWorkflow, {
  input: { uri: 'file://photo.jpg', moveId: 123 },
});

console.log(execution.runId); // "abc-123-def"

// Process activities
await engine.tick();
```

### 4. Track Progress (React)

```tsx
import { useExecution } from 'react-native-workflow';

function PhotoProgress({ runId }) {
  const execution = useExecution(runId);

  if (!execution) return <Text>Loading...</Text>;

  return (
    <View>
      <Text>Status: {execution.status}</Text>
      <Text>Step: {execution.currentActivityName}</Text>
    </View>
  );
}
```

---

## Core Concepts

### Activities

An **Activity** is a unit of work—a function that does something (upload, sync, notify). Activities are:

- **Independently retryable** - Each can fail and retry without affecting others
- **Conditionally executable** - Can wait for network, battery, or custom conditions
- **State-producing** - Return values accumulate into workflow state

```typescript
const myActivity = defineActivity({
  name: 'myActivity',
  execute: async (ctx) => {
    // ctx.input contains accumulated workflow state
    // ctx.signal is an AbortSignal for cancellation
    return { result: 'value' };  // Merged into state
  },
});
```

### Workflows

A **Workflow** is a sequence of activities representing a business process:

```typescript
const myWorkflow = defineWorkflow({
  name: 'myWorkflow',
  activities: [step1, step2, step3],
  onComplete: async (runId, finalState) => {
    console.log('Done!', finalState);
  },
});
```

### Workflow Executions

A **WorkflowExecution** is an instance of a running workflow:

```typescript
const execution = await engine.start(myWorkflow, {
  input: { userId: 123 },
});

// Later...
const status = await engine.getExecution(execution.runId);
// { status: 'running', currentActivityName: 'step2', state: {...} }
```

### State Threading

State flows through activities. Each activity receives the accumulated state and can add to it:

```typescript
// Workflow starts with: { uri: 'file://photo.jpg' }

// Activity 1 returns: { hash: 'abc123' }
// State is now: { uri: 'file://photo.jpg', hash: 'abc123' }

// Activity 2 returns: { s3Key: 'uploads/123.jpg' }
// State is now: { uri: '...', hash: 'abc123', s3Key: 'uploads/123.jpg' }
```

---

## Activity Configuration

### Retry Policy

```typescript
defineActivity({
  name: 'upload',
  retry: {
    maximumAttempts: 10,      // Max retries before failing
    initialInterval: 1000,    // First retry after 1 second
    backoffCoefficient: 2,    // Double each time: 1s, 2s, 4s, 8s...
    maximumInterval: 60000,   // Cap at 60 seconds
  },
  execute: async (ctx) => { /* ... */ },
});
```

### Timeouts

```typescript
defineActivity({
  name: 'upload',
  startToCloseTimeout: 60000,  // Activity must complete within 60s
  execute: async (ctx) => { /* ... */ },
});
```

### Conditional Execution (runWhen)

Activities can wait for conditions to be met:

```typescript
import { conditions } from 'react-native-workflow';

// Built-in conditions
defineActivity({
  name: 'sync',
  runWhen: conditions.whenConnected,  // Wait for network
  execute: async (ctx) => { /* ... */ },
});

// Custom conditions
defineActivity({
  name: 'heavySync',
  runWhen: (ctx) => {
    if (!ctx.isConnected) {
      return { ready: false, reason: 'No network' };
    }
    if (ctx.batteryLevel < 0.2) {
      return { ready: false, reason: 'Low battery' };
    }
    return { ready: true };
  },
  execute: async (ctx) => { /* ... */ },
});
```

### Priority

Higher priority activities are processed first:

```typescript
defineActivity({
  name: 'urgent',
  priority: 100,  // Processed before priority: 0 (default)
  execute: async (ctx) => { /* ... */ },
});
```

---

## Lifecycle Callbacks

### Activity Callbacks

```typescript
defineActivity({
  name: 'upload',
  execute: async (ctx) => { /* ... */ },

  onStart: async (taskId, input) => {
    console.log('Starting upload...');
  },
  onSuccess: async (taskId, input, result) => {
    console.log('Upload succeeded:', result);
  },
  onFailure: async (taskId, input, error, attempt) => {
    console.log(`Attempt ${attempt} failed:`, error.message);
  },
  onFailed: async (taskId, input, error) => {
    console.log('Upload permanently failed');
  },
});
```

### Workflow Callbacks

```typescript
defineWorkflow({
  name: 'photo',
  activities: [capture, upload, notify],

  onComplete: async (runId, finalState) => {
    console.log('Workflow completed:', finalState);
  },
  onFailed: async (runId, state, error) => {
    await notifyUser('Photo upload failed');
  },
  onCancelled: async (runId, state) => {
    await cleanupPartialUpload(state);
  },
});
```

---

## Deduplication (UniqueKey)

Prevent duplicate workflows with `uniqueKey`:

```typescript
// Only one sync per driver at a time
await engine.start(driverSyncWorkflow, {
  input: { driverId: 456 },
  uniqueKey: `driver-sync:${driverId}`,
});

// Trying to start another throws UniqueConstraintError
try {
  await engine.start(driverSyncWorkflow, {
    input: { driverId: 456 },
    uniqueKey: `driver-sync:${driverId}`,
  });
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.log('Already syncing:', err.existingRunId);
  }
}
```

---

## Cancellation

```typescript
// Cancel a running workflow
await engine.cancelExecution(runId);
```

Activities receive an `AbortSignal` to handle cancellation gracefully:

```typescript
defineActivity({
  name: 'upload',
  execute: async (ctx) => {
    // Pass signal to fetch for automatic abort
    const response = await fetch(url, { signal: ctx.signal });

    // Or check manually in loops
    for (const item of items) {
      if (ctx.signal.aborted) {
        throw new Error('Cancelled');
      }
      await processItem(item);
    }
  },
});
```

---

## Dead Letter Queue

When activities permanently fail (exhaust all retries), they're moved to the dead letter queue:

```typescript
// Get failed activities
const deadLetters = await engine.getDeadLetters();

for (const dl of deadLetters) {
  console.log(`${dl.activityName} failed: ${dl.error}`);
  console.log('Input was:', dl.input);

  // Acknowledge after reviewing
  await engine.acknowledgeDeadLetter(dl.id);
}

// Retry a dead letter
await engine.retryDeadLetter(dl.id);
```

---

## React Hooks

```tsx
import {
  useExecution,
  useExecutionsByStatus,
  useDeadLetters,
  usePendingActivityCount,
  useExecutionStats,
  useWorkflowStarter,
} from 'react-native-workflow';

function Dashboard() {
  // Single execution
  const execution = useExecution(runId);

  // All running executions
  const running = useExecutionsByStatus('running');

  // Dead letter queue
  const deadLetters = useDeadLetters();

  // Pending activity count
  const pendingCount = usePendingActivityCount();

  // Aggregate stats
  const stats = useExecutionStats();
  // { pending: 3, running: 1, completed: 42, failed: 2 }

  // Start workflows from components
  const { start, isStarting } = useWorkflowStarter(photoWorkflow);

  return (
    <Button
      title="Upload Photo"
      onPress={() => start({ uri: 'file://photo.jpg' })}
      disabled={isStarting}
    />
  );
}
```

---

## Background Processing

Integrate with OS background systems:

```typescript
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

TaskManager.defineTask('WORKFLOW_BACKGROUND', async () => {
  const engine = await WorkflowEngine.create({ /* ... */ });
  engine.registerWorkflow(photoWorkflow);

  // Process for 25 seconds (iOS/Android limit ~30s)
  await engine.runFor(25000);

  return BackgroundFetch.BackgroundFetchResult.NewData;
});

// Register for periodic execution
await BackgroundFetch.registerTaskAsync('WORKFLOW_BACKGROUND', {
  minimumInterval: 15 * 60,  // Every 15 minutes
});
```

---

## Design Philosophy

### Small, Idempotent Activities

Activities should be the **smallest unit of work that can be safely retried**. When interrupted, activities restart from the beginning—not resume.

**Good:** Each step is its own activity
```typescript
const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [
    preparePhoto,   // Can restart safely
    uploadPhoto,    // Can restart safely
    notifyServer,   // Can restart safely
  ],
});
```

**Bad:** Multiple side effects in one activity
```typescript
// If this crashes after charging but before saving,
// restarting will charge the card again!
execute: async (ctx) => {
  await chargeCard(ctx.input.amount);  // Side effect!
  await saveReceipt(ctx.input.orderId); // Crash here = double charge
}
```

**Better:** Design for idempotency
```typescript
execute: async (ctx) => {
  const existing = await getCharge(ctx.input.orderId);
  if (existing) return { chargeId: existing.id };

  const charge = await stripe.charges.create({
    amount: ctx.input.amount,
    idempotency_key: ctx.input.idempotencyKey,  // Stripe deduplicates
  });
  return { chargeId: charge.id };
}
```

### The Checkpoint Test

Ask yourself: "If this activity crashes at any line and restarts, what happens?"

- **Safe:** Re-uploading the same file (overwrites with same content)
- **Safe:** API request with idempotency key
- **Unsafe:** Incrementing counter without checking current value
- **Unsafe:** Sending notification without checking if already sent

---

## Storage Backends

The engine uses a pluggable storage layer:

```typescript
// SQLite (recommended for most apps)
import { SQLiteStorage } from 'react-native-workflow/expo';
const engine = await WorkflowEngine.create({
  storage: new SQLiteStorage(db),
});

// In-memory (for testing)
import { InMemoryStorage } from 'react-native-workflow';
const engine = await WorkflowEngine.create({
  storage: new InMemoryStorage(),
});
```

---

## API Reference

### WorkflowEngine

```typescript
// Create engine
const engine = await WorkflowEngine.create({
  storage: StorageAdapter,
  environment: EnvironmentAdapter,
  onEvent?: (event: WorkflowEvent) => void,
});

// Register workflows
engine.registerWorkflow(workflow);
engine.getWorkflow(name): Workflow | undefined;
engine.getActivity(name): Activity | undefined;

// Start workflows
engine.start(workflow, options): Promise<WorkflowExecution>;
// Options: { input, uniqueKey?, onConflict?: 'throw' | 'ignore' }

// Query executions
engine.getExecution(runId): Promise<WorkflowExecution | null>;
engine.getExecutionsByStatus(status): Promise<WorkflowExecution[]>;

// Control
engine.cancelExecution(runId): Promise<void>;
engine.tick(): Promise<void>;  // Process pending activities
engine.runFor(ms): Promise<void>;  // Process for duration
engine.stop(): void;

// Dead letters
engine.getDeadLetters(): Promise<DeadLetterRecord[]>;
engine.acknowledgeDeadLetter(id): Promise<void>;
engine.retryDeadLetter(id): Promise<void>;
```

### defineActivity

```typescript
defineActivity({
  name: string,
  execute: (ctx: ActivityContext) => Promise<object | void>,

  // Optional
  retry?: {
    maximumAttempts?: number,    // default: 1
    initialInterval?: number,    // default: 1000ms
    backoffCoefficient?: number, // default: 2
    maximumInterval?: number,    // default: none
  },
  startToCloseTimeout?: number,  // default: 30000ms
  priority?: number,             // default: 0
  runWhen?: RunCondition,

  // Callbacks
  onStart?: (taskId, input) => Promise<void>,
  onSuccess?: (taskId, input, result) => Promise<void>,
  onFailure?: (taskId, input, error, attempt) => Promise<void>,
  onFailed?: (taskId, input, error) => Promise<void>,
});
```

### defineWorkflow

```typescript
defineWorkflow({
  name: string,
  activities: Activity[],

  // Callbacks
  onComplete?: (runId, finalState) => Promise<void>,
  onFailed?: (runId, state, error) => Promise<void>,
  onCancelled?: (runId, state) => Promise<void>,
});
```

### ActivityContext

```typescript
interface ActivityContext<TInput = any> {
  runId: string;           // Workflow execution ID
  taskId: string;          // Activity task ID
  attempt: number;         // Current attempt (1-based)
  input: TInput;           // Accumulated workflow state
  signal: AbortSignal;     // Fires on cancel/timeout
  isConnected: boolean;    // Network connectivity
  batteryLevel?: number;   // Device battery (0-1)
}
```

---

## Relationship to Temporal

This engine is inspired by [Temporal](https://temporal.io) but simplified for mobile:

| This System | Temporal | Notes |
|-------------|----------|-------|
| Workflow | Workflow | Same concept |
| WorkflowExecution | Workflow Execution | Same concept |
| Activity | Activity | Same concept |
| runId | Run ID | Same concept |
| uniqueKey | Workflow ID | Similar deduplication |
| runWhen | *(none)* | Mobile-specific for offline |
| WorkflowEngine | Worker + Client | Combined for single-process mobile |

**Features intentionally omitted** (add complexity beyond mobile needs):
- Signals, Queries, Child Workflows
- Deterministic Replay
- Task Queues, Versioning

---

## File Organization

Recommended structure for your workflows:

```
/workflows
  /photo
    capturePhoto.ts      # Activity
    uploadPhoto.ts       # Activity
    notifyServer.ts      # Activity
    workflow.ts          # Workflow definition
    index.ts             # Public export
  /sync
    fetchData.ts
    updateLocal.ts
    workflow.ts
    index.ts
```

---

## Testing

See [tests/README.md](tests/README.md) for test documentation.

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```
