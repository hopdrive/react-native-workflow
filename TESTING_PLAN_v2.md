# React Native Workflow - Comprehensive Testing Plan

## Document Purpose

This document provides a complete testing strategy for `@hopdrive/react-native-workflow`, an open-source, offline-first workflow orchestration library for React Native. It is designed to be actionable by developers or coding agents implementing the test suite.

**Repository:** Monorepo containing:
- `packages/react-native-workflow` - The published npm package
- `apps/example` - Expo demo app showcasing library capabilities

**License:** MIT

---

## Table of Contents

1. [Current State](#current-state)
2. [Prerequisite: AbortSignal Cancellation Propagation](#prerequisite-abortsignal-cancellation-propagation)
3. [Phase 1: Infrastructure Setup](#phase-1-infrastructure-setup)
4. [Phase 2: Unit Test Expansion](#phase-2-unit-test-expansion)
5. [Phase 3: Integration Tests](#phase-3-integration-tests)
6. [Phase 4: React Hooks Tests](#phase-4-react-hooks-tests)
7. [Phase 5: Example App & E2E Tests](#phase-5-example-app--e2e-tests)
8. [Test Utilities & Fixtures](#test-utilities--fixtures)
9. [CI/CD Configuration](#cicd-configuration)
10. [Implementation Checklist](#implementation-checklist)

---

## Current State

### Existing Test Coverage

134 tests across 6 test files:

| File | Tests | Coverage Area |
|------|-------|---------------|
| `WorkflowEngine.test.ts` | 21 | Registration, starting, tick, callbacks, uniqueness, cancellation |
| `WorkflowEngine.lifecycle.test.ts` | 11 | State transitions, crash recovery, concurrency |
| `WorkflowEngine.retry.test.ts` | 13 | Retry behavior, backoff, state preservation |
| `WorkflowEngine.gating.test.ts` | 21 | runWhen, built-in conditions, combinators |
| `WorkflowEngine.dlq.test.ts` | 15 | Dead letter CRUD, acknowledgment, purging |
| `SQLiteStorage.test.ts` | 54 | All storage operations |

### Current Stack

- Test runner: Jest (migrating to Vitest)
- Storage adapters: InMemoryStorage (testing), SQLiteStorage (production)
- React hooks: 7 hooks implemented with polling

### Known Implementation Gap

**AbortSignal cancellation propagation is partially implemented:**
- ✅ `ctx.signal` is passed to activities
- ✅ Timeout abort works (signal fires when activity exceeds timeout)
- ❌ `cancelExecution()` does NOT propagate abort to in-flight activities
- ❌ No mechanism to track/abort currently executing activity's AbortController

This must be implemented before testing the cancellation flow.

---

## Prerequisite: AbortSignal Cancellation Propagation

### Implementation Requirements

Before expanding cancellation tests, implement the following in `WorkflowEngine`:

```typescript
// WorkflowEngine.ts

class WorkflowEngine {
  // Add: Map to track active AbortControllers by runId
  private activeAbortControllers: Map<string, AbortController> = new Map();

  private async executeActivity(task: ActivityTask): Promise<void> {
    const controller = new AbortController();
    
    // Register the controller for this execution
    this.activeAbortControllers.set(task.runId, controller);
    
    try {
      const activity = this.getActivity(task.activityName);
      
      // Set up timeout abort
      const timeoutId = task.timeout > 0 
        ? setTimeout(() => controller.abort(new Error('Activity timeout')), task.timeout)
        : null;
      
      try {
        const ctx: ActivityContext = {
          runId: task.runId,
          taskId: task.taskId,
          attempt: task.attempts,
          input: task.input,
          signal: controller.signal,  // Pass the signal
          ...this.runtimeContext(),
        };
        
        const result = await activity.execute(ctx);
        
        // ... handle success
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    } finally {
      // Always clean up the controller reference
      this.activeAbortControllers.delete(task.runId);
    }
  }

  async cancelExecution(runId: string): Promise<void> {
    // 1. Abort any in-flight activity
    const controller = this.activeAbortControllers.get(runId);
    if (controller) {
      controller.abort(new Error('Workflow cancelled'));
    }
    
    // 2. Update execution status
    const execution = await this.storage.getExecution(runId);
    if (!execution) return;
    
    await this.storage.saveExecution({
      ...execution,
      status: 'cancelled',
      updatedAt: Date.now(),
    });
    
    // 3. Cancel pending tasks for this execution
    const tasks = await this.storage.getActivityTasksForExecution(runId);
    for (const task of tasks) {
      if (task.status === 'pending') {
        await this.storage.deleteActivityTask(task.taskId);
      }
      if (task.status === 'active') {
        await this.storage.saveActivityTask({
          ...task,
          status: 'cancelled',
          completedAt: Date.now(),
        });
      }
    }
    
    // 4. Release uniqueness constraint
    const workflow = this.workflows.get(execution.workflowName);
    if (execution.uniqueKey) {
      await this.storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
    }
    
    // 5. Invoke callback
    await workflow?.onCancelled?.(runId, execution.state);
  }
}
```

### Tests for Cancellation Propagation

After implementing, add these tests to verify the behavior:

```typescript
// WorkflowEngine.cancellation.test.ts

describe('Cancellation Propagation', () => {
  it('should abort in-flight activity when cancelExecution called', async () => {
    let signalAborted = false;
    let abortReason: any;
    
    const slowActivity = defineActivity({
      name: 'slow',
      execute: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          signalAborted = true;
          abortReason = ctx.signal.reason;
        });
        
        // Simulate long-running work
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 10000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(ctx.signal.reason);
          });
        });
        
        return { done: true };
      },
      options: { startToCloseTimeout: 30000 },
    });

    const workflow = defineWorkflow({
      name: 'cancellable',
      activities: [slowActivity],
    });

    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });
    
    // Start activity execution (don't await)
    const tickPromise = engine.tick();
    
    // Give activity time to start
    await sleep(50);
    
    // Cancel while activity is running
    await engine.cancelExecution(execution.runId);
    
    // Wait for tick to complete (should be aborted)
    await tickPromise;
    
    expect(signalAborted).toBe(true);
    expect(abortReason.message).toContain('cancelled');
  });

  it('should mark active task as cancelled', async () => {
    // Similar setup with slow activity
    // Verify task.status === 'cancelled' after cancelExecution
  });

  it('should release uniqueKey on cancellation', async () => {
    const workflow = defineWorkflow({
      name: 'unique',
      activities: [slowActivity],
    });

    const execution = await engine.start(workflow, {
      input: {},
      uniqueKey: 'test-key',
    });

    // Start activity
    const tickPromise = engine.tick();
    await sleep(50);
    
    // Cancel
    await engine.cancelExecution(execution.runId);
    await tickPromise;

    // Should be able to start new workflow with same key
    const execution2 = await engine.start(workflow, {
      input: {},
      uniqueKey: 'test-key',
    });
    
    expect(execution2.runId).not.toBe(execution.runId);
  });

  it('should call onCancelled callback', async () => {
    let callbackCalled = false;
    let callbackRunId: string | null = null;
    
    const workflow = defineWorkflow({
      name: 'withCallback',
      activities: [slowActivity],
      onCancelled: async (runId, state) => {
        callbackCalled = true;
        callbackRunId = runId;
      },
    });

    const execution = await engine.start(workflow, { input: {} });
    const tickPromise = engine.tick();
    await sleep(50);
    
    await engine.cancelExecution(execution.runId);
    await tickPromise;

    expect(callbackCalled).toBe(true);
    expect(callbackRunId).toBe(execution.runId);
  });

  it('should handle cancellation of pending (not yet started) workflow', async () => {
    const workflow = defineWorkflow({
      name: 'pending',
      activities: [createTestActivity('first')],
    });

    const execution = await engine.start(workflow, { input: {} });
    
    // Cancel before tick
    await engine.cancelExecution(execution.runId);

    const result = await engine.getExecution(execution.runId);
    expect(result?.status).toBe('cancelled');
    
    // Pending task should be deleted
    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    expect(tasks).toHaveLength(0);
  });

  it('should handle cancellation of already completed workflow gracefully', async () => {
    const workflow = defineWorkflow({
      name: 'quick',
      activities: [createTestActivity('instant')],
    });

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick(); // Complete immediately
    
    // Cancel after completion - should not error
    await expect(engine.cancelExecution(execution.runId)).resolves.not.toThrow();
    
    // Status should still be completed (not cancelled)
    const result = await engine.getExecution(execution.runId);
    expect(result?.status).toBe('completed');
  });

  it('should propagate abort to fetch calls using signal', async () => {
    let fetchAborted = false;
    
    const fetchActivity = defineActivity({
      name: 'fetcher',
      execute: async (ctx) => {
        try {
          // Simulated fetch that respects abort signal
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              fetchAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
          return { fetched: true };
        } catch (e) {
          if (e.name === 'AbortError') {
            throw e; // Re-throw abort errors
          }
          throw e;
        }
      },
    });

    // ... test that fetchAborted becomes true on cancel
  });
});
```

---

## Phase 1: Infrastructure Setup

### 1.1 Monorepo Structure

```
/
├── packages/
│   └── react-native-workflow/
│       ├── src/
│       │   ├── core/
│       │   │   ├── WorkflowEngine.ts
│       │   │   ├── WorkflowEngine.test.ts
│       │   │   ├── WorkflowEngine.timeout.test.ts
│       │   │   ├── WorkflowEngine.callbacks.test.ts
│       │   │   ├── WorkflowEngine.state.test.ts
│       │   │   ├── WorkflowEngine.concurrency.test.ts
│       │   │   ├── WorkflowEngine.cancellation.test.ts
│       │   │   ├── conditions.ts
│       │   │   ├── conditions.test.ts
│       │   │   └── storage/
│       │   │       ├── InMemoryStorage.ts
│       │   │       ├── InMemoryStorage.test.ts
│       │   │       └── Storage.ts
│       │   ├── adapters/
│       │   │   └── expo/
│       │   │       ├── storage/
│       │   │       │   ├── SQLiteStorage.ts
│       │   │       │   └── SQLiteStorage.test.ts
│       │   │       └── hooks/
│       │   │           ├── index.ts
│       │   │           ├── useExecution.test.ts
│       │   │           ├── useExecutionsByStatus.test.ts
│       │   │           ├── useDeadLetters.test.ts
│       │   │           ├── usePendingActivityCount.test.ts
│       │   │           ├── useExecutionStats.test.ts
│       │   │           ├── useWorkflowStarter.test.ts
│       │   │           └── useEngineRunner.test.ts
│       │   └── index.ts
│       ├── tests/
│       │   ├── integration/
│       │   │   ├── PhotoWorkflow.test.ts
│       │   │   ├── MultiWorkflow.test.ts
│       │   │   ├── CrashRecovery.test.ts
│       │   │   └── BackgroundProcessing.test.ts
│       │   ├── fixtures/
│       │   │   └── workflows.ts
│       │   └── utils/
│       │       └── testHelpers.ts
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── README.md
├── apps/
│   └── example/
│       ├── app/
│       │   ├── _layout.tsx
│       │   ├── index.tsx
│       │   ├── workflows.tsx
│       │   ├── dead-letters.tsx
│       │   └── settings.tsx
│       ├── workflows/
│       │   ├── photo/
│       │   └── sync/
│       ├── components/
│       ├── e2e/
│       │   └── workflows.test.ts
│       ├── app.json
│       ├── package.json
│       └── README.md
├── package.json (workspace root)
├── pnpm-workspace.yaml (or npm workspaces config)
├── LICENSE
├── README.md
└── .github/
    └── workflows/
        ├── ci.yml
        └── release.yml
```

### 1.2 Root Package Configuration

```json
// package.json (root)
{
  "name": "react-native-workflow-monorepo",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "build": "npm run build --workspace=packages/react-native-workflow",
    "test": "npm run test --workspace=packages/react-native-workflow",
    "test:watch": "npm run test:watch --workspace=packages/react-native-workflow",
    "test:coverage": "npm run test:coverage --workspace=packages/react-native-workflow",
    "test:integration": "npm run test:integration --workspace=packages/react-native-workflow",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "example": "npm run start --workspace=apps/example",
    "prepare": "husky"
  },
  "devDependencies": {
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0"
  },
  "lint-staged": {
    "packages/**/*.{ts,tsx}": [
      "eslint --fix",
      "vitest related --run"
    ]
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### 1.3 Package Configuration

```json
// packages/react-native-workflow/package.json
{
  "name": "@hopdrive/react-native-workflow",
  "version": "0.1.0",
  "description": "Offline-first workflow orchestration for React Native",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./expo": {
      "import": "./dist/adapters/expo/index.mjs",
      "require": "./dist/adapters/expo/index.js",
      "types": "./dist/adapters/expo/index.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts,.tsx"
  },
  "peerDependencies": {
    "react": ">=18.0.0",
    "react-native": ">=0.70.0"
  },
  "peerDependenciesMeta": {
    "expo-sqlite": {
      "optional": true
    }
  },
  "devDependencies": {
    "@testing-library/react-hooks": "^8.0.0",
    "@types/react": "^18.0.0",
    "@vitest/coverage-v8": "^1.0.0",
    "eslint": "^8.0.0",
    "react": "^18.0.0",
    "react-native": "^0.73.0",
    "react-test-renderer": "^18.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  },
  "keywords": [
    "react-native",
    "workflow",
    "queue",
    "offline-first",
    "background-tasks",
    "job-queue"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/hopdrive/react-native-workflow.git"
  },
  "license": "MIT",
  "author": "HopDrive",
  "bugs": {
    "url": "https://github.com/hopdrive/react-native-workflow/issues"
  },
  "homepage": "https://github.com/hopdrive/react-native-workflow#readme"
}
```

### 1.4 Vitest Configuration

```typescript
// packages/react-native-workflow/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/',
        'dist/',
        '**/*.d.ts',
        '**/types.ts',
        '**/index.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: ['./tests/setup.ts'],
  },
});
```

```typescript
// packages/react-native-workflow/vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 10000,
    setupFiles: ['./tests/setup.ts'],
    // Integration tests run sequentially to avoid state conflicts
    sequence: {
      concurrent: false,
    },
  },
});
```

```typescript
// packages/react-native-workflow/tests/setup.ts
import { vi } from 'vitest';

// Mock timers setup for tests that need them
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
```

### 1.5 LICENSE File

```
// LICENSE (root)
MIT License

Copyright (c) 2024 HopDrive

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.6 Husky Configuration

```bash
# .husky/pre-commit
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npm run typecheck
npx lint-staged
```

---

## Phase 2: Unit Test Expansion

### 2.1 Timeout Handling Tests

**File:** `src/core/WorkflowEngine.timeout.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from './storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from './definitions';
import { createTestEngine, sleep } from '../../tests/utils/testHelpers';

describe('Activity Timeout Handling', () => {
  let engine: WorkflowEngine;
  let storage: InMemoryStorage;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = await createTestEngine({ storage });
  });

  describe('startToCloseTimeout behavior', () => {
    it('should abort activity when startToCloseTimeout exceeded', async () => {
      const activity = defineActivity({
        name: 'slowActivity',
        execute: async (ctx) => {
          await sleep(5000);
          return { done: true };
        },
        options: { startToCloseTimeout: 100 },
      });

      const workflow = defineWorkflow({
        name: 'timeoutTest',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('failed');
    });

    it('should set signal.aborted to true when timeout fires', async () => {
      let signalState = { aborted: false, reason: null as any };

      const activity = defineActivity({
        name: 'checkSignal',
        execute: async (ctx) => {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve({ done: true }), 5000);
            ctx.signal.addEventListener('abort', () => {
              signalState.aborted = ctx.signal.aborted;
              signalState.reason = ctx.signal.reason;
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
        },
        options: { startToCloseTimeout: 100 },
      });

      const workflow = defineWorkflow({
        name: 'signalTest',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(signalState.aborted).toBe(true);
      expect(signalState.reason).toBeDefined();
    });

    it('should count timeout as failed attempt for retry purposes', async () => {
      let attemptCount = 0;

      const activity = defineActivity({
        name: 'timingOut',
        execute: async (ctx) => {
          attemptCount = ctx.attempt;
          await sleep(5000);
          return {};
        },
        options: {
          startToCloseTimeout: 50,
          retry: { maximumAttempts: 3, initialInterval: 10 },
        },
      });

      const workflow = defineWorkflow({
        name: 'retryTimeout',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      // Process multiple ticks to allow retries
      for (let i = 0; i < 5; i++) {
        await engine.tick();
        await sleep(20);
      }

      expect(attemptCount).toBeGreaterThan(1);
    });

    it('should fail permanently after max attempts due to timeouts', async () => {
      const activity = defineActivity({
        name: 'alwaysTimesOut',
        execute: async () => {
          await sleep(5000);
          return {};
        },
        options: {
          startToCloseTimeout: 50,
          retry: { maximumAttempts: 2, initialInterval: 10 },
        },
      });

      const workflow = defineWorkflow({
        name: 'maxRetryTimeout',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Process enough ticks for all retries
      for (let i = 0; i < 10; i++) {
        await engine.tick();
        await sleep(20);
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('failed');

      // Should have dead letter
      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters.length).toBeGreaterThan(0);
    });

    it('should treat timeout of 0 as no timeout (infinite)', async () => {
      let completed = false;

      const activity = defineActivity({
        name: 'noTimeout',
        execute: async () => {
          await sleep(200);
          completed = true;
          return { done: true };
        },
        options: { startToCloseTimeout: 0 },
      });

      const workflow = defineWorkflow({
        name: 'infiniteTimeout',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(completed).toBe(true);
    });

    it('should not start activity if remaining lifespan < timeout', async () => {
      const activity = defineActivity({
        name: 'longActivity',
        execute: async () => {
          await sleep(100);
          return { done: true };
        },
        options: { startToCloseTimeout: 5000 },
      });

      const workflow = defineWorkflow({
        name: 'lifespanTest',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Run with very short lifespan
      await engine.start({ lifespan: 500 });

      // Activity should not have been started (status still pending)
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('pending');
    });
  });

  describe('timeout error context', () => {
    it('should include activity name in timeout error', async () => {
      let capturedError: Error | null = null;

      const activity = defineActivity({
        name: 'namedActivity',
        execute: async () => {
          await sleep(5000);
          return {};
        },
        options: {
          startToCloseTimeout: 50,
          onFailed: async (taskId, input, error) => {
            capturedError = error;
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'errorContext',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(capturedError?.message).toContain('timeout');
    });
  });
});
```

### 2.2 Callback Error Handling Tests

**File:** `src/core/WorkflowEngine.callbacks.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from './storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from './definitions';
import { createTestEngine, createTestActivity } from '../../tests/utils/testHelpers';

describe('Callback Error Handling', () => {
  let engine: WorkflowEngine;
  let storage: InMemoryStorage;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = await createTestEngine({ storage });
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('Activity-level callbacks', () => {
    it('should not fail activity if onStart throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => ({ result: true }),
        options: {
          onStart: async () => {
            throw new Error('onStart failed');
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'onStartThrows',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should not fail activity if onSuccess throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => ({ result: true }),
        options: {
          onSuccess: async () => {
            throw new Error('onSuccess failed');
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'onSuccessThrows',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should continue retry flow if onFailure throws', async () => {
      let attempts = 0;

      const activity = defineActivity({
        name: 'test',
        execute: async () => {
          attempts++;
          if (attempts < 3) throw new Error('Activity failed');
          return { done: true };
        },
        options: {
          retry: { maximumAttempts: 5, initialInterval: 10 },
          onFailure: async () => {
            throw new Error('onFailure threw');
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'onFailureThrows',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Process retries
      for (let i = 0; i < 5; i++) {
        await engine.tick();
        await vi.advanceTimersByTimeAsync(50);
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(attempts).toBe(3);
    });

    it('should still create dead letter if onFailed throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => {
          throw new Error('Always fails');
        },
        options: {
          retry: { maximumAttempts: 1 },
          onFailed: async () => {
            throw new Error('onFailed threw');
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'onFailedThrows',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
    });

    it('should still reschedule if onSkipped throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => ({ done: true }),
        options: {
          runWhen: () => ({ ready: false, reason: 'Not ready' }),
          onSkipped: async () => {
            throw new Error('onSkipped threw');
          },
        },
      });

      const workflow = defineWorkflow({
        name: 'onSkippedThrows',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      // Workflow should still be running (activity skipped but rescheduled)
      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('running');
    });
  });

  describe('Workflow-level callbacks', () => {
    it('should not change execution status if onComplete throws', async () => {
      const activity = createTestActivity('simple');

      const workflow = defineWorkflow({
        name: 'onCompleteThrows',
        activities: [activity],
        onComplete: async () => {
          throw new Error('onComplete threw');
        },
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should still release uniqueKey if onComplete throws', async () => {
      const activity = createTestActivity('simple');

      const workflow = defineWorkflow({
        name: 'releaseOnThrow',
        activities: [activity],
        onComplete: async () => {
          throw new Error('onComplete threw');
        },
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });
      await engine.tick();

      // Should be able to start new workflow with same key
      const execution2 = await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });
      expect(execution2).toBeDefined();
    });

    it('should still create dead letter if onFailed throws', async () => {
      const activity = defineActivity({
        name: 'failing',
        execute: async () => {
          throw new Error('Always fails');
        },
        options: { retry: { maximumAttempts: 1 } },
      });

      const workflow = defineWorkflow({
        name: 'workflowOnFailedThrows',
        activities: [activity],
        onFailed: async () => {
          throw new Error('onFailed threw');
        },
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
    });

    it('should still release uniqueKey if onCancelled throws', async () => {
      const slowActivity = defineActivity({
        name: 'slow',
        execute: async (ctx) => {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(ctx.signal.reason);
            });
          });
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'onCancelledThrows',
        activities: [slowActivity],
        onCancelled: async () => {
          throw new Error('onCancelled threw');
        },
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'cancel-key',
      });

      const tickPromise = engine.tick();
      await vi.advanceTimersByTimeAsync(50);
      await engine.cancelExecution(execution.runId);
      await tickPromise;

      // Should be able to reuse key
      const execution2 = await engine.start(workflow, {
        input: {},
        uniqueKey: 'cancel-key',
      });
      expect(execution2).toBeDefined();
    });
  });
});
```

### 2.3 State Threading Tests

**File:** `src/core/WorkflowEngine.state.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from './storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from './definitions';
import { createTestEngine, createTestActivity, runUntilComplete } from '../../tests/utils/testHelpers';

describe('State Threading', () => {
  let engine: WorkflowEngine;
  let storage: InMemoryStorage;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = await createTestEngine({ storage });
  });

  describe('Activity return value handling', () => {
    it('should handle activity returning undefined', async () => {
      const activity = defineActivity({
        name: 'returnsUndefined',
        execute: async () => undefined,
      });

      const workflow = defineWorkflow({
        name: 'undefinedReturn',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state).toEqual({ original: 'value' });
    });

    it('should handle activity returning null', async () => {
      const activity = defineActivity({
        name: 'returnsNull',
        execute: async () => null,
      });

      const workflow = defineWorkflow({
        name: 'nullReturn',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // null should be treated as "nothing to merge"
      expect(result?.state).toEqual({ original: 'value' });
    });

    it('should handle activity returning empty object', async () => {
      const activity = defineActivity({
        name: 'returnsEmpty',
        execute: async () => ({}),
      });

      const workflow = defineWorkflow({
        name: 'emptyReturn',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state).toEqual({ original: 'value' });
    });
  });

  describe('State merge behavior', () => {
    it('should shallow merge activity results (not deep merge)', async () => {
      const activity = defineActivity({
        name: 'nestedReturn',
        execute: async () => ({ nested: { b: 2 } }),
      });

      const workflow = defineWorkflow({
        name: 'shallowMerge',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { nested: { a: 1 } },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // Shallow merge: nested is replaced, not merged
      expect(result?.state.nested).toEqual({ b: 2 });
      expect(result?.state.nested.a).toBeUndefined();
    });

    it('should allow later activities to overwrite earlier values', async () => {
      const activity1 = defineActivity({
        name: 'first',
        execute: async () => ({ status: 'pending' }),
      });
      const activity2 = defineActivity({
        name: 'second',
        execute: async () => ({ status: 'uploaded' }),
      });

      const workflow = defineWorkflow({
        name: 'overwrite',
        activities: [activity1, activity2],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.state.status).toBe('uploaded');
    });

    it('should preserve original input in execution.input', async () => {
      const activity = defineActivity({
        name: 'mutator',
        execute: async () => ({ moveId: 999, newField: 'added' }),
      });

      const workflow = defineWorkflow({
        name: 'preserveInput',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { moveId: 123, uri: 'original.jpg' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // Original input preserved
      expect(result?.input).toEqual({ moveId: 123, uri: 'original.jpg' });
      // State has merged values
      expect(result?.state.moveId).toBe(999);
      expect(result?.state.newField).toBe('added');
      expect(result?.state.uri).toBe('original.jpg');
    });

    it('should thread state through entire activity chain', async () => {
      const activity1 = defineActivity({
        name: 'step1',
        execute: async (ctx) => {
          expect(ctx.input.initial).toBe('data');
          return { step1: 'done' };
        },
      });
      const activity2 = defineActivity({
        name: 'step2',
        execute: async (ctx) => {
          expect(ctx.input.step1).toBe('done');
          return { step2: 'done' };
        },
      });
      const activity3 = defineActivity({
        name: 'step3',
        execute: async (ctx) => {
          expect(ctx.input.step1).toBe('done');
          expect(ctx.input.step2).toBe('done');
          return { step3: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'chainState',
        activities: [activity1, activity2, activity3],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { initial: 'data' },
      });
      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.state).toEqual({
        initial: 'data',
        step1: 'done',
        step2: 'done',
        step3: 'done',
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle very large payloads', async () => {
      const largeData = {
        array: Array.from({ length: 10000 }, (_, i) => ({ index: i, data: 'x'.repeat(100) })),
        nested: {
          deep: {
            structure: {
              with: {
                many: {
                  levels: 'value',
                },
              },
            },
          },
        },
      };

      const activity = defineActivity({
        name: 'largePayload',
        execute: async () => ({ processed: true }),
      });

      const workflow = defineWorkflow({
        name: 'largePayload',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: largeData });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.input.array.length).toBe(10000);
    });

    it('should handle special characters in payload', async () => {
      const specialData = {
        unicode: '日本語 한국어 中文 العربية',
        emoji: '🚀🎉💡',
        escapes: 'line1\nline2\ttab',
        quotes: `"double" 'single' \`backtick\``,
      };

      const activity = defineActivity({
        name: 'special',
        execute: async () => ({ echoed: true }),
      });

      const workflow = defineWorkflow({
        name: 'specialChars',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: specialData });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.input.unicode).toBe(specialData.unicode);
      expect(result?.input.emoji).toBe(specialData.emoji);
    });

    it('should reject circular references with clear error', async () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      const activity = defineActivity({
        name: 'circular',
        execute: async () => circular,
      });

      const workflow = defineWorkflow({
        name: 'circularRef',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Should fail with clear error about circular reference
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('failed');
      expect(result?.error).toMatch(/circular|cyclic/i);
    });
  });
});
```

### 2.4 Concurrency Tests

**File:** `src/core/WorkflowEngine.concurrency.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from './storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from './definitions';
import { createTestEngine, createTestActivity, sleep } from '../../tests/utils/testHelpers';

describe('Concurrency Safety', () => {
  let engine: WorkflowEngine;
  let storage: InMemoryStorage;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = await createTestEngine({ storage });
  });

  describe('Workflow creation', () => {
    it('should handle rapid sequential workflow starts', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'rapid',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);

      const executions = [];
      for (let i = 0; i < 100; i++) {
        executions.push(engine.start(workflow, { input: { index: i } }));
      }

      const results = await Promise.all(executions);

      // All should succeed with unique runIds
      const runIds = results.map((e) => e.runId);
      const uniqueIds = new Set(runIds);
      expect(uniqueIds.size).toBe(100);
    });

    it('should handle concurrent starts with same uniqueKey', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'unique',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);

      // Start 10 workflows concurrently with same key
      const promises = Array.from({ length: 10 }, () =>
        engine.start(workflow, { input: {}, uniqueKey: 'same-key' }).catch((e) => e)
      );

      const results = await Promise.all(promises);

      // Exactly one should succeed
      const successes = results.filter((r) => !(r instanceof Error));
      const failures = results.filter((r) => r instanceof Error);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(9);
    });
  });

  describe('Task processing', () => {
    it('should not double-process same task with concurrent ticks', async () => {
      let executeCount = 0;

      const activity = defineActivity({
        name: 'countExecution',
        execute: async () => {
          executeCount++;
          await sleep(100);
          return { count: executeCount };
        },
      });

      const workflow = defineWorkflow({
        name: 'countTest',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      // Run multiple ticks concurrently
      await Promise.all([engine.tick(), engine.tick(), engine.tick()]);

      expect(executeCount).toBe(1);
    });

    it('should handle concurrent tick and cancelExecution', async () => {
      let activityStarted = false;
      let activityCompleted = false;

      const slowActivity = defineActivity({
        name: 'slow',
        execute: async (ctx) => {
          activityStarted = true;
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => {
              activityCompleted = true;
              resolve({ done: true });
            }, 1000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(ctx.signal.reason);
            });
          });
          return { completed: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'cancelRace',
        activities: [slowActivity],
      });

      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Start tick (don't await)
      const tickPromise = engine.tick();

      // Wait for activity to start
      await vi.waitFor(() => expect(activityStarted).toBe(true));

      // Cancel while activity running
      await engine.cancelExecution(execution.runId);

      // Wait for tick to complete
      await tickPromise;

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('cancelled');
      expect(activityCompleted).toBe(false);
    });
  });

  describe('Engine start/stop', () => {
    it('should handle stop() during active tick loop', async () => {
      let tickCount = 0;

      const activity = defineActivity({
        name: 'counter',
        execute: async () => {
          tickCount++;
          return { tick: tickCount };
        },
      });

      const workflow = defineWorkflow({
        name: 'stopDuring',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);

      // Create multiple workflows
      for (let i = 0; i < 5; i++) {
        await engine.start(workflow, { input: { i } });
      }

      // Start engine with lifespan
      const runPromise = engine.start({ lifespan: 1000 });

      // Stop after short delay
      await sleep(100);
      engine.stop();

      await runPromise;

      // Should have processed some but stopped cleanly
      expect(tickCount).toBeGreaterThan(0);
      expect(tickCount).toBeLessThanOrEqual(5);
    });

    it('should handle multiple start() calls gracefully', async () => {
      const activity = createTestActivity('simple');
      const workflow = defineWorkflow({
        name: 'multiStart',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      // Multiple starts should not error or cause issues
      const promise1 = engine.start({ lifespan: 100 });
      const promise2 = engine.start({ lifespan: 100 });

      await Promise.all([promise1, promise2]);

      // Should complete without error
    });

    it('should handle stop() when already stopped', async () => {
      // Should be idempotent
      engine.stop();
      engine.stop();
      engine.stop();

      // No error should be thrown
    });
  });
});
```

### 2.5 Validation Tests

**File:** `src/core/WorkflowEngine.validation.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import { InMemoryStorage } from './storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from './definitions';
import { createTestEngine, createTestActivity } from '../../tests/utils/testHelpers';

describe('Input Validation', () => {
  let engine: WorkflowEngine;

  beforeEach(async () => {
    engine = await createTestEngine();
  });

  describe('Workflow definition validation', () => {
    it('should reject workflow with empty activities array', () => {
      expect(() =>
        defineWorkflow({
          name: 'empty',
          activities: [],
        })
      ).toThrow(/at least one activity/i);
    });

    it('should reject workflow with duplicate activity names', () => {
      const activity = createTestActivity('duplicate');

      expect(() =>
        defineWorkflow({
          name: 'duplicates',
          activities: [activity, activity],
        })
      ).toThrow(/duplicate.*name/i);
    });

    it('should reject workflow with empty name', () => {
      const activity = createTestActivity('test');

      expect(() =>
        defineWorkflow({
          name: '',
          activities: [activity],
        })
      ).toThrow(/name.*required/i);
    });
  });

  describe('Activity definition validation', () => {
    it('should reject activity with empty name', () => {
      expect(() =>
        defineActivity({
          name: '',
          execute: async () => ({}),
        })
      ).toThrow(/name.*required/i);
    });

    it('should reject negative timeout values', () => {
      expect(() =>
        defineActivity({
          name: 'negative',
          execute: async () => ({}),
          options: { startToCloseTimeout: -1000 },
        })
      ).toThrow(/timeout.*negative/i);
    });

    it('should reject negative retry attempts', () => {
      expect(() =>
        defineActivity({
          name: 'negativeRetry',
          execute: async () => ({}),
          options: { retry: { maximumAttempts: -1 } },
        })
      ).toThrow(/attempts.*negative/i);
    });

    it('should reject zero maximumAttempts', () => {
      expect(() =>
        defineActivity({
          name: 'zeroRetry',
          execute: async () => ({}),
          options: { retry: { maximumAttempts: 0 } },
        })
      ).toThrow(/attempts.*at least 1/i);
    });
  });

  describe('Runtime validation', () => {
    it('should throw clear error for unregistered workflow', async () => {
      const workflow = defineWorkflow({
        name: 'unregistered',
        activities: [createTestActivity('test')],
      });

      // Don't register it
      await expect(engine.start(workflow, { input: {} })).rejects.toThrow(
        /not registered|register.*first/i
      );
    });

    it('should provide helpful error message', async () => {
      const workflow = defineWorkflow({
        name: 'myWorkflow',
        activities: [createTestActivity('test')],
      });

      try {
        await engine.start(workflow, { input: {} });
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('myWorkflow');
        expect(e.message).toMatch(/register/i);
      }
    });
  });
});

describe('Error Message Quality', () => {
  let engine: WorkflowEngine;

  beforeEach(async () => {
    engine = await createTestEngine();
  });

  it('should include runId in execution errors', async () => {
    const failingActivity = defineActivity({
      name: 'failing',
      execute: async () => {
        throw new Error('Activity error');
      },
    });

    const workflow = defineWorkflow({
      name: 'errorContext',
      activities: [failingActivity],
    });

    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    const result = await engine.getExecution(execution.runId);
    expect(result?.error).toContain('Activity error');

    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters[0]?.runId).toBe(execution.runId);
  });

  it('should include activity name in failed execution', async () => {
    const failingActivity = defineActivity({
      name: 'specificActivityName',
      execute: async () => {
        throw new Error('Failed');
      },
    });

    const workflow = defineWorkflow({
      name: 'trackActivity',
      activities: [failingActivity],
    });

    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    const result = await engine.getExecution(execution.runId);
    expect(result?.failedActivityName).toBe('specificActivityName');
  });
});
```

### 2.6 Additional Lifecycle Tests

**File:** `src/core/WorkflowEngine.lifecycle.test.ts` (additions to existing)

Add these tests to the existing lifecycle test file:

```typescript
describe('Engine Lifecycle (Additional)', () => {
  describe('Lifespan mode', () => {
    it('should respect lifespan parameter exactly', async () => {
      const activity = defineActivity({
        name: 'quick',
        execute: async () => {
          await sleep(10);
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'lifespan',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);

      // Create many workflows
      for (let i = 0; i < 100; i++) {
        await engine.start(workflow, { input: { i } });
      }

      const startTime = Date.now();
      await engine.start({ lifespan: 200 });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(180); // Some tolerance
      expect(elapsed).toBeLessThan(300); // Should stop on time
    });

    it('should apply 500ms safety buffer before deadline', async () => {
      const executionTimes: number[] = [];

      const activity = defineActivity({
        name: 'timed',
        execute: async () => {
          executionTimes.push(Date.now());
          await sleep(100);
          return {};
        },
        options: { startToCloseTimeout: 200 },
      });

      const workflow = defineWorkflow({
        name: 'safetyBuffer',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.start(workflow, { input: {} });
      await engine.start(workflow, { input: {} });

      const startTime = Date.now();
      await engine.start({ lifespan: 1000 });

      // No activity should start in last 500ms
      const deadline = startTime + 1000;
      for (const time of executionTimes) {
        expect(time).toBeLessThan(deadline - 400); // Allow some tolerance
      }
    });
  });

  describe('Zero-activity edge case', () => {
    it('should handle getExecution for non-existent runId', async () => {
      const result = await engine.getExecution('non-existent-run-id');
      expect(result).toBeNull();
    });

    it('should handle cancelExecution for non-existent runId', async () => {
      // Should not throw
      await expect(engine.cancelExecution('non-existent')).resolves.not.toThrow();
    });
  });
});
```

---

## Phase 3: Integration Tests

### 3.1 Photo Workflow Integration

**File:** `tests/integration/PhotoWorkflow.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from '../../src/core/WorkflowEngine';
import { InMemoryStorage } from '../../src/core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity, conditions } from '../../src';
import { createTestEngine, runUntilComplete, sleep } from '../utils/testHelpers';

/**
 * Integration test simulating the HopDrive photo pipeline.
 * This tests the complete flow from capture through upload and notification.
 */
describe('Photo Workflow Integration', () => {
  let engine: WorkflowEngine;
  let networkState: { isConnected: boolean };
  let completedCallbacks: Array<{ runId: string; state: any }>;

  // Simulated activities matching driver app patterns
  const capturePhoto = defineActivity({
    name: 'capturePhoto',
    execute: async (ctx) => {
      const { uri } = ctx.input;
      // Simulate hash generation
      const hash = `hash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return { hash, processedUri: uri, capturedAt: Date.now() };
    },
    options: {
      startToCloseTimeout: 5000,
      retry: { maximumAttempts: 3 },
    },
  });

  const uploadPhoto = defineActivity({
    name: 'uploadPhoto',
    execute: async (ctx) => {
      const { processedUri, hash } = ctx.input;
      
      // Simulate network dependency
      if (!ctx.isConnected) {
        throw new Error('No network connection');
      }
      
      // Simulate S3 upload
      await sleep(50);
      return {
        s3Key: `uploads/${hash}.jpg`,
        uploadedAt: Date.now(),
        contentLength: 1024000,
      };
    },
    options: {
      startToCloseTimeout: 60000,
      retry: {
        maximumAttempts: 10,
        initialInterval: 5000,
        backoffCoefficient: 2,
        maximumInterval: 60000,
      },
      runWhen: conditions.whenConnected,
    },
  });

  const notifyServer = defineActivity({
    name: 'notifyServer',
    execute: async (ctx) => {
      const { moveId, s3Key } = ctx.input;
      
      if (!ctx.isConnected) {
        throw new Error('No network connection');
      }
      
      // Simulate API call
      await sleep(20);
      return { notifiedAt: Date.now(), photoId: `photo_${Date.now()}` };
    },
    options: {
      startToCloseTimeout: 30000,
      retry: { maximumAttempts: 5, initialInterval: 1000 },
      runWhen: conditions.whenConnected,
    },
  });

  const photoWorkflow = defineWorkflow({
    name: 'photo',
    activities: [capturePhoto, uploadPhoto, notifyServer],
    onComplete: async (runId, state) => {
      completedCallbacks.push({ runId, state });
    },
  });

  beforeEach(async () => {
    completedCallbacks = [];
    networkState = { isConnected: true };

    engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      runtimeContext: () => ({
        isConnected: networkState.isConnected,
      }),
    });
    engine.registerWorkflow(photoWorkflow);
  });

  describe('Happy path', () => {
    it('should complete full photo workflow when online', async () => {
      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      const result = await runUntilComplete(engine, execution.runId);

      expect(result.status).toBe('completed');
      expect(result.state).toMatchObject({
        moveId: 123,
        uri: 'file://photo.jpg',
        hash: expect.stringMatching(/^hash_/),
        s3Key: expect.stringContaining('uploads/'),
        notifiedAt: expect.any(Number),
        photoId: expect.stringMatching(/^photo_/),
      });
      expect(completedCallbacks).toHaveLength(1);
      expect(completedCallbacks[0].runId).toBe(execution.runId);
    });

    it('should preserve moveId throughout workflow', async () => {
      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 456, uri: 'file://test.jpg' },
      });

      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.input.moveId).toBe(456);
      expect(result?.state.moveId).toBe(456);
    });
  });

  describe('Offline handling', () => {
    it('should complete capturePhoto but gate uploadPhoto when offline', async () => {
      networkState.isConnected = false;

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await engine.tick(); // capturePhoto completes
      await engine.tick(); // uploadPhoto skipped (no network)

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('running');
      expect(result?.currentActivityName).toBe('uploadPhoto');
      expect(result?.state.hash).toBeDefined(); // capturePhoto completed
      expect(result?.state.s3Key).toBeUndefined(); // uploadPhoto didn't run
    });

    it('should resume uploadPhoto when connectivity returns', async () => {
      networkState.isConnected = false;

      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await engine.tick(); // capturePhoto
      await engine.tick(); // uploadPhoto skipped

      // Connectivity restored
      networkState.isConnected = true;

      await runUntilComplete(engine, execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state.s3Key).toBeDefined();
    });

    it('should handle multiple connectivity transitions', async () => {
      const execution = await engine.start(photoWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      // Capture works (doesn't need network)
      await engine.tick();

      // Upload gated
      networkState.isConnected = false;
      await engine.tick();

      let result = await engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('uploadPhoto');

      // Network back
      networkState.isConnected = true;
      await engine.tick(); // Upload completes

      // Network drops again
      networkState.isConnected = false;
      await engine.tick(); // notifyServer skipped

      result = await engine.getExecution(execution.runId);
      expect(result?.currentActivityName).toBe('notifyServer');
      expect(result?.state.s3Key).toBeDefined();
      expect(result?.state.notifiedAt).toBeUndefined();

      // Finally back online
      networkState.isConnected = true;
      await engine.tick();

      result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Retry behavior', () => {
    it('should retry upload on transient failure', async () => {
      let uploadAttempts = 0;

      const flakyUpload = defineActivity({
        name: 'uploadPhoto',
        execute: async (ctx) => {
          uploadAttempts++;
          if (uploadAttempts < 3) {
            throw new Error('Network timeout');
          }
          return { s3Key: 'uploads/success.jpg', uploadedAt: Date.now() };
        },
        options: {
          retry: { maximumAttempts: 5, initialInterval: 10 },
          runWhen: conditions.whenConnected,
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'photo',
        activities: [capturePhoto, flakyUpload, notifyServer],
      });

      engine.registerWorkflow(flakyWorkflow);

      const execution = await engine.start(flakyWorkflow, {
        input: { moveId: 123, uri: 'file://photo.jpg' },
      });

      await runUntilComplete(engine, execution.runId, { timeout: 5000 });

      expect(uploadAttempts).toBe(3);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });
  });

  describe('Concurrent workflows', () => {
    it('should process multiple photo workflows independently', async () => {
      const executions = await Promise.all([
        engine.start(photoWorkflow, { input: { moveId: 1, uri: 'photo1.jpg' } }),
        engine.start(photoWorkflow, { input: { moveId: 2, uri: 'photo2.jpg' } }),
        engine.start(photoWorkflow, { input: { moveId: 3, uri: 'photo3.jpg' } }),
      ]);

      // Process all
      for (let i = 0; i < 15; i++) {
        await engine.tick();
      }

      for (const exec of executions) {
        const result = await engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }

      expect(completedCallbacks).toHaveLength(3);
    });
  });
});
```

### 3.2 Multi-Workflow Integration

**File:** `tests/integration/MultiWorkflow.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/WorkflowEngine';
import { InMemoryStorage } from '../../src/core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity, conditions } from '../../src';
import { createTestEngine, createTestActivity, runUntilComplete } from '../utils/testHelpers';

describe('Multi-Workflow Integration', () => {
  let engine: WorkflowEngine;
  let executionOrder: string[];

  beforeEach(async () => {
    executionOrder = [];
    engine = await createTestEngine();
  });

  it('should process different workflow types concurrently', async () => {
    const photoActivity = defineActivity({
      name: 'processPhoto',
      execute: async () => {
        executionOrder.push('photo');
        return { type: 'photo' };
      },
    });

    const syncActivity = defineActivity({
      name: 'syncData',
      execute: async () => {
        executionOrder.push('sync');
        return { type: 'sync' };
      },
    });

    const photoWorkflow = defineWorkflow({
      name: 'photo',
      activities: [photoActivity],
    });

    const syncWorkflow = defineWorkflow({
      name: 'sync',
      activities: [syncActivity],
    });

    engine.registerWorkflow(photoWorkflow);
    engine.registerWorkflow(syncWorkflow);

    const photoExec = await engine.start(photoWorkflow, { input: {} });
    const syncExec = await engine.start(syncWorkflow, { input: {} });

    await engine.tick();
    await engine.tick();

    const photoResult = await engine.getExecution(photoExec.runId);
    const syncResult = await engine.getExecution(syncExec.runId);

    expect(photoResult?.status).toBe('completed');
    expect(syncResult?.status).toBe('completed');
    expect(executionOrder).toHaveLength(2);
  });

  it('should respect priority across different workflows', async () => {
    const lowPriorityActivity = defineActivity({
      name: 'lowPriority',
      execute: async () => {
        executionOrder.push('low');
        return {};
      },
      options: { priority: 1 },
    });

    const highPriorityActivity = defineActivity({
      name: 'highPriority',
      execute: async () => {
        executionOrder.push('high');
        return {};
      },
      options: { priority: 100 },
    });

    const lowWorkflow = defineWorkflow({
      name: 'low',
      activities: [lowPriorityActivity],
    });

    const highWorkflow = defineWorkflow({
      name: 'high',
      activities: [highPriorityActivity],
    });

    engine.registerWorkflow(lowWorkflow);
    engine.registerWorkflow(highWorkflow);

    // Start low priority first
    await engine.start(lowWorkflow, { input: {} });
    // Then high priority
    await engine.start(highWorkflow, { input: {} });

    await engine.tick();
    await engine.tick();

    // High priority should have executed first
    expect(executionOrder[0]).toBe('high');
    expect(executionOrder[1]).toBe('low');
  });

  it('should isolate failures between workflows', async () => {
    const failingActivity = defineActivity({
      name: 'failing',
      execute: async () => {
        throw new Error('Intentional failure');
      },
      options: { retry: { maximumAttempts: 1 } },
    });

    const successActivity = defineActivity({
      name: 'success',
      execute: async () => ({ success: true }),
    });

    const failingWorkflow = defineWorkflow({
      name: 'failing',
      activities: [failingActivity],
    });

    const successWorkflow = defineWorkflow({
      name: 'success',
      activities: [successActivity],
    });

    engine.registerWorkflow(failingWorkflow);
    engine.registerWorkflow(successWorkflow);

    const failingExec = await engine.start(failingWorkflow, { input: {} });
    const successExec = await engine.start(successWorkflow, { input: {} });

    await engine.tick();
    await engine.tick();

    const failingResult = await engine.getExecution(failingExec.runId);
    const successResult = await engine.getExecution(successExec.runId);

    expect(failingResult?.status).toBe('failed');
    expect(successResult?.status).toBe('completed');
  });

  it('should handle mixed gated and non-gated workflows', async () => {
    let networkConnected = false;

    const engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      runtimeContext: () => ({ isConnected: networkConnected }),
    });

    const offlineActivity = defineActivity({
      name: 'offline',
      execute: async () => {
        executionOrder.push('offline');
        return {};
      },
    });

    const onlineActivity = defineActivity({
      name: 'online',
      execute: async () => {
        executionOrder.push('online');
        return {};
      },
      options: { runWhen: conditions.whenConnected },
    });

    const offlineWorkflow = defineWorkflow({
      name: 'offline',
      activities: [offlineActivity],
    });

    const onlineWorkflow = defineWorkflow({
      name: 'online',
      activities: [onlineActivity],
    });

    engine.registerWorkflow(offlineWorkflow);
    engine.registerWorkflow(onlineWorkflow);

    await engine.start(offlineWorkflow, { input: {} });
    await engine.start(onlineWorkflow, { input: {} });

    await engine.tick();
    await engine.tick();

    // Only offline should have completed
    expect(executionOrder).toEqual(['offline']);

    // Now connect
    networkConnected = true;
    await engine.tick();

    expect(executionOrder).toEqual(['offline', 'online']);
  });
});
```

### 3.3 Crash Recovery Integration

**File:** `tests/integration/CrashRecovery.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/WorkflowEngine';
import { InMemoryStorage } from '../../src/core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from '../../src';
import { createTestActivity, runUntilComplete, sleep } from '../utils/testHelpers';

describe('Crash Recovery Integration', () => {
  /**
   * Simulates crash by creating a new engine instance with same storage
   */
  async function simulateCrashAndRestart(
    storage: InMemoryStorage,
    workflows: ReturnType<typeof defineWorkflow>[]
  ): Promise<WorkflowEngine> {
    const newEngine = await WorkflowEngine.create({
      storage,
      runtimeContext: () => ({ isConnected: true }),
    });

    for (const workflow of workflows) {
      newEngine.registerWorkflow(workflow);
    }

    return newEngine;
  }

  it('should recover workflow with task in active state', async () => {
    const storage = new InMemoryStorage();
    let executionCount = 0;

    const activity = defineActivity({
      name: 'recoverable',
      execute: async () => {
        executionCount++;
        return { count: executionCount };
      },
    });

    const workflow = defineWorkflow({
      name: 'crash',
      activities: [activity],
    });

    // First engine
    let engine = await WorkflowEngine.create({
      storage,
      runtimeContext: () => ({ isConnected: true }),
    });
    engine.registerWorkflow(workflow);

    const execution = await engine.start(workflow, { input: {} });

    // Simulate: Task was claimed but engine crashed before completion
    // Manually set task to active state
    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    await storage.saveActivityTask({
      ...tasks[0],
      status: 'active',
      startedAt: Date.now(),
      attempts: 1,
    });

    // "Crash" and restart
    engine = await simulateCrashAndRestart(storage, [workflow]);

    // Run recovery
    await engine.tick();

    const result = await engine.getExecution(execution.runId);
    expect(result?.status).toBe('completed');
    // Activity should have been re-executed
    expect(executionCount).toBe(1);
  });

  it('should preserve completed activities after crash', async () => {
    const storage = new InMemoryStorage();
    const executionLog: string[] = [];

    const activity1 = defineActivity({
      name: 'step1',
      execute: async () => {
        executionLog.push('step1');
        return { step1: 'done' };
      },
    });

    const activity2 = defineActivity({
      name: 'step2',
      execute: async () => {
        executionLog.push('step2');
        return { step2: 'done' };
      },
    });

    const workflow = defineWorkflow({
      name: 'twoStep',
      activities: [activity1, activity2],
    });

    // First engine - complete step 1
    let engine = await WorkflowEngine.create({
      storage,
      runtimeContext: () => ({ isConnected: true }),
    });
    engine.registerWorkflow(workflow);

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick(); // Complete step 1

    expect(executionLog).toEqual(['step1']);

    // Verify state
    let result = await engine.getExecution(execution.runId);
    expect(result?.state.step1).toBe('done');
    expect(result?.currentActivityName).toBe('step2');

    // "Crash" and restart
    engine = await simulateCrashAndRestart(storage, [workflow]);

    // Clear log to verify step1 not re-executed
    executionLog.length = 0;

    // Continue processing
    await engine.tick();

    // Step 1 should NOT have been re-executed
    expect(executionLog).toEqual(['step2']);

    result = await engine.getExecution(execution.runId);
    expect(result?.status).toBe('completed');
    expect(result?.state).toMatchObject({ step1: 'done', step2: 'done' });
  });

  it('should recover multiple in-flight workflows', async () => {
    const storage = new InMemoryStorage();

    const activity = defineActivity({
      name: 'simple',
      execute: async (ctx) => ({ id: ctx.input.id }),
    });

    const workflow = defineWorkflow({
      name: 'multi',
      activities: [activity],
    });

    let engine = await WorkflowEngine.create({
      storage,
      runtimeContext: () => ({ isConnected: true }),
    });
    engine.registerWorkflow(workflow);

    // Start 5 workflows
    const executions = [];
    for (let i = 0; i < 5; i++) {
      executions.push(await engine.start(workflow, { input: { id: i } }));
    }

    // "Crash" before any complete
    engine = await simulateCrashAndRestart(storage, [workflow]);

    // Process all
    for (let i = 0; i < 10; i++) {
      await engine.tick();
    }

    // All should have completed
    for (const exec of executions) {
      const result = await engine.getExecution(exec.runId);
      expect(result?.status).toBe('completed');
    }
  });

  it('should fail task if max attempts exceeded during recovery', async () => {
    const storage = new InMemoryStorage();

    const activity = defineActivity({
      name: 'maxedOut',
      execute: async () => {
        throw new Error('Always fails');
      },
      options: { retry: { maximumAttempts: 3 } },
    });

    const workflow = defineWorkflow({
      name: 'maxAttempts',
      activities: [activity],
    });

    let engine = await WorkflowEngine.create({
      storage,
      runtimeContext: () => ({ isConnected: true }),
    });
    engine.registerWorkflow(workflow);

    const execution = await engine.start(workflow, { input: {} });

    // Simulate: Task was active with attempts already at max
    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    await storage.saveActivityTask({
      ...tasks[0],
      status: 'active',
      attempts: 3, // Already at max
    });

    // "Crash" and restart
    engine = await simulateCrashAndRestart(storage, [workflow]);

    // Recovery tick should fail the task
    await engine.tick();

    const result = await engine.getExecution(execution.runId);
    expect(result?.status).toBe('failed');

    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
  });
});
```

### 3.4 Background Processing Integration

**File:** `tests/integration/BackgroundProcessing.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from '../../src/core/WorkflowEngine';
import { InMemoryStorage } from '../../src/core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from '../../src';
import { sleep } from '../utils/testHelpers';

describe('Background Processing Integration', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  describe('Lifespan-constrained execution', () => {
    it('should stop processing before lifespan expires', async () => {
      let processedCount = 0;

      const activity = defineActivity({
        name: 'quick',
        execute: async () => {
          processedCount++;
          await sleep(20);
          return { processed: processedCount };
        },
        options: { startToCloseTimeout: 100 },
      });

      const workflow = defineWorkflow({
        name: 'background',
        activities: [activity],
      });

      const engine = await WorkflowEngine.create({
        storage,
        runtimeContext: () => ({ isConnected: true }),
      });
      engine.registerWorkflow(workflow);

      // Create many workflows
      for (let i = 0; i < 20; i++) {
        await engine.start(workflow, { input: { i } });
      }

      // Run with limited lifespan
      const startTime = Date.now();
      await engine.start({ lifespan: 200 });
      const elapsed = Date.now() - startTime;

      // Should have stopped on time
      expect(elapsed).toBeLessThan(300);

      // Should have processed some but not all
      expect(processedCount).toBeGreaterThan(0);
      expect(processedCount).toBeLessThan(20);
    });

    it('should skip activities with timeout exceeding remaining lifespan', async () => {
      let shortExecuted = false;
      let longExecuted = false;

      const shortActivity = defineActivity({
        name: 'short',
        execute: async () => {
          shortExecuted = true;
          await sleep(10);
          return {};
        },
        options: { startToCloseTimeout: 50 },
      });

      const longActivity = defineActivity({
        name: 'long',
        execute: async () => {
          longExecuted = true;
          await sleep(10);
          return {};
        },
        options: { startToCloseTimeout: 5000 },
      });

      const shortWorkflow = defineWorkflow({
        name: 'short',
        activities: [shortActivity],
      });

      const longWorkflow = defineWorkflow({
        name: 'long',
        activities: [longActivity],
      });

      const engine = await WorkflowEngine.create({
        storage,
        runtimeContext: () => ({ isConnected: true }),
      });
      engine.registerWorkflow(shortWorkflow);
      engine.registerWorkflow(longWorkflow);

      await engine.start(shortWorkflow, { input: {} });
      await engine.start(longWorkflow, { input: {} });

      // Very short lifespan
      await engine.start({ lifespan: 200 });

      // Short activity should have run
      expect(shortExecuted).toBe(true);
      // Long activity should have been skipped (timeout > lifespan)
      expect(longExecuted).toBe(false);
    });

    it('should prioritize high-priority activities in limited time', async () => {
      const executionOrder: number[] = [];

      const createPriorityActivity = (priority: number) =>
        defineActivity({
          name: `priority${priority}`,
          execute: async () => {
            executionOrder.push(priority);
            await sleep(10);
            return { priority };
          },
          options: {
            priority,
            startToCloseTimeout: 50,
          },
        });

      const workflows = [1, 5, 10, 2, 8].map((p) =>
        defineWorkflow({
          name: `workflow${p}`,
          activities: [createPriorityActivity(p)],
        })
      );

      const engine = await WorkflowEngine.create({
        storage,
        runtimeContext: () => ({ isConnected: true }),
      });

      for (const workflow of workflows) {
        engine.registerWorkflow(workflow);
        await engine.start(workflow, { input: {} });
      }

      // Limited time - may not complete all
      await engine.start({ lifespan: 100 });

      // Higher priorities should have executed first
      if (executionOrder.length >= 2) {
        expect(executionOrder[0]).toBe(10);
        expect(executionOrder[1]).toBe(8);
      }
    });
  });

  describe('Simulated background task scenario', () => {
    it('should simulate iOS/Android background fetch behavior', async () => {
      /**
       * This test simulates a realistic background fetch scenario:
       * 1. App has queued work during foreground operation
       * 2. OS grants ~15-30 seconds of background execution time
       * 3. Engine processes what it can within that window
       * 4. Remaining work persists for next opportunity
       */

      const processedIds: number[] = [];

      const syncActivity = defineActivity({
        name: 'syncItem',
        execute: async (ctx) => {
          processedIds.push(ctx.input.itemId);
          // Simulate API call
          await sleep(50);
          return { synced: true, itemId: ctx.input.itemId };
        },
        options: { startToCloseTimeout: 1000 },
      });

      const syncWorkflow = defineWorkflow({
        name: 'sync',
        activities: [syncActivity],
      });

      // Simulate: Queue built up during foreground
      const engine = await WorkflowEngine.create({
        storage,
        runtimeContext: () => ({ isConnected: true }),
      });
      engine.registerWorkflow(syncWorkflow);

      // Queue 10 items during "foreground"
      for (let i = 0; i < 10; i++) {
        await engine.start(syncWorkflow, { input: { itemId: i } });
      }

      // Simulate background fetch (typically 15-30s, using 500ms for test)
      const backgroundLifespan = 500;
      await engine.start({ lifespan: backgroundLifespan });

      // Some but not all should have processed
      expect(processedIds.length).toBeGreaterThan(0);
      expect(processedIds.length).toBeLessThan(10);

      // Check remaining workflows still pending
      const pendingExecutions = await engine.getExecutionsByStatus('running');
      expect(pendingExecutions.length).toBe(10 - processedIds.length);

      // Simulate next background fetch opportunity
      await engine.start({ lifespan: backgroundLifespan });

      // More should have processed
      expect(processedIds.length).toBeGreaterThan(5);

      // Eventually all complete
      await engine.start({ lifespan: 2000 });
      expect(processedIds.length).toBe(10);

      const completedExecutions = await engine.getExecutionsByStatus('completed');
      expect(completedExecutions.length).toBe(10);
    });
  });
});
```

---

## Phase 4: React Hooks Tests

**File:** `src/adapters/expo/hooks/useExecution.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react-hooks';
import { useExecution } from './index';
import { WorkflowEngine } from '../../../core/WorkflowEngine';
import { InMemoryStorage } from '../../../core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from '../../../core/definitions';

describe('useExecution', () => {
  let engine: WorkflowEngine;
  let workflow: ReturnType<typeof defineWorkflow>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      runtimeContext: () => ({ isConnected: true }),
    });

    workflow = defineWorkflow({
      name: 'test',
      activities: [
        defineActivity({
          name: 'activity',
          execute: async () => ({ done: true }),
        }),
      ],
    });

    engine.registerWorkflow(workflow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return null for non-existent runId', async () => {
    const { result } = renderHook(() => useExecution(engine, 'non-existent'));

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('should return execution data for valid runId', async () => {
    const execution = await engine.start(workflow, { input: { test: true } });

    const { result } = renderHook(() => useExecution(engine, execution.runId));

    await waitFor(() => {
      expect(result.current?.runId).toBe(execution.runId);
      expect(result.current?.status).toBe('running');
      expect(result.current?.input.test).toBe(true);
    });
  });

  it('should update when execution status changes (via polling)', async () => {
    const execution = await engine.start(workflow, { input: {} });

    const { result } = renderHook(() => useExecution(engine, execution.runId));

    await waitFor(() => {
      expect(result.current?.status).toBe('running');
    });

    // Complete the workflow
    await engine.tick();

    // Advance timer past polling interval (500ms)
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await waitFor(() => {
      expect(result.current?.status).toBe('completed');
    });
  });

  it('should cleanup polling on unmount', async () => {
    const execution = await engine.start(workflow, { input: {} });
    const getExecutionSpy = vi.spyOn(engine, 'getExecution');

    const { unmount } = renderHook(() => useExecution(engine, execution.runId));

    // Wait for initial fetch
    await waitFor(() => {
      expect(getExecutionSpy).toHaveBeenCalled();
    });

    const callCountAtUnmount = getExecutionSpy.mock.calls.length;

    unmount();

    // Advance time significantly
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Should not have made additional calls
    expect(getExecutionSpy.mock.calls.length).toBe(callCountAtUnmount);
  });

  it('should handle runId changes', async () => {
    const execution1 = await engine.start(workflow, { input: { id: 1 } });
    const execution2 = await engine.start(workflow, { input: { id: 2 } });

    const { result, rerender } = renderHook(
      ({ runId }) => useExecution(engine, runId),
      { initialProps: { runId: execution1.runId } }
    );

    await waitFor(() => {
      expect(result.current?.input.id).toBe(1);
    });

    rerender({ runId: execution2.runId });

    await waitFor(() => {
      expect(result.current?.input.id).toBe(2);
    });
  });
});
```

**File:** `src/adapters/expo/hooks/useWorkflowStarter.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react-hooks';
import { useWorkflowStarter } from './index';
import { WorkflowEngine } from '../../../core/WorkflowEngine';
import { InMemoryStorage } from '../../../core/storage/InMemoryStorage';
import { defineWorkflow, defineActivity } from '../../../core/definitions';

describe('useWorkflowStarter', () => {
  let engine: WorkflowEngine;
  let workflow: ReturnType<typeof defineWorkflow>;

  beforeEach(async () => {
    engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      runtimeContext: () => ({ isConnected: true }),
    });

    workflow = defineWorkflow({
      name: 'test',
      activities: [
        defineActivity({
          name: 'activity',
          execute: async () => ({ done: true }),
        }),
      ],
    });

    engine.registerWorkflow(workflow);
  });

  it('should provide start function', () => {
    const { result } = renderHook(() => useWorkflowStarter(engine));

    expect(typeof result.current.start).toBe('function');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should track loading state during start', async () => {
    const { result } = renderHook(() => useWorkflowStarter(engine));

    expect(result.current.isLoading).toBe(false);

    let startPromise: Promise<any>;
    act(() => {
      startPromise = result.current.start(workflow, { input: {} });
    });

    // Should be loading
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await startPromise;
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should return execution on success', async () => {
    const { result } = renderHook(() => useWorkflowStarter(engine));

    let execution: any;
    await act(async () => {
      execution = await result.current.start(workflow, {
        input: { test: 'data' },
      });
    });

    expect(execution?.runId).toBeDefined();
    expect(result.current.error).toBeNull();
  });

  it('should track error state on failure', async () => {
    const unregisteredWorkflow = defineWorkflow({
      name: 'unregistered',
      activities: [
        defineActivity({
          name: 'a',
          execute: async () => ({}),
        }),
      ],
    });

    // Don't register it

    const { result } = renderHook(() => useWorkflowStarter(engine));

    await act(async () => {
      try {
        await result.current.start(unregisteredWorkflow, { input: {} });
      } catch (e) {
        // Expected
      }
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.isLoading).toBe(false);
  });

  it('should clear error on successful start after failure', async () => {
    const { result } = renderHook(() => useWorkflowStarter(engine));

    // First, cause an error
    const badWorkflow = defineWorkflow({
      name: 'bad',
      activities: [
        defineActivity({ name: 'x', execute: async () => ({}) }),
      ],
    });

    await act(async () => {
      try {
        await result.current.start(badWorkflow, { input: {} });
      } catch (e) {}
    });

    expect(result.current.error).toBeTruthy();

    // Now succeed
    await act(async () => {
      await result.current.start(workflow, { input: {} });
    });

    expect(result.current.error).toBeNull();
  });
});
```

**File:** `src/adapters/expo/hooks/useEngineRunner.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react-hooks';
import { useEngineRunner } from './index';
import { WorkflowEngine } from '../../../core/WorkflowEngine';
import { InMemoryStorage } from '../../../core/storage/InMemoryStorage';

describe('useEngineRunner', () => {
  let engine: WorkflowEngine;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      runtimeContext: () => ({ isConnected: true }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should run tick loop when enabled', async () => {
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined);

    renderHook(() => useEngineRunner(engine, true));

    // Advance past initial tick and interval
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(tickSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('should not run tick loop when disabled', async () => {
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined);

    renderHook(() => useEngineRunner(engine, false));

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('should stop tick loop when disabled after being enabled', async () => {
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ enabled }) => useEngineRunner(engine, enabled),
      { initialProps: { enabled: true } }
    );

    // Let it tick a few times
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const countWhenEnabled = tickSpy.mock.calls.length;

    // Disable
    rerender({ enabled: false });

    // Clear and advance more
    tickSpy.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Should not have ticked while disabled
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('should cleanup on unmount', async () => {
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined);

    const { unmount } = renderHook(() => useEngineRunner(engine, true));

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    unmount();

    tickSpy.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Should not have ticked after unmount
    expect(tickSpy).not.toHaveBeenCalled();
  });
});
```

**Note:** Additional hook tests for `useDeadLetters`, `useExecutionsByStatus`, `usePendingActivityCount`, and `useExecutionStats` should follow similar patterns.

---

## Phase 5: Example App & E2E Tests

### 5.1 Example App Structure

```
apps/example/
├── app/
│   ├── _layout.tsx           # Root layout with navigation
│   ├── index.tsx             # Home screen - workflow launcher
│   ├── workflows.tsx         # Active/completed workflows list
│   ├── workflow/[runId].tsx  # Single workflow detail view
│   ├── dead-letters.tsx      # Dead letter queue viewer
│   └── settings.tsx          # Network simulation, storage controls
├── workflows/
│   ├── photo/
│   │   ├── workflow.ts       # Photo workflow definition
│   │   └── activities.ts     # Photo activities
│   └── sync/
│       ├── workflow.ts       # Sync workflow definition
│       └── activities.ts     # Sync activities
├── components/
│   ├── WorkflowCard.tsx      # Workflow list item
│   ├── ActivityProgress.tsx  # Activity step indicator
│   ├── NetworkToggle.tsx     # Airplane mode simulator
│   └── StateInspector.tsx    # JSON state viewer
├── contexts/
│   └── EngineContext.tsx     # WorkflowEngine provider
├── e2e/
│   ├── photo-workflow.test.ts
│   ├── offline-handling.test.ts
│   └── background-processing.test.ts
├── app.json
├── package.json
└── README.md
```

### 5.2 Example App Package Configuration

```json
// apps/example/package.json
{
  "name": "@hopdrive/workflow-example",
  "private": true,
  "version": "0.1.0",
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web",
    "test:e2e": "maestro test e2e/"
  },
  "dependencies": {
    "@hopdrive/react-native-workflow": "workspace:*",
    "expo": "~50.0.0",
    "expo-router": "~3.4.0",
    "expo-sqlite": "~13.0.0",
    "expo-background-fetch": "~11.0.0",
    "expo-task-manager": "~11.0.0",
    "react": "18.2.0",
    "react-native": "0.73.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 5.3 E2E Test Configuration (Maestro)

**File:** `apps/example/e2e/photo-workflow.yaml`

```yaml
appId: com.hopdrive.workflowexample
---
- launchApp

- tapOn: "Start Photo Workflow"

- assertVisible: "capturePhoto"
- assertVisible: "running"

# Wait for workflow to complete
- extendedWaitUntil:
    visible: "completed"
    timeout: 10000

- assertVisible: "completed"
- assertVisible: "s3Key"
```

**File:** `apps/example/e2e/offline-handling.yaml`

```yaml
appId: com.hopdrive.workflowexample
---
- launchApp

# Enable airplane mode simulation
- tapOn: "Settings"
- tapOn: "Simulate Offline"

- tapOn: "Back"
- tapOn: "Start Photo Workflow"

# First activity completes (doesn't need network)
- assertVisible: "capturePhoto"
- extendedWaitUntil:
    visible: "uploadPhoto"
    timeout: 5000

# Should be stuck waiting for network
- assertVisible: "waiting for network"

# Disable airplane mode
- tapOn: "Settings"
- tapOn: "Simulate Offline"

- tapOn: "Back"

# Should resume and complete
- extendedWaitUntil:
    visible: "completed"
    timeout: 15000
```

### 5.4 Manual Testing Guide

**File:** `apps/example/MANUAL_TESTING.md`

```markdown
# Manual Testing Guide

These scenarios are difficult to automate and should be tested manually.

## 1. Kill App Mid-Activity

**Steps:**
1. Start a photo workflow
2. Wait for uploadPhoto to begin (visible in UI)
3. Force-kill the app (swipe away on iOS/Android)
4. Reopen the app

**Expected:**
- Workflow should resume from uploadPhoto
- Activity should re-execute (idempotent behavior)
- Workflow should eventually complete

## 2. Device Reboot

**Steps:**
1. Start several workflows
2. Reboot the device
3. Reopen the app

**Expected:**
- All workflows should be present
- Running workflows should resume
- Completed workflows should remain completed

## 3. Real Background Fetch (iOS)

**Steps:**
1. Start a workflow that will take several activities
2. Background the app immediately
3. Wait 15+ minutes
4. Foreground the app

**Expected:**
- Some progress should have been made
- Check background task logs in Xcode

## 4. Real Background Fetch (Android)

**Steps:**
1. Start a workflow
2. Background the app
3. Wait for WorkManager to trigger
4. Foreground the app

**Expected:**
- Progress made while backgrounded
- Check adb logcat for background execution logs

## 5. Low Battery Behavior (if implemented)

**Steps:**
1. Drain device to < 20% battery
2. Start a non-urgent workflow
3. Observe behavior

**Expected:**
- If battery-aware conditions implemented, low-priority work should be deferred

## 6. Memory Pressure

**Steps:**
1. Start a workflow with large payload (use Settings > "Large Payload Test")
2. Open many other apps to create memory pressure
3. Return to workflow app

**Expected:**
- Workflow state should persist
- No crashes or data loss
```

---

## Test Utilities & Fixtures

### Test Helpers

**File:** `packages/react-native-workflow/tests/utils/testHelpers.ts`

```typescript
import { WorkflowEngine, WorkflowExecution } from '../../src';
import { InMemoryStorage } from '../../src/core/storage/InMemoryStorage';
import { defineActivity, ActivityOptions } from '../../src/core/definitions';

/**
 * Create a test engine with common defaults
 */
export async function createTestEngine(
  options?: Partial<{
    storage: InMemoryStorage;
    runtimeContext: () => Record<string, any>;
  }>
): Promise<WorkflowEngine> {
  return WorkflowEngine.create({
    storage: options?.storage ?? new InMemoryStorage(),
    runtimeContext: options?.runtimeContext ?? (() => ({ isConnected: true })),
  });
}

/**
 * Run engine until workflow completes, fails, or times out
 */
export async function runUntilComplete(
  engine: WorkflowEngine,
  runId: string,
  options?: { timeout?: number; tickInterval?: number }
): Promise<WorkflowExecution> {
  const { timeout = 5000, tickInterval = 10 } = options ?? {};
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await engine.tick();
    const execution = await engine.getExecution(runId);

    if (!execution) {
      throw new Error(`Execution ${runId} not found`);
    }

    if (execution.status !== 'running') {
      return execution;
    }

    await sleep(tickInterval);
  }

  throw new Error(`Workflow ${runId} did not complete within ${timeout}ms`);
}

/**
 * Create a simple test activity
 */
export function createTestActivity(
  name: string,
  options?: {
    execute?: (ctx: any) => Promise<any>;
    shouldFail?: boolean;
    failUntilAttempt?: number;
    delay?: number;
    activityOptions?: Partial<ActivityOptions>;
  }
) {
  const {
    execute,
    shouldFail = false,
    failUntilAttempt = 0,
    delay = 0,
    activityOptions = {},
  } = options ?? {};

  return defineActivity({
    name,
    execute: async (ctx) => {
      if (delay) await sleep(delay);

      if (shouldFail) {
        throw new Error(`${name} intentionally failed`);
      }

      if (failUntilAttempt > 0 && ctx.attempt < failUntilAttempt) {
        throw new Error(`${name} failed on attempt ${ctx.attempt}`);
      }

      if (execute) {
        return execute(ctx);
      }

      return { [name]: 'done', attempt: ctx.attempt };
    },
    options: activityOptions,
  });
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options ?? {};
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}
```

### Test Fixtures

**File:** `packages/react-native-workflow/tests/fixtures/workflows.ts`

```typescript
import { defineWorkflow, defineActivity, conditions } from '../../src';
import { createTestActivity } from '../utils/testHelpers';

/**
 * Single activity workflow for basic tests
 */
export const singleActivityWorkflow = defineWorkflow({
  name: 'single',
  activities: [
    defineActivity({
      name: 'only',
      execute: async () => ({ result: 'done' }),
    }),
  ],
});

/**
 * Three-stage workflow for sequential testing
 */
export const threeStageWorkflow = defineWorkflow({
  name: 'threeStage',
  activities: [
    createTestActivity('stage1'),
    createTestActivity('stage2'),
    createTestActivity('stage3'),
  ],
});

/**
 * Workflow with network-dependent activity
 */
export const networkDependentWorkflow = defineWorkflow({
  name: 'networkDependent',
  activities: [
    createTestActivity('offline'),
    defineActivity({
      name: 'online',
      execute: async (ctx) => {
        if (!ctx.isConnected) throw new Error('No network');
        return { synced: true };
      },
      options: { runWhen: conditions.whenConnected },
    }),
    createTestActivity('final'),
  ],
});

/**
 * Create a workflow that fails on specific attempts
 */
export function createRetryWorkflow(succeedOnAttempt: number) {
  return defineWorkflow({
    name: `retry-${succeedOnAttempt}`,
    activities: [
      createTestActivity('flaky', {
        failUntilAttempt: succeedOnAttempt,
        activityOptions: {
          retry: { maximumAttempts: succeedOnAttempt + 2, initialInterval: 10 },
        },
      }),
    ],
  });
}

/**
 * Workflow with all callback hooks for callback testing
 */
export function createCallbackTestWorkflow(callbacks: {
  onComplete?: (runId: string, state: any) => Promise<void>;
  onFailed?: (runId: string, state: any, error: Error) => Promise<void>;
  onCancelled?: (runId: string, state: any) => Promise<void>;
}) {
  return defineWorkflow({
    name: 'callbackTest',
    activities: [createTestActivity('activity')],
    ...callbacks,
  });
}
```

---

## CI/CD Configuration

### GitHub Actions CI

**File:** `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm run test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        if: matrix.node-version == '20.x'
        with:
          files: ./packages/react-native-workflow/coverage/lcov.info
          fail_ci_if_error: false

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run integration tests
        run: npm run test:integration

  build:
    runs-on: ubuntu-latest
    needs: [lint-and-typecheck, unit-tests]

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build package
        run: npm run build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: packages/react-native-workflow/dist/
```

### GitHub Actions Release

**File:** `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Publish to npm
        run: npm publish --workspace=packages/react-native-workflow --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          generate_release_notes: true
```

---

## Implementation Checklist

### Phase 1: Foundation
- [ ] Create monorepo structure with workspaces
- [ ] Add MIT LICENSE file
- [ ] Configure Vitest (replace Jest)
- [ ] Set up Husky + pre-commit hooks
- [ ] Configure GitHub Actions CI
- [ ] Implement AbortSignal cancellation propagation
- [ ] Add cancellation propagation tests

### Phase 2: Unit Test Expansion
- [ ] Create test utilities and fixtures
- [ ] Add timeout handling tests (~6 tests)
- [ ] Add callback error handling tests (~12 tests)
- [ ] Add state threading tests (~8 tests)
- [ ] Add concurrency tests (~5 tests)
- [ ] Expand lifecycle tests (~6 tests)
- [ ] Add validation tests (~10 tests)

### Phase 3: Integration Tests
- [ ] Add PhotoWorkflow integration tests
- [ ] Add MultiWorkflow integration tests
- [ ] Add CrashRecovery integration tests
- [ ] Add BackgroundProcessing integration tests

### Phase 4: React Hooks Tests
- [ ] Add useExecution tests
- [ ] Add useExecutionsByStatus tests
- [ ] Add useDeadLetters tests
- [ ] Add usePendingActivityCount tests
- [ ] Add useExecutionStats tests
- [ ] Add useWorkflowStarter tests
- [ ] Add useEngineRunner tests

### Phase 5: Example App
- [ ] Create example app structure
- [ ] Implement EngineContext provider
- [ ] Implement workflow launcher screen
- [ ] Implement workflows list screen
- [ ] Implement workflow detail screen
- [ ] Implement dead letters screen
- [ ] Implement settings/network simulation
- [ ] Add Maestro E2E tests
- [ ] Write manual testing guide

### Final
- [ ] Review coverage thresholds
- [ ] Update README with testing documentation
- [ ] Create CONTRIBUTING.md with test requirements
- [ ] First release candidate

---

## Test Count Summary

| Category | Existing | New | Total |
|----------|----------|-----|-------|
| Core Engine | 21 | 0 | 21 |
| Lifecycle | 11 | 6 | 17 |
| Retry | 13 | 0 | 13 |
| Gating | 21 | 0 | 21 |
| Dead Letter | 15 | 0 | 15 |
| SQLite Storage | 54 | 0 | 54 |
| **Timeout** | 0 | 6 | 6 |
| **Callbacks** | 0 | 12 | 12 |
| **State Threading** | 0 | 10 | 10 |
| **Concurrency** | 0 | 8 | 8 |
| **Cancellation** | 0 | 6 | 6 |
| **Validation** | 0 | 10 | 10 |
| **Integration** | 0 | 20 | 20 |
| **React Hooks** | 0 | 25 | 25 |
| **Total** | **134** | **103** | **~237** |

---

*Document Version: 2.0*
*Last Updated: January 2025*
*Target: @hopdrive/react-native-workflow v0.1.0*
