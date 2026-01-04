# React Native Workflow Engine

## A "Temporal-lite" for Mobile

A persistent, offline-first workflow orchestration system for React Native applications. Inspired by [Temporal's](https://temporal.io) conceptual model but designed for embedded, on-device execution.

---

## Table of Contents

1. [Overview](#overview)
2. [Relationship to Temporal](#relationship-to-temporal)
3. [Design Philosophy](#design-philosophy)
4. [Terminology](#terminology)
5. [Core Concepts](#core-concepts)
6. [Architecture](#architecture)
7. [File Organization](#file-organization)
8. [Data Models](#data-models)
9. [API Design](#api-design)
10. [Activity Configuration](#activity-configuration)
11. [State Threading](#state-threading)
12. [Execution Semantics](#execution-semantics)
13. [Cancellation](#cancellation)
14. [Dead Letter Queue](#dead-letter-queue)
15. [Storage Backend](#storage-backend)
16. [Background Processing](#background-processing)
17. [Observability](#observability)
18. [Migration Path](#migration-path)
19. [Open Questions](#open-questions)
20. [Future Considerations](#future-considerations)

---

## Overview

### Problem Statement

Mobile applications operating in unreliable network conditions need a way to:

- Execute multi-step business processes reliably
- Persist work across app restarts and crashes
- Handle retries with configurable backoff strategies
- Defer execution until preconditions are met (network, time, business logic)
- Track progress through complex workflows
- Process work in the background within OS constraints

### Design Goals

1. **Offline-first**: All state persisted locally; network is optional
2. **Durable execution**: Workflows survive app crashes and device restarts
3. **Simple mental model**: Familiar patterns from industry-standard workflow engines
4. **React-friendly**: First-class hooks for UI integration
5. **Minimal footprint**: Lightweight enough for mobile constraints
6. **Storage-agnostic**: Pluggable persistence layer (MMKV, SQLite, Realm)

---

## Relationship to Temporal

This system is inspired by Temporal's conceptual model but simplified for mobile constraints.

### Terminology Mapping

| This System | Temporal Equivalent | Notes |
|-------------|---------------------|-------|
| Workflow | Workflow | Exact match |
| WorkflowExecution | Workflow Execution | Exact match |
| Activity | Activity | Exact match |
| ActivityOptions | Activity Options | Exact match |
| runId | Run ID | Exact match |
| uniqueKey | Workflow ID | Similar deduplication purpose |
| runWhen | (no equivalent) | Mobile-specific for offline/conditions |
| WorkflowEngine | Worker + Client | Combined since single-process on mobile |

### Features We Intentionally Omit

These Temporal features add complexity beyond what mobile workflows typically need:

- **Signals** - Send data to a running workflow from outside
- **Queries** - Read workflow state without affecting it
- **Child Workflows** - Workflows spawning sub-workflows
- **Continue-As-New** - Long-running workflow pagination
- **Deterministic Replay** - Temporal's core durability mechanism
- **Versioning** - Handling workflow definition changes mid-execution
- **Task Queues** - Routing/load-balancing across workers

---

## Design Philosophy

### Small, Idempotent, Restartable Activities

The fundamental principle of this system is that **activities should be the smallest unit of work that can be safely retried**.

#### Why This Matters

When an activity is interrupted (app crash, device reboot, user force-quit), the system has two choices:
1. Resume from where it left off (requires checkpointing)
2. Restart the activity from the beginning

This system chooses **restart from the beginning**. This is simpler, more predictable, and avoids complex state management. But it only works if activities are designed correctly.

#### Activity Design Guidelines

**DO: Break work into small, atomic activities**
```typescript
// Good: Each step is its own activity
const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [
    preparePhoto,      // Validate, generate metadata
    uploadPhoto,       // Upload to S3
    notifyServer,      // Tell backend about the upload
    cleanupLocal,      // Delete local file
  ],
});
```

**DON'T: Combine non-idempotent operations**
```typescript
// Bad: If this crashes after charging but before saving receipt,
// restarting will charge the card again!
execute: async (ctx) => {
  await chargeCard(ctx.input.amount);      // Side effect!
  await saveReceipt(ctx.input.orderId);    // If we crash here...
  return { charged: true };
}
```

**DO: Design for idempotency**
```typescript
// Good: Check if already done, use idempotency keys
execute: async (ctx) => {
  const { orderId, idempotencyKey } = ctx.input;
  
  // Check if already charged
  const existing = await getCharge(orderId);
  if (existing) return { chargeId: existing.id };
  
  // Charge with idempotency key (Stripe will dedupe)
  const charge = await stripe.charges.create({
    amount: ctx.input.amount,
    idempotency_key: idempotencyKey,
  });
  
  return { chargeId: charge.id };
}
```

#### The Checkpoint Test

Ask yourself: "If this activity crashes at any line and restarts from the beginning, what happens?"

- ✅ **Safe**: Re-uploading the same file to S3 (overwrites with same content)
- ✅ **Safe**: Re-sending an API request with an idempotency key
- ✅ **Safe**: Re-reading data and re-computing a result
- ❌ **Unsafe**: Incrementing a counter without checking current value
- ❌ **Unsafe**: Sending a notification without checking if already sent
- ❌ **Unsafe**: Any mutation without idempotency protection

#### When You Need Checkpoints

If you find yourself wanting mid-activity checkpoints, that's a signal to split into multiple activities:

```typescript
// Before: One big activity with implicit checkpoints
execute: async (ctx) => {
  const processed = await processImages(ctx.input.images);  // 30 seconds
  // "checkpoint" - what if we crash here?
  const uploaded = await uploadAll(processed);               // 60 seconds
  // "checkpoint" - what if we crash here?
  await notifyServer(uploaded);                              // 5 seconds
}

// After: Three activities, each restartable
const processImages = defineActivity({ ... });   // Can restart safely
const uploadImages = defineActivity({ ... });    // Can restart safely
const notifyServer = defineActivity({ ... });    // Can restart safely
```

#### Crash Recovery Behavior

When the engine starts, it checks for activities left in `active` status (indicating a crash during execution):

```typescript
// On engine startup
const abandonedActivities = await storage.getActivitiesByStatus('active');
for (const activity of abandonedActivities) {
  // Reset to pending - will be picked up and restarted
  activity.status = 'pending';
  activity.attempts += 1;  // Count the crashed attempt
  await storage.saveActivity(activity);
}
```

This is safe **only if activities follow the design guidelines above**.

---

## Terminology

| Term | Description |
|------|-------------|
| **Workflow** | A defined sequence of activities representing a business process |
| **WorkflowExecution** | A single execution instance of a workflow |
| **Activity** | A unit of work - a function that does something (upload, sync, notify) |
| **ActivityTask** | A persisted record of an activity to be executed (internal) |
| **ActivityOptions** | Configuration for an activity (timeout, retry, conditions) |
| **runId** | Unique identifier for a workflow execution |
| **uniqueKey** | Optional deduplication key to prevent concurrent duplicate workflows |

---

## Core Concepts

### Workflows

A **Workflow** is a definition—a blueprint for a business process. It specifies:

- A unique name
- An ordered sequence of activities
- Optional completion/failure/cancellation callbacks

```typescript
interface Workflow<TInput = any> {
  name: string;
  activities: Activity[];
  onComplete?: (runId: string, finalState: object) => Promise<void>;
  onFailed?: (runId: string, state: object, error: Error) => Promise<void>;
  onCancelled?: (runId: string, state: object) => Promise<void>;
}
```

A workflow definition is **static**—it doesn't change at runtime. Think of it like a class definition.

### Workflow Executions

A **WorkflowExecution** is an instance—a specific execution of a workflow. It tracks:

- Current position in the activity sequence
- Accumulated state (input + all activity returns merged)
- Status (running, completed, failed, cancelled)
- Timestamps

```typescript
interface WorkflowExecution {
  runId: string;
  workflowName: string;
  uniqueKey?: string;
  currentActivityIndex: number;
  currentActivityName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: object;              // Original input when workflow started
  state: object;              // Accumulated state (input + activity returns)
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  failedActivityName?: string;
}
```

A workflow execution is **mutable**—it changes as activities complete. Think of it like a class instance.

### Activities

An **Activity** is a function definition that does actual work. Activities are:

- **Pure async functions** - Receive input, return output
- **Configured with options** - Timeout, retry, conditions
- **Independently testable** - No framework dependencies in the function itself

```typescript
interface Activity<TInput = any, TOutput = any> {
  name: string;
  execute: (ctx: ActivityContext<TInput>) => Promise<TOutput>;
  options?: ActivityOptions;
}
```

### Activity Tasks (Internal)

An **ActivityTask** is a persisted record representing a scheduled activity execution. Users don't interact with these directly—they're internal to the engine.

```typescript
interface ActivityTask {
  taskId: string;
  runId: string;
  activityName: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
  input: object;
  result?: object;
  priority: number;
  attempts: number;
  maxAttempts: number;
  timeout: number;
  createdAt: number;
  scheduledFor?: number;
  startedAt?: number;
  lastAttemptAt?: number;
  completedAt?: number;
  error?: string;
  errorStack?: string;
}
```

---

## Architecture

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION LAYER                                          │
│  Your app code: UI, business logic                          │
│                                                             │
│  engine.start(photoWorkflow, { input: { moveId: 123 } })    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  WORKFLOW ENGINE                                            │
│  Orchestrates workflow execution                            │
│                                                             │
│  • Workflow registration and lookup                         │
│  • WorkflowExecution lifecycle management                   │
│  • Activity sequencing and state accumulation               │
│  • Uniqueness constraint enforcement                        │
│  • Cancellation coordination                                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  ACTIVITY EXECUTOR                                          │
│  Manages activity execution                                 │
│                                                             │
│  • Priority ordering                                        │
│  • Retry logic and backoff                                  │
│  • Concurrency control (async)                              │
│  • Precondition checking (runWhen)                          │
│  • Timeout enforcement                                      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  STORAGE LAYER                                              │
│  Persistent state (pluggable backend)                       │
│                                                             │
│  • WorkflowExecution records                                │
│  • ActivityTask records                                     │
│  • Dead letter records                                      │
│  • Uniqueness index                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## File Organization

### Recommended Structure

```
/workflows
  /photo
    capturePhoto.ts       # Activity definition + options
    uploadPhoto.ts        # Activity definition + options  
    notifyServer.ts       # Activity definition + options
    activities.ts         # Barrel export of all activities
    workflow.ts           # Workflow definition
    index.ts              # Public export
  /driverStatusSync
    syncStatus.ts
    activities.ts
    workflow.ts
    index.ts
  /moveStatusSync
    ...
```

### Activity Definition (One File Per Activity)

```typescript
// === workflows/photo/capturePhoto.ts ===
import { defineActivity } from 'react-native-workflow';

export const capturePhoto = defineActivity({
  name: 'capturePhoto',
  
  execute: async (ctx) => {
    const { uri } = ctx.input;
    const hash = await generateHash(uri);
    return { hash, processedUri: uri };
  },
  
  options: {
    startToCloseTimeout: 5000,
    retry: { maximumAttempts: 3 },
    
    // Activity-level callbacks
    onStart: async (taskId, input) => {
      console.log(`Starting capture: ${taskId}`);
    },
    onSuccess: async (taskId, input, result) => {
      console.log(`Captured with hash: ${result.hash}`);
    },
    onFailure: async (taskId, input, error, attempt) => {
      console.warn(`Capture attempt ${attempt} failed: ${error.message}`);
    },
    onFailed: async (taskId, input, error) => {
      console.error(`Capture permanently failed`);
    },
  },
});
```

```typescript
// === workflows/photo/uploadPhoto.ts ===
import { defineActivity, conditions } from 'react-native-workflow';

export const uploadPhoto = defineActivity({
  name: 'uploadPhoto',
  
  execute: async (ctx) => {
    const { uri, hash } = ctx.input;
    const response = await uploadToS3(uri, { signal: ctx.signal });
    return { s3Key: response.key, uploadedAt: Date.now() };
  },
  
  options: {
    startToCloseTimeout: 60000,
    retry: {
      maximumAttempts: 10,
      initialInterval: 5000,
      backoffCoefficient: 2,
      maximumInterval: 60000,
    },
    
    // Built-in condition
    runWhen: conditions.whenConnected,
    
    onSkipped: async (taskId, input, reason) => {
      console.log(`Upload skipped: ${reason}`);
    },
  },
});
```

```typescript
// === workflows/photo/notifyServer.ts ===
import { defineActivity } from 'react-native-workflow';

export const notifyServer = defineActivity({
  name: 'notifyServer',
  
  execute: async (ctx) => {
    const { moveId, s3Key } = ctx.input;
    await api.post(`/moves/${moveId}/photos`, { s3Key });
    // No return needed if nothing to add to state
  },
  
  options: {
    startToCloseTimeout: 30000,
    retry: { maximumAttempts: 10 },
    
    // Custom condition
    runWhen: (ctx) => {
      if (!ctx.isConnected) {
        return { ready: false, reason: 'No network connection' };
      }
      if (ctx.input.priority < 5 && ctx.batteryLevel < 0.2) {
        return { ready: false, reason: 'Low battery, deferring low priority work' };
      }
      return { ready: true };
    },
  },
});
```

### Activity Barrel Export

```typescript
// === workflows/photo/activities.ts ===
export { capturePhoto } from './capturePhoto';
export { uploadPhoto } from './uploadPhoto';
export { notifyServer } from './notifyServer';
```

### Workflow Definition

```typescript
// === workflows/photo/workflow.ts ===
import { defineWorkflow } from 'react-native-workflow';
import { capturePhoto, uploadPhoto, notifyServer } from './activities';

export const photoWorkflow = defineWorkflow({
  name: 'photo',
  
  activities: [capturePhoto, uploadPhoto, notifyServer],
  
  // Workflow-level callbacks
  onComplete: async (runId, finalState) => {
    console.log(`Photo workflow ${runId} completed`);
    console.log(`Final state:`, finalState);
  },
  
  onFailed: async (runId, state, error) => {
    console.error(`Photo workflow ${runId} failed at state:`, state);
    await notifyUserOfFailure(state.moveId);
  },
  
  onCancelled: async (runId, state) => {
    console.log(`Photo workflow ${runId} was cancelled`);
    await cleanupPartialUpload(state);
  },
});
```

### Public Export

```typescript
// === workflows/photo/index.ts ===
export { photoWorkflow } from './workflow';
export * from './activities';  // If activities need to be used elsewhere
```

---

## Data Models

### WorkflowExecution Schema

```typescript
interface WorkflowExecution {
  // Identity
  runId: string;                    // UUID, primary key
  workflowName: string;             // References workflow definition
  uniqueKey?: string;               // Optional deduplication key
  
  // Progress tracking
  currentActivityIndex: number;     // Position in activity sequence (0-based)
  currentActivityName: string;      // Name of current/next activity
  status: WorkflowExecutionStatus;  // running | completed | failed | cancelled
  
  // State management
  input: object;                    // Original input when workflow started
  state: object;                    // Accumulated state (input + activity returns)
  
  // Timestamps
  createdAt: number;                // Unix timestamp ms
  updatedAt: number;                // Last modification
  completedAt?: number;             // When workflow finished
  
  // Error tracking
  error?: string;                   // Error message if failed
  failedActivityName?: string;      // Which activity caused failure
}

type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
```

### ActivityTask Schema

```typescript
interface ActivityTask {
  // Identity
  taskId: string;                   // UUID, primary key
  runId: string;                    // Foreign key to WorkflowExecution
  activityName: string;             // Matches Activity name
  
  // Execution state
  status: ActivityTaskStatus;       // pending | active | completed | failed | skipped
  priority: number;                 // Higher = processed first
  
  // Retry management
  attempts: number;                 // Current attempt count
  maxAttempts: number;              // Max before marking failed
  timeout: number;                  // Ms before task times out (0 = no timeout)
  
  // Data
  input: object;                    // Input for this activity execution
  result?: object;                  // Output from activity (merged into workflow state)
  
  // Timestamps
  createdAt: number;
  scheduledFor?: number;            // Don't run before this time (for backoff)
  startedAt?: number;               // When current attempt began
  lastAttemptAt?: number;           // When last attempt finished
  completedAt?: number;
  
  // Error tracking
  error?: string;                   // Last error message
  errorStack?: string;              // Last error stack trace
}

type ActivityTaskStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
```

### Dead Letter Record Schema

```typescript
interface DeadLetterRecord {
  id: string;                       // UUID
  runId: string;                    // Original workflow execution
  taskId: string;                   // Failed activity task
  activityName: string;
  workflowName: string;
  input: object;                    // Activity input at time of failure
  error: string;                    // Final error message
  errorStack?: string;
  attempts: number;                 // How many attempts were made
  failedAt: number;                 // Timestamp of final failure
  acknowledged: boolean;            // Has this been reviewed/handled?
}
```

### Storage Key Structure (for KV stores like MMKV)

```
// Workflow executions
executions:{runId}                      → WorkflowExecution object

// Uniqueness index
unique:{workflowName}:{uniqueKey}       → runId (for deduplication)

// Activity tasks
tasks:{taskId}                          → ActivityTask object

// Indexes for efficient queries
index:executions:status:{status}        → [runId1, runId2, ...]
index:tasks:status:pending              → [taskId1, taskId2, ...] (sorted by priority)
index:tasks:status:active               → [taskId1, taskId2, ...]
index:tasks:execution:{runId}           → [taskId1, taskId2, ...]

// Dead letter queue
deadletter:{id}                         → DeadLetterRecord
index:deadletter:unacked                → [id1, id2, ...]

// Metadata
meta:stats                              → { totalExecutions, completed, failed, ... }
```

---

## API Design

### WorkflowEngine API

```typescript
import { WorkflowEngine, MMKVStorageAdapter } from 'react-native-workflow';

// Initialize the engine
const engine = await WorkflowEngine.create({
  storage: new MMKVStorageAdapter(),
  
  // Runtime context provider (called for each activity)
  runtimeContext: () => ({
    isConnected: getNetworkState(),
    batteryLevel: getBatteryLevel(),
    // Add app-specific context values
  }),
  
  // Optional event handlers
  onExecutionStateChanged?: (execution: WorkflowExecution) => void,
  onActivityTaskStateChanged?: (task: ActivityTask) => void,
});

// Register workflows (typically at app startup)
engine.registerWorkflow(photoWorkflow);
engine.registerWorkflow(driverStatusSyncWorkflow);
engine.registerWorkflow(moveStatusSyncWorkflow);

// Start a workflow execution
const execution = await engine.start(photoWorkflow, {
  input: { moveId: 123, uri: 'file://photo.jpg' },
});
console.log(execution.runId);

// Start with uniqueness constraint (deduplication)
const execution = await engine.start(driverStatusSyncWorkflow, {
  input: { driverId: 456 },
  uniqueKey: `driver-sync:${driverId}`,
});

// Handle uniqueness conflicts
try {
  await engine.start(driverStatusSyncWorkflow, {
    input: { driverId: 456 },
    uniqueKey: `driver-sync:${driverId}`,
  });
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.log('Sync already in progress:', err.existingRunId);
  }
}

// Or ignore conflicts (return existing execution)
const execution = await engine.start(driverStatusSyncWorkflow, {
  input: { driverId: 456 },
  uniqueKey: `driver-sync:${driverId}`,
  onConflict: 'ignore',  // Returns existing execution instead of throwing
});

// Query executions
const execution = await engine.getExecution(runId);
const executions = await engine.getExecutionsByStatus('running');

// Control execution
await engine.cancelExecution(runId);
await engine.retryExecution(runId);  // Retry from failed activity

// Engine control
engine.start();                      // Begin processing activities
engine.start({ lifespan: 25000 });   // Process for max 25 seconds (background mode)
engine.stop();                       // Pause processing

// Dead letter queue
const deadLetters = await engine.getDeadLetters();
const unacked = await engine.getUnacknowledgedDeadLetters();
await engine.acknowledgeDeadLetter(id);
await engine.purgeDeadLetters({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
```

### Workflow Definition API

```typescript
import { defineWorkflow } from 'react-native-workflow';

export const photoWorkflow = defineWorkflow<PhotoWorkflowInput>({
  name: 'photo',
  
  activities: [capturePhoto, uploadPhoto, notifyServer],
  
  onComplete: async (runId, finalState) => {
    console.log(`Workflow ${runId} completed with state:`, finalState);
  },
  
  onFailed: async (runId, state, error) => {
    console.error(`Workflow ${runId} failed:`, error.message);
  },
  
  onCancelled: async (runId, state) => {
    console.log(`Workflow ${runId} cancelled`);
  },
});

// Type for input validation
interface PhotoWorkflowInput {
  moveId: number;
  uri: string;
  workflowType?: string;
}
```

### Activity Definition API

```typescript
import { defineActivity } from 'react-native-workflow';

export const uploadPhoto = defineActivity<UploadInput, UploadOutput>({
  name: 'uploadPhoto',
  
  execute: async (ctx) => {
    const { uri, hash } = ctx.input;
    const response = await uploadToS3(uri, { signal: ctx.signal });
    return { s3Key: response.key, uploadedAt: Date.now() };
  },
  
  options: {
    // Timeouts
    startToCloseTimeout: 60000,     // Max time for activity to complete
    
    // Retry policy
    retry: {
      maximumAttempts: 10,
      initialInterval: 5000,        // First retry after 5s
      backoffCoefficient: 2,        // Double each time
      maximumInterval: 60000,       // Cap at 60s
    },
    
    // Execution priority (higher = first)
    priority: 50,
    
    // Conditional execution
    runWhen: conditions.whenConnected,
    
    // Lifecycle callbacks
    onStart: async (taskId, input) => { },
    onSuccess: async (taskId, input, result) => { },
    onFailure: async (taskId, input, error, attempt) => { },
    onFailed: async (taskId, input, error) => { },
    onSkipped: async (taskId, input, reason) => { },
  },
});

interface UploadInput {
  uri: string;
  hash: string;
}

interface UploadOutput {
  s3Key: string;
  uploadedAt: number;
}
```

### Activity Execution Context

```typescript
interface ActivityContext<TInput = any> {
  // Identity
  runId: string;                    // Workflow execution ID
  taskId: string;                   // This activity task's ID
  attempt: number;                  // Current attempt number (1-based)
  
  // Data
  input: TInput;                    // Accumulated workflow state
  
  // Cancellation
  signal: AbortSignal;              // Fires on cancel or timeout
  
  // Runtime context (from engine configuration)
  isConnected: boolean;
  batteryLevel?: number;
  [key: string]: any;               // App-specific values
  
  // Utilities
  log: (...args: any[]) => void;    // Contextual logging
}
```

---

## Activity Configuration

### ActivityOptions Reference

```typescript
interface ActivityOptions {
  // === TIMEOUTS ===
  
  startToCloseTimeout?: number;     // Ms before activity times out (default: 25000)
  
  // === RETRY POLICY ===
  
  retry?: {
    maximumAttempts?: number;       // Max attempts before failing (default: 1)
    initialInterval?: number;       // First retry delay in ms (default: 1000)
    backoffCoefficient?: number;    // Multiplier for each retry (default: 2)
    maximumInterval?: number;       // Cap on retry delay (default: none)
  };
  
  // === PRIORITY ===
  
  priority?: number;                // Higher = processed first (default: 0)
  
  // === CONDITIONAL EXECUTION ===
  
  runWhen?: RunCondition | ((ctx: RuntimeContext) => RunConditionResult);
  
  // === LIFECYCLE CALLBACKS ===
  
  onStart?: (taskId: string, input: object) => Promise<void>;
  onSuccess?: (taskId: string, input: object, result: object) => Promise<void>;
  onFailure?: (taskId: string, input: object, error: Error, attempt: number) => Promise<void>;
  onFailed?: (taskId: string, input: object, error: Error) => Promise<void>;
  onSkipped?: (taskId: string, input: object, reason: string) => Promise<void>;
}

interface RunConditionResult {
  ready: boolean;
  reason?: string;                  // Passed to onSkipped if not ready
  retryInMs?: number;               // Hint for when to check again
}
```

### Built-in Conditions

```typescript
import { conditions } from 'react-native-workflow';

// Simple conditions
conditions.always                   // Always ready (default)
conditions.whenConnected            // Ready when ctx.isConnected === true
conditions.whenDisconnected         // Ready when offline (for offline-only work)

// Time-based
conditions.afterDelay(ms)           // Ready after activity pending for N ms

// Combinators
conditions.all(cond1, cond2)        // Ready when ALL conditions are ready
conditions.any(cond1, cond2)        // Ready when ANY condition is ready
conditions.not(cond)                // Inverts a condition

// Usage examples
options: {
  // Built-in
  runWhen: conditions.whenConnected,
  
  // Combined
  runWhen: conditions.all(
    conditions.whenConnected,
    conditions.afterDelay(5000)
  ),
  
  // Custom function
  runWhen: (ctx) => ({
    ready: ctx.isConnected && ctx.input.priority > 5,
    reason: 'Waiting for network and sufficient priority',
  }),
}
```

### Common Configuration Patterns

#### Network-Dependent Activity

```typescript
defineActivity({
  name: 'syncToServer',
  execute: async (ctx) => { /* ... */ },
  options: {
    startToCloseTimeout: 30000,
    retry: {
      maximumAttempts: 10,
      initialInterval: 5000,
      backoffCoefficient: 2,
      maximumInterval: 60000,
    },
    runWhen: conditions.whenConnected,
  },
});
```

#### Time-Delayed Activity

```typescript
defineActivity({
  name: 'delayedCleanup',
  execute: async (ctx) => { /* ... */ },
  options: {
    runWhen: conditions.afterDelay(30000),  // Wait 30 seconds
  },
});
```

#### Custom Conditional Logic

```typescript
defineActivity({
  name: 'batteryAwareSync',
  execute: async (ctx) => { /* ... */ },
  options: {
    runWhen: (ctx) => {
      if (!ctx.isConnected) {
        return { ready: false, reason: 'No network' };
      }
      if (ctx.batteryLevel < 0.2 && !ctx.input.urgent) {
        return { ready: false, reason: 'Battery low, deferring non-urgent work' };
      }
      return { ready: true };
    },
  },
});
```

---

## State Threading

Activities receive accumulated state and return additions to it.

### How State Flows

```typescript
// Starting workflow
await engine.start(photoWorkflow, {
  input: { moveId: 123, uri: 'file://photo.jpg' },
});

// Initial state = input
// { moveId: 123, uri: 'file://photo.jpg' }
```

```typescript
// Activity 1: capturePhoto
execute: async (ctx) => {
  const { uri } = ctx.input;  // { moveId: 123, uri: '...' }
  const hash = await generateHash(uri);
  return { hash };  // Added to state
}

// State after: { moveId: 123, uri: '...', hash: 'abc123' }
```

```typescript
// Activity 2: uploadPhoto
execute: async (ctx) => {
  const { uri, hash } = ctx.input;  // { moveId: 123, uri: '...', hash: 'abc123' }
  const s3Key = await upload(uri);
  return { s3Key, uploadedAt: Date.now() };  // Added to state
}

// State after: { moveId: 123, uri: '...', hash: 'abc123', s3Key: '...', uploadedAt: ... }
```

```typescript
// Activity 3: notifyServer
execute: async (ctx) => {
  const { moveId, s3Key } = ctx.input;  // Full accumulated state
  await api.post(`/moves/${moveId}/photos`, { s3Key });
  // No return - nothing to add
}

// Final state: { moveId: 123, uri: '...', hash: 'abc123', s3Key: '...', uploadedAt: ... }
```

### State Merge Behavior

- Activity return values are **shallow merged** into state
- Return `undefined` or nothing to add nothing
- Later activities can overwrite earlier values (same key)
- Original input is preserved in `execution.input`
- Accumulated state lives in `execution.state`

---

## Execution Semantics

### Activity Task Lifecycle

```
                    ┌──────────────────────────────────────┐
                    │          (retry backoff)             │
                    ▼                                      │
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│ PENDING │───▶│ ACTIVE  │───▶│COMPLETED│    │ FAILED  │  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘  │
     │              │                             ▲       │
     │              │         ┌─────────┐         │       │
     │              └────────▶│ SKIPPED │─────────┼───────┘
     │            (runWhen    └─────────┘   (retry later)
     │             false)          │
     │                             │
     │                             ▼
     │                    (max skips exceeded)
     │                             │
     └─────────────────────────────┼───────────────────────┐
                                   │                       │
                                   ▼                       ▼
                             ┌─────────┐             ┌─────────┐
                             │ FAILED  │             │CANCELLED│
                             └─────────┘             └─────────┘
```

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| PENDING | ACTIVE | Activity claimed by executor |
| PENDING | SKIPPED | `runWhen` returned false |
| PENDING | CANCELLED | Workflow cancelled |
| ACTIVE | COMPLETED | `execute()` returned successfully |
| ACTIVE | PENDING | `execute()` threw error, retries remaining |
| ACTIVE | FAILED | `execute()` threw error, no retries remaining |
| ACTIVE | FAILED | Timeout exceeded |
| ACTIVE | CANCELLED | Workflow cancelled (signal aborted) |
| SKIPPED | PENDING | Retry timer elapsed |
| SKIPPED | FAILED | Max skip attempts exceeded |

### Workflow Execution Lifecycle

```
┌─────────┐    ┌─────────┐
│ RUNNING │───▶│COMPLETED│
└─────────┘    └─────────┘
     │
     │         ┌───────────┐
     ├────────▶│ CANCELLED │
     │         └───────────┘
     │
     │         ┌───────────┐
     └────────▶│  FAILED   │
               └───────────┘
```

### Activity Advancement Logic

When an activity completes successfully, the engine automatically advances:

```typescript
async function onActivityCompleted(task: ActivityTask, result: object) {
  const execution = await storage.getExecution(task.runId);
  const workflow = workflowRegistry.get(execution.workflowName);
  
  // Merge activity result into workflow state
  const newState = { ...execution.state, ...result };
  
  // Check if this was the last activity
  const nextIndex = execution.currentActivityIndex + 1;
  const isComplete = nextIndex >= workflow.activities.length;
  
  if (isComplete) {
    // Mark workflow as completed
    await storage.saveExecution({
      ...execution,
      state: newState,
      status: 'completed',
      completedAt: Date.now(),
    });
    
    // Release uniqueness constraint
    if (execution.uniqueKey) {
      await storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
    }
    
    // Invoke completion callback
    await workflow.onComplete?.(execution.runId, newState);
  } else {
    // Schedule next activity
    const nextActivity = workflow.activities[nextIndex];
    
    await storage.saveExecution({
      ...execution,
      state: newState,
      currentActivityIndex: nextIndex,
      currentActivityName: nextActivity.name,
    });
    
    await scheduleActivityTask({
      runId: execution.runId,
      activityName: nextActivity.name,
      input: newState,
      options: nextActivity.options,
    });
  }
}
```

---

## Cancellation

### Cancelling a Workflow

```typescript
await engine.cancelExecution(runId);
```

This triggers:

1. **WorkflowExecution** status set to `cancelled`
2. **Active activities** receive abort signal, status set to `cancelled`
3. **Pending activities** for this execution are removed
4. **Uniqueness key** (if any) is released
5. **onCancelled** callback invoked

### Handling Cancellation in Activities

The `signal` in ActivityContext is an `AbortSignal` that fires when the workflow is cancelled or the activity times out:

```typescript
execute: async (ctx) => {
  const { signal, input } = ctx;
  
  // Option 1: Pass signal to fetch (automatic abort)
  const response = await fetch(url, { signal });
  
  // Option 2: Check signal manually for long operations
  for (const item of input.items) {
    if (signal.aborted) {
      throw new Error('Activity cancelled');
    }
    await processItem(item);
  }
  
  // Option 3: Listen for abort event
  signal.addEventListener('abort', () => {
    cleanup();
  });
}
```

### Cancellation Guarantees

- **Best-effort**: If an activity is mid-execution, it may complete before seeing the abort signal
- **No rollback**: Completed activities are not undone; design activities to be idempotent
- **Immediate for pending**: Pending activities are removed without execution

---

## Dead Letter Queue

When an activity permanently fails (exhausts all retries), it's moved to the dead letter queue for inspection and potential manual intervention.

### Automatic Dead Letter Handling

```typescript
async function onActivityPermanentlyFailed(task: ActivityTask, error: Error) {
  const execution = await storage.getExecution(task.runId);
  const workflow = workflowRegistry.get(execution.workflowName);
  
  // Move to dead letter queue
  await storage.saveDeadLetter({
    id: generateId(),
    runId: task.runId,
    taskId: task.taskId,
    activityName: task.activityName,
    workflowName: execution.workflowName,
    input: task.input,
    error: error.message,
    errorStack: error.stack,
    attempts: task.attempts,
    failedAt: Date.now(),
    acknowledged: false,
  });
  
  // Mark workflow as failed
  await storage.saveExecution({
    ...execution,
    status: 'failed',
    error: error.message,
    failedActivityName: task.activityName,
  });
  
  // Release uniqueness constraint
  if (execution.uniqueKey) {
    await storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
  }
  
  // Invoke failure callback
  await workflow.onFailed?.(execution.runId, execution.state, error);
}
```

### Dead Letter API

```typescript
// Get all dead letters
const deadLetters = await engine.getDeadLetters();

// Get unacknowledged dead letters (not yet reviewed)
const unacked = await engine.getUnacknowledgedDeadLetters();

// Acknowledge after reviewing/handling
await engine.acknowledgeDeadLetter(id);

// Purge old acknowledged dead letters
await engine.purgeDeadLetters({ 
  olderThanMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
  acknowledgedOnly: true,
});
```

### Cleanup / Garbage Collection

Configure automatic cleanup:

```typescript
const engine = await WorkflowEngine.create({
  storage: new MMKVStorageAdapter(),
  
  cleanup: {
    // Run cleanup on engine start
    onStart: true,
    
    // Purge completed executions older than 24 hours
    completedExecutionRetention: 24 * 60 * 60 * 1000,
    
    // Purge acknowledged dead letters older than 7 days
    deadLetterRetention: 7 * 24 * 60 * 60 * 1000,
    
    // Optional callbacks
    onExecutionPurged: async (execution) => {
      console.log(`Purged execution ${execution.runId}`);
    },
    onDeadLetterPurged: async (record) => {
      console.log(`Purged dead letter ${record.id}`);
    },
  },
});
```

---

## Storage Backend

### Storage Adapter Interface

```typescript
interface StorageAdapter {
  // Workflow Executions
  saveExecution(execution: WorkflowExecution): Promise<void>;
  getExecution(runId: string): Promise<WorkflowExecution | null>;
  getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]>;
  deleteExecution(runId: string): Promise<void>;
  
  // Uniqueness
  setUniqueKey(workflowName: string, key: string, runId: string): Promise<boolean>;
  getUniqueKey(workflowName: string, key: string): Promise<string | null>;
  deleteUniqueKey(workflowName: string, key: string): Promise<void>;
  
  // Activity Tasks
  saveActivityTask(task: ActivityTask): Promise<void>;
  getActivityTask(taskId: string): Promise<ActivityTask | null>;
  getActivityTasksForExecution(runId: string): Promise<ActivityTask[]>;
  getActivityTasksByStatus(status: ActivityTaskStatus): Promise<ActivityTask[]>;
  deleteActivityTask(taskId: string): Promise<void>;
  
  // Queue Operations
  getPendingActivityTasks(options?: { limit?: number }): Promise<ActivityTask[]>;
  claimActivityTask(taskId: string): Promise<ActivityTask | null>;
  
  // Dead Letter Queue
  saveDeadLetter(record: DeadLetterRecord): Promise<void>;
  getDeadLetters(): Promise<DeadLetterRecord[]>;
  getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]>;
  acknowledgeDeadLetter(id: string): Promise<void>;
  deleteDeadLetter(id: string): Promise<void>;
  
  // Maintenance
  purgeExecutions(options: { olderThanMs: number; status: WorkflowExecutionStatus[] }): Promise<number>;
  purgeDeadLetters(options: { olderThanMs: number; acknowledgedOnly?: boolean }): Promise<number>;
  
  // Reactivity (optional)
  subscribe?(callback: (change: StorageChange) => void): () => void;
}
```

### MMKV Implementation Sketch

```typescript
class MMKVStorageAdapter implements StorageAdapter {
  private storage: MMKV;
  
  constructor(options?: { id?: string }) {
    this.storage = new MMKV({ id: options?.id ?? 'workflow-engine' });
  }
  
  async setUniqueKey(workflowName: string, key: string, runId: string): Promise<boolean> {
    const storageKey = `unique:${workflowName}:${key}`;
    const existing = this.storage.getString(storageKey);
    
    if (existing) {
      // Check if the existing execution is still active
      const execution = await this.getExecution(existing);
      if (execution && execution.status === 'running') {
        return false;  // Constraint violation
      }
      // Old execution is done, we can reuse the key
    }
    
    this.storage.set(storageKey, runId);
    return true;
  }
  
  async getPendingActivityTasks(options?: { limit?: number }): Promise<ActivityTask[]> {
    const taskIds = this.getIndex('index:tasks:status:pending');
    const now = Date.now();
    
    const tasks = taskIds
      .map(id => JSON.parse(this.storage.getString(`tasks:${id}`) ?? 'null'))
      .filter(task => {
        if (!task) return false;
        // Respect scheduledFor (backoff delay)
        if (task.scheduledFor && task.scheduledFor > now) return false;
        return true;
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, options?.limit ?? 100);
    
    return tasks;
  }
  
  async claimActivityTask(taskId: string): Promise<ActivityTask | null> {
    const task = await this.getActivityTask(taskId);
    if (!task || task.status !== 'pending') return null;
    
    task.status = 'active';
    task.startedAt = Date.now();
    task.attempts += 1;
    await this.saveActivityTask(task);
    
    return task;
  }
  
  // ... other methods
}
```

### Storage Backend Comparison

| Feature | MMKV | SQLite | Realm |
|---------|------|--------|-------|
| Setup complexity | Low | Medium | High |
| Query flexibility | Low (manual indexes) | High (SQL) | Medium |
| Reactivity | Built-in hooks | Manual | Built-in |
| Atomic transactions | No | Yes | Yes |
| Performance (simple ops) | Excellent | Good | Good |
| Performance (complex queries) | Poor | Excellent | Good |
| Bundle size impact | Small | Medium | Large |
| Maintenance status | Active | Active | Uncertain |

### Recommendation

**Start with MMKV** for most use cases:
- Simplest setup and maintenance
- Excellent React hooks integration (`useMMKVObject`, etc.)
- Sufficient for < 1000 pending activities
- Smallest bundle size

**Consider SQLite** if you need:
- Complex queries
- Larger queue sizes (> 5000 activities)
- Strong consistency guarantees

---

## Background Processing

### Integration with OS Background Systems

```typescript
// background.ts
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

const BACKGROUND_TASK_NAME = 'WORKFLOW_ENGINE_BACKGROUND';

// Define the background task
TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  console.log('Background task starting...');
  
  try {
    // Create engine instance for background context
    const engine = await WorkflowEngine.create({
      storage: new MMKVStorageAdapter(),
      runtimeContext: () => ({
        isConnected: getNetworkState(),
      }),
    });
    
    // Re-register all workflows (required in background context)
    engine.registerWorkflow(photoWorkflow);
    engine.registerWorkflow(driverStatusSyncWorkflow);
    // ... all workflows
    
    // Process for limited time (iOS/Android limit ~30s)
    await engine.start({ lifespan: 25000 });
    
    console.log('Background task completed');
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (error) {
    console.error('Background task failed:', error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// Register for periodic execution
export async function registerBackgroundProcessing() {
  await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK_NAME, {
    minimumInterval: 60 * 15,       // Every 15 minutes
    stopOnTerminate: false,         // Keep running after app termination (Android)
    startOnBoot: true,              // Start on device boot (Android)
  });
}
```

### Lifespan-Aware Execution

```typescript
class ActivityExecutor {
  async start(options?: { lifespan?: number }): Promise<void> {
    const deadline = options?.lifespan ? Date.now() + options.lifespan : null;
    const safetyBuffer = 500; // Stop 500ms before deadline
    
    this.isRunning = true;
    
    while (this.isRunning) {
      // Check deadline
      if (deadline && Date.now() >= deadline - safetyBuffer) {
        console.log('Approaching deadline, stopping gracefully');
        break;
      }
      
      const task = await this.getNextTask();
      if (!task) {
        await this.sleep(100);
        continue;
      }
      
      // Only start task if we have time to complete it
      if (deadline && task.timeout) {
        const remainingTime = deadline - Date.now() - safetyBuffer;
        if (task.timeout > remainingTime) {
          console.log(`Skipping task ${task.taskId}: needs ${task.timeout}ms, only ${remainingTime}ms remaining`);
          continue;
        }
      }
      
      await this.executeTask(task);
    }
  }
}
```

---

## Observability

### React Hooks for UI Integration

```typescript
import { useExecution, useExecutionStats, usePendingActivities, useDeadLetters } from 'react-native-workflow';

// Subscribe to a specific workflow execution
function useExecution(runId: string): WorkflowExecution | null {
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  
  useEffect(() => {
    engine.getExecution(runId).then(setExecution);
    return engine.subscribeToExecution(runId, setExecution);
  }, [runId]);
  
  return execution;
}

// Aggregate statistics
function useExecutionStats(): ExecutionStats {
  const [stats] = useMMKVObject<ExecutionStats>('workflow:stats');
  return stats ?? { pending: 0, running: 0, completed: 0, failed: 0 };
}

// Pending activities (for debugging UI)
function usePendingActivities(): ActivityTask[] {
  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  
  useEffect(() => {
    const refresh = () => engine.getPendingActivities().then(setTasks);
    refresh();
    return engine.onActivityTaskStateChanged(refresh);
  }, []);
  
  return tasks;
}

// Monitor failures
function useDeadLetters(): DeadLetterRecord[] {
  const [records, setRecords] = useState<DeadLetterRecord[]>([]);
  
  useEffect(() => {
    engine.getUnacknowledgedDeadLetters().then(setRecords);
    return engine.onDeadLetterAdded(() => {
      engine.getUnacknowledgedDeadLetters().then(setRecords);
    });
  }, []);
  
  return records;
}
```

### Example: Workflow Progress Component

```tsx
function WorkflowProgress({ runId }: { runId: string }) {
  const execution = useExecution(runId);
  
  if (!execution) return <Text>Loading...</Text>;
  
  const workflow = workflowRegistry.get(execution.workflowName);
  const totalActivities = workflow.activities.length;
  const currentIndex = execution.currentActivityIndex;
  
  return (
    <View>
      <Text>{execution.workflowName}</Text>
      <Text>Status: {execution.status}</Text>
      <Text>Progress: {currentIndex + 1} / {totalActivities}</Text>
      <Text>Current: {execution.currentActivityName}</Text>
      <ProgressBar value={(currentIndex + 1) / totalActivities} />
      
      {execution.status === 'failed' && (
        <Text style={{ color: 'red' }}>
          Failed at: {execution.failedActivityName}
          Error: {execution.error}
        </Text>
      )}
    </View>
  );
}
```

### Logging Configuration

```typescript
const engine = await WorkflowEngine.create({
  storage: new MMKVStorageAdapter(),
  
  logger: {
    debug: (msg, meta) => console.debug(`[Workflow] ${msg}`, meta),
    info: (msg, meta) => console.info(`[Workflow] ${msg}`, meta),
    warn: (msg, meta) => console.warn(`[Workflow] ${msg}`, meta),
    error: (msg, meta) => console.error(`[Workflow] ${msg}`, meta),
  },
  
  onEvent: (event) => {
    // Send to analytics, crash reporting, etc.
    switch (event.type) {
      case 'execution:started':
      case 'execution:completed':
      case 'execution:failed':
      case 'activity:started':
      case 'activity:completed':
      case 'activity:failed':
        analytics.track(event.type, event);
        break;
    }
  },
});
```

---

## Migration Path

### From Current System (HopDrive react-native-queue fork)

#### Terminology Mapping

| Current | New |
|---------|-----|
| Pipeline | Workflow |
| Event | WorkflowExecution |
| eventId | runId |
| Job | ActivityTask (internal) |
| Worker (function) | Activity |
| Worker options | ActivityOptions |
| completeStage() | *(automatic)* |

#### Phase 1: Parallel Implementation

1. Build new workflow engine alongside existing queue
2. Add feature flag to route new workflows to new system
3. Keep existing pipelines on old system

```typescript
if (featureFlags.useNewWorkflowEngine) {
  await engine.start(photoWorkflow, { input: payload });
} else {
  await startPhotoPipeline({ payload });
}
```

#### Phase 2: Migrate Workflow Definitions

```typescript
// Before: Pipeline + Workers
export const name = 'photo.pipeline';
export const sequence = [PhotoCapture, PhotoPending, PhotoUpload, PhotoSave];

// PhotoCapture.worker.ts
export const worker = async (id, payload) => {
  const { eventId, uri } = payload;
  const hash = await generateHash(uri);
  await EventUtils.completeStage(pipeline, eventId, { hash });
};

// After: Workflow + Activities
export const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, pendingPhoto, uploadPhoto, savePhoto],
});

// capturePhoto.ts
export const capturePhoto = defineActivity({
  name: 'capturePhoto',
  execute: async (ctx) => {
    const { uri } = ctx.input;
    const hash = await generateHash(uri);
    return { hash };  // Automatic advancement, no completeStage()
  },
});
```

#### Phase 3: Data Migration

```typescript
async function migrateInFlightEvents() {
  const events = await realm.objects('Event').filtered('syncStatus != "synced"');
  
  for (const event of events) {
    const execution: WorkflowExecution = {
      runId: event.eventId,
      workflowName: event.type,
      currentActivityIndex: getActivityIndex(event.stage),
      currentActivityName: event.stageName,
      status: mapStatus(event.syncStatus),
      input: event.payload,
      state: event.payload,
      createdAt: event.createdAt.getTime(),
      updatedAt: event.updatedAt.getTime(),
    };
    
    await newStorage.saveExecution(execution);
  }
}
```

#### Phase 4: Deprecation

1. Remove feature flags
2. Remove old queue library dependency
3. Clean up compatibility layers

---

## Open Questions

### Architecture Decisions Needed

1. **Activity Dependencies / Parallel Execution**
   - Current design is strictly sequential—is that sufficient?
   - Would parallel activity execution add value? (e.g., upload multiple photos simultaneously)
   - If yes, how to define? DAG? Explicit parallel groups?

2. **Error Boundaries**
   - How to handle errors in lifecycle callbacks (onComplete, onFailed)?
   - Should callback failures affect execution status?

3. **Storage Atomicity**
   - MMKV lacks transactions—how critical is this in practice?
   - Should we implement write-ahead logging for multi-key operations?

4. **Testing Strategy**
   - How to test workflows without actual activity execution?
   - Mock storage adapter? Activity injection?

---

## Future Considerations

### Metadata Indexing

Current implementation only retrieves WorkflowExecutions by `runId`. If querying by business entity becomes necessary (e.g., "all executions for moveId 123"), we'd need:

```typescript
// Additional indexes
index:executions:meta:moveId:{id} → [runId1, runId2, ...]

// API addition
const executions = await engine.getExecutionsByMetadata({ moveId: 123 });
```

Not implementing now since current driver app doesn't use this pattern.

### Scheduled / Cron Workflows

Temporal supports cron-scheduled workflows. This could be useful for:
- Periodic cleanup tasks
- Scheduled sync operations
- Retry batches at specific times

```typescript
// Possible future API
await engine.schedule(cleanupWorkflow, {
  cron: '0 3 * * *',  // Daily at 3am
  input: { maxAge: 7 * 24 * 60 * 60 * 1000 },
});
```

**Recommendation**: Keep this out of v1 and use OS-level schedulers (AlarmManager, BGTaskScheduler) to trigger workflows instead.

### Saga Pattern / Compensation

For workflows where failed activities need to "undo" previous activities:

```typescript
const paymentWorkflow = defineWorkflow({
  name: 'payment',
  activities: [
    { activity: reserveInventory, compensate: releaseInventory },
    { activity: chargeCard, compensate: refundCard },
    { activity: sendConfirmation },  // No compensation needed
  ],
});
```

If chargeCard fails permanently, the engine would run releaseInventory.

**Not recommended for v1**—adds significant complexity and most mobile workflows don't need it.

### True Background Threading

React Native's new architecture and libraries like `react-native-worklets-core` may enable running activities on separate threads. This would be valuable for CPU-intensive activities.

```typescript
// Possible future API
defineActivity({
  name: 'processImage',
  execute: async (ctx) => { /* heavy computation */ },
  options: {
    runOnThread: true,  // Execute on background thread
  },
});
```

Current activities are mostly I/O-bound (network, storage), where async concurrency is sufficient. Revisit if CPU-bound activities become common.

---

## References

- [Temporal Documentation](https://docs.temporal.io/) - Conceptual model reference
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) - API patterns
- [AWS Step Functions](https://docs.aws.amazon.com/step-functions/) - State machine patterns
- [Saga Pattern](https://microservices.io/patterns/data/saga.html) - Distributed transaction handling

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | Draft | Initial design document |
| 0.2.0 | Draft | Added Design Philosophy, Cancellation, Dead Letter Queue |
| 0.3.0 | Draft | Aligned terminology with Temporal (Activity, WorkflowExecution); added file organization patterns; state threading; runtime context extensibility; built-in conditions |
