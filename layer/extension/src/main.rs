mod circuit;
mod dynamodb;
mod server;
mod types;

use std::env;
use std::sync::Arc;

use tracing::{info, error, warn};

use crate::circuit::CircuitManager;
use crate::dynamodb::DynamoDBProvider;
use crate::types::CircuitConfig;

const DEFAULT_PORT: u16 = 4243;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .init();

    info!(
        source = "circuitbreaker-lambda",
        action = "startup",
        message = "circuitbreaker-lambda extension starting",
    );

    let table_name = env::var("CIRCUITBREAKER_TABLE").unwrap_or_default();
    if table_name.is_empty() {
        error!(
            source = "circuitbreaker-lambda",
            action = "startup",
            message = "CIRCUITBREAKER_TABLE not set",
        );
        std::process::exit(1);
    }

    let port: u16 = env::var("CIRCUITBREAKER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let config = CircuitConfig::from_env();

    info!(
        source = "circuitbreaker-lambda",
        action = "startup",
        port = port,
        table_name = %table_name,
        failure_threshold = config.failure_threshold,
        success_threshold = config.success_threshold,
        timeout_ms = config.timeout_ms,
    );

    let provider = DynamoDBProvider::new(table_name);
    let manager = Arc::new(CircuitManager::new(provider, config));

    let has_runtime_api = env::var("AWS_LAMBDA_RUNTIME_API").is_ok();

    // Start the HTTP server and wait for it to bind before registering.
    // Lambda won't invoke the function until registration completes, so by
    // sequencing server bind -> register, the server is guaranteed to be
    // ready when the handler runs. No readiness file needed.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();

    let server_manager = Arc::clone(&manager);
    tokio::spawn(async move {
        if let Err(e) = server::start_server(port, server_manager, ready_tx).await {
            error!(
                source = "circuitbreaker-lambda",
                action = "server",
                message = format!("server failed: {e}"),
            );
            std::process::exit(1);
        }
    });

    // Wait for the server to bind
    if ready_rx.await.is_err() {
        error!(
            source = "circuitbreaker-lambda",
            action = "startup",
            message = "server failed to start",
        );
        std::process::exit(1);
    }

    // Now register — Lambda will hold INIT until this completes
    match register_extension().await {
        Ok(ext_id) => {
            info!(
                source = "circuitbreaker-lambda",
                action = "registered",
                extension_id = %ext_id,
            );
            extension_event_loop(&ext_id).await;
        }
        Err(e) => {
            if has_runtime_api {
                error!(
                    source = "circuitbreaker-lambda",
                    action = "startup",
                    message = format!("extension registration failed: {e}"),
                );
            } else {
                info!(
                    source = "circuitbreaker-lambda",
                    action = "startup",
                    message = "AWS_LAMBDA_RUNTIME_API not set — running as standalone server",
                );
                // Keep running for local development
                std::future::pending::<()>().await;
            }
        }
    }
}

/// Register with the Lambda Extensions API.
async fn register_extension() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let runtime_api = env::var("AWS_LAMBDA_RUNTIME_API")?;
    let url = format!("http://{runtime_api}/2020-01-01/extension/register");

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("failed to build HTTP client for extension registration");
    let response = client
        .post(&url)
        .header("Lambda-Extension-Name", "circuitbreaker-lambda-extension")
        .json(&serde_json::json!({"events": ["INVOKE", "SHUTDOWN"]}))
        .send()
        .await?;

    let ext_id = response
        .headers()
        .get("Lambda-Extension-Identifier")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or("missing Lambda-Extension-Identifier header")?;

    Ok(ext_id)
}

/// Extension event loop — blocks waiting for INVOKE/SHUTDOWN events.
/// The Extensions API long-polls; Lambda freezes the process between invocations.
async fn extension_event_loop(ext_id: &str) {
    let runtime_api = match env::var("AWS_LAMBDA_RUNTIME_API") {
        Ok(api) => api,
        Err(_) => return,
    };
    let url = format!("http://{runtime_api}/2020-01-01/extension/event/next");

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("failed to build HTTP client for extension event loop");

    loop {
        let response = client
            .get(&url)
            .header("Lambda-Extension-Identifier", ext_id)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    if status.as_u16() == 404 || status.as_u16() == 410 {
                        error!(
                            source = "circuitbreaker-lambda",
                            action = "extension",
                            message = format!(
                                "Extensions API returned {status} — extension deregistered"
                            ),
                        );
                        break;
                    }
                    warn!(
                        source = "circuitbreaker-lambda",
                        action = "extension",
                        message = format!("Extensions API returned {status}, retrying"),
                    );
                    continue;
                }
                if let Ok(body) = resp.text().await {
                    if body.contains("SHUTDOWN") {
                        info!(
                            source = "circuitbreaker-lambda",
                            action = "shutdown",
                            message = "received SHUTDOWN event",
                        );
                        break;
                    }
                }
            }
            Err(e) => {
                warn!(
                    source = "circuitbreaker-lambda",
                    action = "extension",
                    error = %e,
                );
            }
        }
    }
}
