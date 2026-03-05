import { CircuitBreaker } from "./index.js";
import type { CircuitBreakerOptions } from "./types.js";

export type { CircuitBreakerOptions, CircuitBreakerState, CircuitState, StateProvider } from "./types.js";
export { CircuitBreaker } from "./index.js";

interface MiddyRequest {
  event: unknown;
  context: Record<string, unknown>;
  response?: unknown;
  error?: unknown;
}

interface MiddyMiddleware {
  before: (request: MiddyRequest) => Promise<unknown>;
  after: (request: MiddyRequest) => Promise<void>;
  onError: (request: MiddyRequest) => Promise<void>;
}

/**
 * Middy middleware that protects the handler with a circuit breaker.
 *
 * - `before`: checks circuit state. If OPEN, short-circuits with `fallback`
 *   response or throws.
 * - `after`: records a successful invocation.
 * - `onError`: records a failed invocation and rethrows the error.
 *
 * Note: each invocation incurs two provider reads (one in check, one in
 * recordSuccess/recordFailure). Set `cacheTtlMs` to reduce this cost.
 *
 * The breaker is created once and reused across warm invocations.
 */
export function circuitBreakerMiddleware(
  options?: CircuitBreakerOptions,
): MiddyMiddleware {
  const { fallback, ...breakerOptions } = options ?? {};
  const breaker = new CircuitBreaker(null, breakerOptions);

  return {
    before: async (request: MiddyRequest) => {
      const allowed = await breaker.check();
      if (!allowed) {
        if (fallback) {
          request.response = await fallback();
          return request.response;
        }
        throw new Error("CircuitBreaker state: OPEN");
      }
    },
    after: async () => {
      await breaker.recordSuccess();
    },
    onError: async (request: MiddyRequest) => {
      await breaker.recordFailure();
      throw request.error;
    },
  };
}
