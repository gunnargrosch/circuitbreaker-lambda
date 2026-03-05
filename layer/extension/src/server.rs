use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tracing::{info, error};

use crate::circuit::CircuitManager;

/// Maximum allowed length for a circuit ID (DynamoDB partition key limit is 2048 bytes).
const MAX_CIRCUIT_ID_LEN: usize = 256;

pub async fn start_server(port: u16, manager: Arc<CircuitManager>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await?;

    info!(
        source = "circuitbreaker-lambda",
        action = "server",
        message = format!("listening on {addr}"),
    );

    // Signal readiness
    tokio::fs::write("/tmp/.circuitbreaker-lambda-ready", "").await?;

    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let manager = Arc::clone(&manager);

        tokio::spawn(async move {
            let svc = service_fn(|req: Request<Incoming>| {
                let manager = Arc::clone(&manager);
                async move {
                    Ok::<_, hyper::Error>(handle_request(req, manager).await)
                }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                let msg = e.to_string();
                if !msg.contains("connection reset") && !msg.contains("broken pipe") {
                    error!(
                        source = "circuitbreaker-lambda",
                        action = "server",
                        error = %e,
                    );
                }
            }
        });
    }
}

async fn handle_request(
    req: Request<Incoming>,
    manager: Arc<CircuitManager>,
) -> Response<Full<Bytes>> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if method == Method::GET && path == "/health" {
        return json_response(StatusCode::OK, r#"{"status":"ok"}"#);
    }

    let circuit_id = match parse_circuit_id(&path) {
        Some(id) => id,
        None => {
            return json_response(
                StatusCode::NOT_FOUND,
                r#"{"error":"not found — use /circuit/{id}"}"#,
            );
        }
    };

    if circuit_id.len() > MAX_CIRCUIT_ID_LEN {
        return json_response(
            StatusCode::BAD_REQUEST,
            r#"{"error":"circuit ID too long (max 256 characters)"}"#,
        );
    }

    if !is_valid_circuit_id(&circuit_id) {
        return json_response(
            StatusCode::BAD_REQUEST,
            r#"{"error":"circuit ID contains invalid characters"}"#,
        );
    }

    let sub_path = &path["/circuit/".len() + circuit_id.len()..];

    match (method, sub_path) {
        (Method::GET, "" | "/") => {
            let result = manager.check(&circuit_id).await;
            let body = serde_json::to_string(&result).unwrap_or_default();
            json_response(StatusCode::OK, &body)
        }
        (Method::POST, "/success") => {
            let result = manager.record_success(&circuit_id).await;
            let body = serde_json::to_string(&result).unwrap_or_default();
            json_response(StatusCode::OK, &body)
        }
        (Method::POST, "/failure") => {
            let result = manager.record_failure(&circuit_id).await;
            let body = serde_json::to_string(&result).unwrap_or_default();
            json_response(StatusCode::OK, &body)
        }
        _ => json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            r#"{"error":"method not allowed"}"#,
        ),
    }
}

fn parse_circuit_id(path: &str) -> Option<String> {
    let stripped = path.strip_prefix("/circuit/")?;
    let id = stripped.split('/').next()?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Allow alphanumeric, hyphens, underscores, dots, and colons.
fn is_valid_circuit_id(id: &str) -> bool {
    id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ':')
}

fn json_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}
