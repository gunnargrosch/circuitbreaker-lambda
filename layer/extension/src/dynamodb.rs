use aws_sdk_dynamodb::types::AttributeValue;
use std::collections::HashMap;
use tokio::sync::OnceCell;

use crate::types::{CircuitBreakerState, CircuitState, SCHEMA_VERSION};

pub struct DynamoDBProvider {
    client: OnceCell<aws_sdk_dynamodb::Client>,
    table_name: String,
}

impl DynamoDBProvider {
    pub fn new(table_name: String) -> Self {
        Self {
            client: OnceCell::new(),
            table_name,
        }
    }

    async fn get_client(&self) -> &aws_sdk_dynamodb::Client {
        self.client
            .get_or_init(|| async {
                let sdk_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
                aws_sdk_dynamodb::Client::new(&sdk_config)
            })
            .await
    }

    pub async fn get_state(&self, circuit_id: &str) -> Result<Option<CircuitBreakerState>, String> {
        let client = self.get_client().await;
        let result = client
            .get_item()
            .table_name(&self.table_name)
            .key("id", AttributeValue::S(circuit_id.to_string()))
            .send()
            .await
            .map_err(|e| format!("DynamoDB GetItem failed for circuit \"{circuit_id}\": {e}"))?;

        Ok(result.item().map(parse_item))
    }

    pub async fn save_state(&self, circuit_id: &str, state: &CircuitBreakerState) -> Result<(), String> {
        let client = self.get_client().await;
        client
            .update_item()
            .table_name(&self.table_name)
            .key("id", AttributeValue::S(circuit_id.to_string()))
            .update_expression(
                "SET circuitState = :st, failureCount = :fc, successCount = :sc, \
                 nextAttempt = :na, lastFailureTime = :lf, consecutiveOpens = :co, \
                 stateTimestamp = :ts, schemaVersion = :sv",
            )
            .expression_attribute_values(":st", AttributeValue::S(state.circuit_state.to_string()))
            .expression_attribute_values(":fc", AttributeValue::N(state.failure_count.to_string()))
            .expression_attribute_values(":sc", AttributeValue::N(state.success_count.to_string()))
            .expression_attribute_values(":na", AttributeValue::N(state.next_attempt.to_string()))
            .expression_attribute_values(":lf", AttributeValue::N(state.last_failure_time.to_string()))
            .expression_attribute_values(":co", AttributeValue::N(state.consecutive_opens.to_string()))
            .expression_attribute_values(":ts", AttributeValue::N(state.state_timestamp.to_string()))
            .expression_attribute_values(":sv", AttributeValue::N(state.schema_version.to_string()))
            .send()
            .await
            .map_err(|e| format!("DynamoDB UpdateItem failed for circuit \"{circuit_id}\": {e}"))?;

        Ok(())
    }
}

fn parse_item(item: &HashMap<String, AttributeValue>) -> CircuitBreakerState {
    CircuitBreakerState {
        circuit_state: item
            .get("circuitState")
            .and_then(|v| v.as_s().ok())
            .map(|s| match s.as_str() {
                "OPEN" => CircuitState::Open,
                "HALF" => CircuitState::Half,
                _ => CircuitState::Closed,
            })
            .unwrap_or(CircuitState::Closed),
        failure_count: get_num(item, "failureCount", 0),
        success_count: get_num(item, "successCount", 0),
        next_attempt: get_num_u64(item, "nextAttempt", 0),
        last_failure_time: get_num_u64(item, "lastFailureTime", 0),
        consecutive_opens: get_num(item, "consecutiveOpens", 0),
        state_timestamp: get_num_u64(item, "stateTimestamp", 0),
        schema_version: get_num(item, "schemaVersion", SCHEMA_VERSION),
    }
}

fn get_num(item: &HashMap<String, AttributeValue>, key: &str, default: u32) -> u32 {
    item.get(key)
        .and_then(|v| v.as_n().ok())
        .and_then(|n| n.parse().ok())
        .unwrap_or(default)
}

fn get_num_u64(item: &HashMap<String, AttributeValue>, key: &str, default: u64) -> u64 {
    item.get(key)
        .and_then(|v| v.as_n().ok())
        .and_then(|n| n.parse().ok())
        .unwrap_or(default)
}
