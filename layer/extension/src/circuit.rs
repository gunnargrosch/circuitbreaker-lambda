use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::warn;

use crate::dynamodb::DynamoDBProvider;
use crate::types::{
    CheckResponse, CircuitBreakerState, CircuitConfig, CircuitState, RecordResponse, now_ms,
};

/// Maximum number of circuit IDs cached in memory. Prevents unbounded growth
/// from dynamic/per-request circuit IDs. When the limit is reached, a single
/// arbitrary entry is evicted (whichever the HashMap iterator yields first,
/// which is non-deterministic due to hash randomization).
const MAX_CACHED_CIRCUITS: usize = 1024;

/// Manages circuit breaker state for multiple circuit IDs.
pub struct CircuitManager {
    provider: Arc<DynamoDBProvider>,
    config: CircuitConfig,
    /// In-memory cache for state between check() and record_*() within a single
    /// request. Cleared at the start of each check() call for the given circuit.
    /// Bounded to MAX_CACHED_CIRCUITS entries.
    states: Arc<Mutex<HashMap<String, CircuitBreakerState>>>,
}

impl CircuitManager {
    pub fn new(provider: DynamoDBProvider, config: CircuitConfig) -> Self {
        Self {
            provider: Arc::new(provider),
            config,
            states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check whether the circuit allows a request through.
    /// State transitions are returned in the `transition` field of the response
    /// so the calling function can log them (extension stdout is not reliably
    /// captured by CloudWatch during INVOKE).
    pub async fn check(&self, circuit_id: &str) -> CheckResponse {
        {
            let mut states = self.states.lock().await;
            states.remove(circuit_id);
        }

        let mut state = self.load_state(circuit_id).await;
        self.apply_window_reset(&mut state);

        if state.circuit_state == CircuitState::Open {
            if state.next_attempt <= now_ms() {
                state.circuit_state = CircuitState::Half;
                state.success_count = 0;
                self.persist_state(circuit_id, &state).await;
                self.cache_state(circuit_id, state.clone()).await;
                return CheckResponse {
                    allowed: true,
                    state: state.circuit_state.to_string(),
                    transition: Some("OPEN -> HALF".to_string()),
                };
            }
            return CheckResponse {
                allowed: false,
                state: state.circuit_state.to_string(),
                transition: None,
            };
        }

        self.cache_state(circuit_id, state.clone()).await;
        CheckResponse {
            allowed: true,
            state: state.circuit_state.to_string(),
            transition: None,
        }
    }

    /// Record a successful request.
    pub async fn record_success(&self, circuit_id: &str) -> RecordResponse {
        let mut state = self.get_cached_or_load(circuit_id).await;
        let mut transition = None;

        if state.circuit_state == CircuitState::Half {
            state.success_count += 1;
            if state.success_count >= self.config.success_threshold {
                state.circuit_state = CircuitState::Closed;
                state.success_count = 0;
                state.failure_count = 0;
                state.consecutive_opens = 0;
                transition = Some("HALF -> CLOSED".to_string());
            }
        }

        state.state_timestamp = now_ms();
        self.persist_state(circuit_id, &state).await;
        self.cache_state(circuit_id, state.clone()).await;

        RecordResponse {
            state: state.circuit_state.to_string(),
            transition,
        }
    }

    /// Record a failed request.
    pub async fn record_failure(&self, circuit_id: &str) -> RecordResponse {
        let mut state = self.get_cached_or_load(circuit_id).await;
        let mut transition = None;

        state.failure_count += 1;
        state.last_failure_time = now_ms();

        if state.circuit_state == CircuitState::Half {
            let from = "HALF";
            self.to_open(&mut state, true);
            transition = Some(format!("{from} -> OPEN"));
        } else if state.failure_count >= self.config.failure_threshold {
            let from = state.circuit_state.to_string();
            self.to_open(&mut state, false);
            transition = Some(format!("{from} -> OPEN"));
        }

        state.state_timestamp = now_ms();
        self.persist_state(circuit_id, &state).await;
        self.cache_state(circuit_id, state.clone()).await;

        RecordResponse {
            state: state.circuit_state.to_string(),
            transition,
        }
    }

    fn to_open(&self, state: &mut CircuitBreakerState, was_half: bool) {
        state.circuit_state = CircuitState::Open;

        if was_half {
            state.consecutive_opens += 1;
        } else {
            state.consecutive_opens = 0;
        }

        let backoff = std::cmp::min(
            self.config.timeout_ms.saturating_mul(2u64.saturating_pow(state.consecutive_opens.min(63))),
            self.config.max_timeout_ms,
        );
        state.next_attempt = now_ms() + backoff;
    }

    fn apply_window_reset(&self, state: &mut CircuitBreakerState) {
        if state.circuit_state == CircuitState::Closed
            && state.last_failure_time > 0
            && now_ms() - state.last_failure_time > self.config.window_duration_ms
        {
            state.failure_count = 0;
        }
    }

    /// Load state from DynamoDB. Returns default (CLOSED) on errors (fail-open).
    async fn load_state(&self, circuit_id: &str) -> CircuitBreakerState {
        match self.provider.get_state(circuit_id).await {
            Ok(Some(state)) => state,
            Ok(None) => CircuitBreakerState::default(),
            Err(e) => {
                warn!(
                    source = "circuitbreaker-lambda",
                    action = "getState",
                    circuit_id = circuit_id,
                    error = %e,
                );
                CircuitBreakerState::default()
            }
        }
    }

    async fn get_cached_or_load(&self, circuit_id: &str) -> CircuitBreakerState {
        let states = self.states.lock().await;
        if let Some(state) = states.get(circuit_id) {
            return state.clone();
        }
        drop(states);
        self.load_state(circuit_id).await
    }

    async fn cache_state(&self, circuit_id: &str, state: CircuitBreakerState) {
        let mut states = self.states.lock().await;
        if states.len() >= MAX_CACHED_CIRCUITS && !states.contains_key(circuit_id) {
            if let Some(key) = states.keys().next().cloned() {
                states.remove(&key);
            }
        }
        states.insert(circuit_id.to_string(), state);
    }

    /// Persist state to DynamoDB. Logs and continues on errors (fail-open).
    async fn persist_state(&self, circuit_id: &str, state: &CircuitBreakerState) {
        if let Err(e) = self.provider.save_state(circuit_id, state).await {
            warn!(
                source = "circuitbreaker-lambda",
                action = "saveState",
                circuit_id = circuit_id,
                error = %e,
            );
        }
    }
}
