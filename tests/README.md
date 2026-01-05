# Test Suite Documentation

This document describes the test organization for endura.

## Test Structure

```
tests/
├── integration/          # End-to-end workflow scenarios
│   ├── PhotoWorkflow.test.ts      # Photo capture/upload workflow
│   ├── MultiWorkflow.test.ts      # Multiple workflow types
│   ├── CrashRecovery.test.ts      # Crash/restart recovery
│   └── BackgroundProcessing.test.ts # Background scheduling
├── utils/
│   └── testHelpers.ts    # Shared test utilities
└── README.md             # This file

src/core/engine/          # Unit tests (colocated with source)
├── WorkflowEngine.test.ts           # Core operations
├── WorkflowEngine.lifecycle.test.ts # Task lifecycle
├── WorkflowEngine.retry.test.ts     # Retries/backoff
├── WorkflowEngine.gating.test.ts    # runWhen conditions
├── WorkflowEngine.dlq.test.ts       # Dead letter queue
├── WorkflowEngine.cancellation.test.ts # Cancellation
├── WorkflowEngine.timeout.test.ts   # Timeouts
├── WorkflowEngine.callbacks.test.ts # Lifecycle callbacks
├── WorkflowEngine.concurrency.test.ts # Race conditions
├── WorkflowEngine.validation.test.ts # Input validation
└── WorkflowEngine.state.test.ts     # State threading

src/adapters/expo/
├── hooks.test.tsx        # React hooks tests
└── storage/
    └── SQLiteStorage.test.ts # SQLite storage tests
```

## Running Tests

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run specific test file
npx vitest run path/to/test.ts
```

## Test Categories

### Unit Tests (`src/core/engine/`)

Unit tests focus on individual engine features in isolation. They use mock
dependencies and directly test the WorkflowEngine class.

Each file tests a specific aspect:
- **Core Operations**: Registration, starting, basic execution
- **Lifecycle**: Task state transitions, restart recovery
- **Retries**: Automatic retry with exponential backoff
- **Gating**: runWhen conditions (network, battery, custom)
- **DLQ**: Dead letter queue for failed activities
- **Cancellation**: Workflow cancellation propagation
- **Timeouts**: Activity timeout enforcement
- **Callbacks**: Lifecycle hooks (onSuccess, onComplete, etc.)
- **Concurrency**: Thread safety under parallel operations
- **Validation**: Input validation and error messages
- **State**: State threading through activities

### Integration Tests (`tests/integration/`)

Integration tests verify complete workflow scenarios that exercise multiple
engine features together.

- **PhotoWorkflow**: Real-world photo upload workflow with network gating
- **MultiWorkflow**: Running different workflow types concurrently
- **CrashRecovery**: Recovery after simulated app crashes
- **BackgroundProcessing**: Scheduled tasks and long-running workflows

### React Hooks Tests (`src/adapters/expo/hooks.test.tsx`)

Tests for React integration hooks using jsdom environment:
- `useExecution` - Subscribe to execution state
- `useExecutionsByStatus` - Query executions by status
- `useDeadLetters` - Monitor dead letter queue
- `usePendingActivityCount` - Count pending activities
- `useExecutionStats` - Aggregate execution statistics
- `useWorkflowStarter` - Start workflows from React components

## Test Utilities

### TestContext

The `TestContext` interface bundles all test dependencies:

```typescript
interface TestContext {
  storage: InMemoryStorage;
  clock: MockClock;
  scheduler: MockScheduler;
  environment: MockEnvironment;
  engine: WorkflowEngine;
}
```

### createTestContext()

Creates an isolated test environment:

```typescript
const ctx = await createTestContext({
  isConnected: false,  // Start offline
  batteryLevel: 0.5,   // 50% battery
});

const execution = await ctx.engine.start(workflow, { input: {} });
await ctx.engine.tick();
```

### runToCompletion()

Runs the engine until a workflow completes:

```typescript
const result = await runToCompletion(ctx, execution.runId, {
  timeout: 5000,      // Max wait time
  advanceClock: true, // Auto-advance mock clock for gated activities
});
expect(result.status).toBe('completed');
```

### createTestActivity()

Creates activities with configurable behavior:

```typescript
// Activity that fails twice then succeeds
const flaky = createTestActivity('upload', {
  failUntilAttempt: 3,
  retry: { maximumAttempts: 5 },
});

// Activity with custom execute logic
const custom = createTestActivity('transform', {
  execute: async (ctx) => ({ result: ctx.input.value * 2 }),
});
```

## Mock Dependencies

### MockClock

Deterministic time control:

```typescript
ctx.clock.advance(60000); // Advance 1 minute
const now = ctx.clock.now();
```

### MockEnvironment

Control runtime conditions:

```typescript
ctx.environment.setConnected(false);  // Simulate offline
ctx.environment.setBatteryLevel(0.1); // Low battery
ctx.environment.setAppState('background');
```

### MockScheduler

Background task scheduling (integrates with MockClock).

## Writing New Tests

### Unit Test Template

```typescript
/**
 * Unit Test: WorkflowEngine - [Feature Name]
 *
 * [Description of what this tests]
 *
 * Key scenarios tested:
 * - [Scenario 1]
 * - [Scenario 2]
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from '../storage';
import { MockClock, MockScheduler, MockEnvironment } from '../mocks';
import { defineActivity, defineWorkflow } from '../definitions';

describe('WorkflowEngine - [Feature]', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  it('should [behavior]', async () => {
    const engine = await createEngine();
    // ... test implementation
  });
});
```

### Integration Test Template

```typescript
/**
 * Integration Test: [Scenario Name]
 *
 * [Description of the scenario]
 *
 * Key scenarios tested:
 * - [Scenario 1]
 * - [Scenario 2]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { createTestContext, runToCompletion, TestContext } from '../utils/testHelpers';

describe('[Scenario] Integration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    ctx.engine.stop();
  });

  it('should [behavior]', async () => {
    const execution = await ctx.engine.start(workflow, { input: {} });
    const result = await runToCompletion(ctx, execution.runId);
    expect(result.status).toBe('completed');
  });
});
```
