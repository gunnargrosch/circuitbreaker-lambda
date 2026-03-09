use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CircuitState {
    #[serde(rename = "CLOSED")]
    Closed,
    #[serde(rename = "OPEN")]
    Open,
    #[serde(rename = "HALF-OPEN", alias = "HALF")]
    Half,
}

impl std::fmt::Display for CircuitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CircuitState::Closed => write!(f, "CLOSED"),
            CircuitState::Open => write!(f, "OPEN"),
            CircuitState::Half => write!(f, "HALF-OPEN"),
        }
    }
}

/// State record matching the Node.js library's DynamoDB schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitBreakerState {
    pub circuit_state: CircuitState,
    pub failure_count: u32,
    pub success_count: u32,
    pub next_attempt: u64,
    pub last_failure_time: u64,
    pub consecutive_opens: u32,
    pub state_timestamp: u64,
    pub schema_version: u32,
}

impl Default for CircuitBreakerState {
    /// Returns a CLOSED state with the current timestamp.
    /// Note: calls now_ms() — not deterministic. For tests that need a fixed
    /// timestamp, construct the struct directly.
    fn default() -> Self {
        Self {
            circuit_state: CircuitState::Closed,
            failure_count: 0,
            success_count: 0,
            next_attempt: 0,
            last_failure_time: 0,
            consecutive_opens: 0,
            state_timestamp: now_ms(),
            schema_version: SCHEMA_VERSION,
        }
    }
}

/// Circuit breaker configuration from environment variables.
#[derive(Debug, Clone)]
pub struct CircuitConfig {
    pub failure_threshold: u32,
    pub success_threshold: u32,
    pub timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub window_duration_ms: u64,
}

impl Default for CircuitConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            success_threshold: 2,
            timeout_ms: 10000,
            max_timeout_ms: 60000,
            window_duration_ms: 60000,
        }
    }
}

impl CircuitConfig {
    pub fn from_env() -> Self {
        Self {
            failure_threshold: env_u32("CIRCUITBREAKER_FAILURE_THRESHOLD", 5),
            success_threshold: env_u32("CIRCUITBREAKER_SUCCESS_THRESHOLD", 2),
            timeout_ms: env_u64("CIRCUITBREAKER_TIMEOUT_MS", 10000),
            max_timeout_ms: env_u64("CIRCUITBREAKER_MAX_TIMEOUT_MS", 60000),
            window_duration_ms: env_u64("CIRCUITBREAKER_WINDOW_DURATION_MS", 60000),
        }
    }
}

/// HTTP response for the check endpoint.
#[derive(Debug, Serialize)]
pub struct CheckResponse {
    pub allowed: bool,
    pub state: String,
    /// Present when a state transition occurred (e.g., "OPEN -> HALF-OPEN").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<String>,
}

/// HTTP response for record endpoints.
#[derive(Debug, Serialize)]
pub struct RecordResponse {
    pub state: String,
    /// Present when a state transition occurred (e.g., "CLOSED -> OPEN").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<String>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
