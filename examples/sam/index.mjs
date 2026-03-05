import { CircuitBreaker } from "circuitbreaker-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CIRCUITBREAKER_TABLE;
const CONTROL_KEY = "_downstream_healthy";

async function callDownstream() {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }),
  );
  const healthy = result.Item?.healthy ?? true;
  if (!healthy) {
    throw new Error("Downstream service unavailable");
  }
  return { data: "Response from downstream service" };
}

// No fallback — fire() throws when the circuit is OPEN, which we catch below.
const circuitBreaker = new CircuitBreaker(callDownstream, {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 15000,
});

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  if (method === "POST" && path.endsWith("/toggle")) {
    const current = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }),
    );
    const wasHealthy = current.Item?.healthy ?? true;
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id: CONTROL_KEY, healthy: !wasHealthy },
      }),
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ downstream: !wasHealthy ? "healthy" : "unhealthy" }),
    };
  }

  if (method === "GET" && path.endsWith("/status")) {
    const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    const circuitState = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: functionName } }),
    );
    const downstreamFlag = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }),
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        circuit: circuitState.Item ?? { state: "no data yet" },
        downstream: (downstreamFlag.Item?.healthy ?? true) ? "healthy" : "unhealthy",
      }),
    };
  }

  try {
    const result = await circuitBreaker.fire();
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result }),
    };
  } catch (err) {
    // Both downstream failures and "CircuitBreaker state: OPEN" land here
    const isOpen = err.message?.includes("CircuitBreaker state: OPEN");
    return {
      statusCode: isOpen ? 503 : 500,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
