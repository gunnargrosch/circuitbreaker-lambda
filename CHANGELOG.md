# Changelog

## 1.0.0 (2026-03-05)

### Added

- Full TypeScript rewrite with exported type definitions
- Dual CJS/ESM package output via tsup
- **Pluggable `StateProvider` interface** for custom state backends
- **`DynamoDBProvider`** as the default state backend (AWS SDK v3) with contextual error wrapping
- **`MemoryProvider`** for testing and local development
- **`CachedProvider`** wrapper for warm invocation caching (opt-in, reduces DynamoDB reads)
- **Low-level API**: `check()`, `recordSuccess()`, `recordFailure()` for custom integration patterns (middleware, decorators). Pass `null` as request function. Enforced with a guard -- calling `recordSuccess()`/`recordFailure()` without a preceding `check()` throws.
- **Sliding window failure counting** with configurable `windowDuration` -- stale failures auto-reset
- **Exponential backoff** on consecutive HALF->OPEN transitions with configurable `maxTimeout`
- **Immediate reopen on HALF failure** -- single failure in HALF state returns to OPEN
- **Fail-open design** -- state provider errors are caught and logged as structured JSON; requests pass through rather than failing
- **Structured JSON logging** for state transitions (`action: "transition"`), blocked requests (`action: "blocked"`), and provider errors
- **Middy middleware** (`circuitbreaker-lambda/middy`) that wraps the handler with `before`/`after`/`onError` hooks -- circuit is checked before the handler, success/failure recorded after
- **Lambda Layer** with a Rust extension for circuit breaker protection on any managed runtime (Node.js, Python, Java, .NET, Ruby, custom runtimes) via a local HTTP sidecar API, x86_64 and arm64
- `schemaVersion` field in state records for cross-runtime compatibility between npm package and Lambda Layer
- `circuitId` validation -- throws if empty (prevents silent shared-key bugs outside Lambda)
- Warning when `tableName` and `stateProvider` are both set
- Vitest test suite (57 tests) with coverage thresholds
- Flat ESLint config with typescript-eslint strict preset
- Interactive examples with toggleable downstream service for both npm package and Lambda Layer

### Changed

- Migrated from AWS SDK v2 to AWS SDK v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)
- Migrated from prototype-based class to ES class with private members
- Package is now ESM-first (`"type": "module"`) with CJS compatibility via `const { CircuitBreaker } = require("circuitbreaker-lambda")`
- Fixed success threshold check (`>` changed to `>=` for correct behavior)
- Failures accumulate across successes -- only reset via window expiry or circuit close (not on every success)
- Proper error propagation (failures throw instead of returning error objects)
- Minimum Node.js version: 20
- Examples updated to Node.js 24, ESM, and SAM with least-privilege IAM policies

### Removed

- Hard-coupled DynamoDB state management (replaced by StateProvider interface)
- `aws-sdk` v2 dependency
- Old eslint config (`eslint-config-standard` and plugins)
- Serverless Framework example (SAM template remains)
- Node.js < 20 support

## 0.0.1 (2020-10-10)

- Initial release
