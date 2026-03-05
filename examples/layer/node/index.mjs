// =============================================================================
// Circuit breaker usage via the Lambda Layer extension
//
// The extension runs a local HTTP sidecar. Three calls per request:
//   1. GET  /circuit/{id}          — check if the circuit allows the request
//   2. POST /circuit/{id}/success  — record a successful downstream call
//   3. POST /circuit/{id}/failure  — record a failed downstream call
// =============================================================================

const BREAKER = `http://127.0.0.1:${process.env.CIRCUITBREAKER_PORT || "4243"}`;
const CIRCUIT_ID = process.env.AWS_LAMBDA_FUNCTION_NAME || "default";

async function circuitCheck() {
  const resp = await fetch(`${BREAKER}/circuit/${CIRCUIT_ID}`, { signal: AbortSignal.timeout(5000) });
  return resp.json();
}

async function circuitRecord(outcome) {
  try {
    const resp = await fetch(`${BREAKER}/circuit/${CIRCUIT_ID}/${outcome}`, { method: "POST", signal: AbortSignal.timeout(5000) });
    const result = await resp.json();
    if (result.transition) {
      console.log(JSON.stringify({ source: "circuitbreaker-lambda", level: "info", action: "transition", circuitId: CIRCUIT_ID, transition: result.transition }));
    }
    return result;
  } catch { return { state: "UNKNOWN" }; }
}

export const handler = async (event) => {
  const path = event.rawPath ?? "/";

  // --- Test helpers (toggle/status) — see bottom of file ---
  if (path.endsWith("/toggle")) return handleToggle();
  if (path.endsWith("/status")) return handleStatus();

  // --- Circuit breaker in action ---
  let check;
  try {
    check = await circuitCheck();
    if (check.transition) {
      console.log(JSON.stringify({ source: "circuitbreaker-lambda", level: "info", action: "transition", circuitId: CIRCUIT_ID, transition: check.transition }));
    }
  } catch (err) {
    return respond(502, { error: `Extension unavailable: ${err.message}` });
  }

  if (!check.allowed) {
    return respond(503, { success: false, error: "Circuit OPEN", state: check.state });
  }

  try {
    const result = await callDownstream();
    await circuitRecord("success");
    return respond(200, { success: true, result, state: check.state });
  } catch (err) {
    const fail = await circuitRecord("failure");
    return respond(500, { success: false, error: err.message, state: fail.state });
  }
};

// =============================================================================
// Simulated downstream — reads a DynamoDB flag to decide success/failure.
// In a real app, this would be your actual downstream call.
// =============================================================================

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CIRCUITBREAKER_TABLE;
const CONTROL_KEY = "_downstream_healthy";

async function callDownstream() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }));
  if (!(Item?.healthy ?? true)) throw new Error("Downstream service unavailable");
  return { data: "Response from downstream service" };
}

// =============================================================================
// Test helpers — toggle downstream health and inspect circuit state.
// POST /toggle  — flip between healthy/unhealthy
// GET  /status  — show circuit breaker state and downstream health
// =============================================================================

async function handleToggle() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }));
  const nowHealthy = !(Item?.healthy ?? true);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { id: CONTROL_KEY, healthy: nowHealthy } }));
  return respond(200, { downstream: nowHealthy ? "healthy" : "unhealthy" });
}

async function handleStatus() {
  const circuit = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: CIRCUIT_ID } }));
  const downstream = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }));
  return respond(200, {
    circuit: circuit.Item ?? { state: "no data yet" },
    downstream: (downstream.Item?.healthy ?? true) ? "healthy" : "unhealthy",
  });
}

function respond(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}
