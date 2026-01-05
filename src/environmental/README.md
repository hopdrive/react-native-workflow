# Environmental

Platform-specific helper implementations for runtime adapters (Clock, Scheduler, Environment) and platform integration utilities.

These are optional helpers that make it easier to implement workflows on specific platforms. The core engine works without them - they provide convenient, production-ready implementations.

## Available Platforms

- **expo/** - Expo/React Native helpers including Clock, Scheduler, Environment providers, background task utilities, and a convenience WorkflowClient

## Future Platforms

Additional platform helpers (web, PWA, etc.) can be added here following the same pattern.

## Usage

```typescript
import { ExpoWorkflowClient, ExpoClock } from 'endura/environmental/expo';
```
