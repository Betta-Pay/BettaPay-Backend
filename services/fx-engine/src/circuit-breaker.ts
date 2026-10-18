/**
 * Per-route circuit breaker registry for upstream FX rate fetches.
 *
 * Each route (an upstream dependency) owns an independent breaker so one
 * failing route cannot open the breaker for the others.
 *
 * States:
 *   CLOSED    — normal operation; consecutive failures are counted.
 *   OPEN      — tripped after the failure threshold; fetches are skipped
 *               until the cooldown expires.
 *   HALF_OPEN — after the cooldown a single probe is allowed.
 *               Success → CLOSED, failure → OPEN (restarts the cooldown).
 */

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

export interface CircuitBreaker {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null; // Unix ms when state became OPEN
  lastTransitionAt: number; // Unix ms of last state change (for observability)
}

export interface CircuitBreakerLog {
  info: (obj: object, msg: string) => void;
}

export interface CircuitBreakerRegistryOptions {
  failureThreshold?: number;
  now?: () => number;
}

export function createCircuitBreakerRegistry(
  opts: CircuitBreakerRegistryOptions = {},
) {
  const failureThreshold =
    opts.failureThreshold ?? CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  const now = opts.now ?? (() => Date.now());
  const breakers = new Map<string, CircuitBreaker>();

  function get(route: string): CircuitBreaker {
    let breaker = breakers.get(route);
    if (!breaker) {
      breaker = {
        state: "CLOSED",
        consecutiveFailures: 0,
        openedAt: null,
        lastTransitionAt: now(),
      };
      breakers.set(route, breaker);
    }
    return breaker;
  }

  function transition(
    route: string,
    newState: CircuitBreakerState,
    log: CircuitBreakerLog,
  ): void {
    const breaker = get(route);
    const prev = breaker.state;
    if (prev === newState) return;

    breaker.state = newState;
    breaker.lastTransitionAt = now();

    if (newState === "OPEN") {
      breaker.openedAt = now();
    } else if (newState === "CLOSED") {
      breaker.consecutiveFailures = 0;
      breaker.openedAt = null;
    }

    log.info(
      {
        route,
        from: prev,
        to: newState,
        consecutiveFailures: breaker.consecutiveFailures,
      },
      `Circuit breaker transition: ${prev} → ${newState}`,
    );
  }

  return {
    /** Read-only copy of a route's breaker (does not advance OPEN → HALF_OPEN). */
    snapshot(route: string): CircuitBreaker {
      return { ...get(route) };
    },

    /** Current state for a route, advancing OPEN → HALF_OPEN once the cooldown elapsed. */
    getState(route: string, cooldownMs: number): CircuitBreakerState {
      const breaker = get(route);
      if (
        breaker.state === "OPEN" &&
        breaker.openedAt !== null &&
        now() - breaker.openedAt >= cooldownMs
      ) {
        breaker.state = "HALF_OPEN";
        breaker.lastTransitionAt = now();
      }
      return breaker.state;
    },

    recordSuccess(route: string, log: CircuitBreakerLog): void {
      const breaker = get(route);
      breaker.consecutiveFailures = 0;
      if (breaker.state !== "CLOSED") {
        transition(route, "CLOSED", log);
      }
    },

    recordFailure(route: string, log: CircuitBreakerLog): void {
      const breaker = get(route);
      breaker.consecutiveFailures += 1;

      if (
        breaker.state === "HALF_OPEN" ||
        (breaker.state === "CLOSED" &&
          breaker.consecutiveFailures >= failureThreshold)
      ) {
        transition(route, "OPEN", log);
      }
    },

    routes(): string[] {
      return [...breakers.keys()];
    },
  };
}

export type CircuitBreakerRegistry = ReturnType<
  typeof createCircuitBreakerRegistry
>;
