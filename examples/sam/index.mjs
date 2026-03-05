// =============================================================================
// Circuit breaker usage — this is the part you'd copy into your own code
// =============================================================================

import { CircuitBreaker } from "circuitbreaker-lambda";

// Wrap your unreliable downstream call with a circuit breaker.
// When the downstream fails repeatedly, the circuit opens and fire() throws
// "CircuitBreaker state: OPEN" instead of calling the downstream.
const circuitBreaker = new CircuitBreaker(callDownstream, {
  failureThreshold: 3,   // open after 3 failures
  successThreshold: 2,   // close after 2 successes in HALF state
  timeout: 15000,        // try again after 15s
});

export const handler = async (event) => {
  const path = event.rawPath ?? "/";

  // --- Test helpers (toggle/status) — see bottom of file ---
  if (path.endsWith("/toggle")) return handleToggle();
  if (path.endsWith("/status")) return handleStatus();

  // --- Circuit breaker in action ---
  try {
    const result = await circuitBreaker.fire();
    return respond(200, { success: true, result });
  } catch (err) {
    const isOpen = err.message?.includes("CircuitBreaker state: OPEN");
    return respond(isOpen ? 503 : 500, { success: false, error: err.message });
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
  const circuitId = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const circuit = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: circuitId } }));
  const downstream = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }));
  return respond(200, {
    circuit: circuit.Item ?? { state: "no data yet" },
    downstream: (downstream.Item?.healthy ?? true) ? "healthy" : "unhealthy",
  });
}

function respond(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}
