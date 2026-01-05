# React

React hooks for integrating endura workflows with React applications. These hooks are platform-agnostic and work with any storage adapter.

## Available Hooks

- `useExecution` - Subscribe to a single workflow execution
- `useExecutionsByStatus` - Get all executions with a specific status
- `useDeadLetters` - Monitor failed workflow tasks
- `usePendingActivityCount` - Track pending activity count
- `useExecutionStats` - Get aggregate execution statistics
- `useWorkflowStarter` - Convenience hook to start workflows
- `useEngineRunner` - Run engine tick loop in foreground

## Usage

```typescript
import { useExecution, useWorkflowStarter } from 'endura/react';
```
