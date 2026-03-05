import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CIRCUITBREAKER_TABLE;
const CONTROL_KEY = "_downstream_healthy";
const CIRCUITBREAKER_PORT = process.env.CIRCUITBREAKER_PORT || "4243";
const CIRCUITBREAKER_URL = `http://127.0.0.1:${CIRCUITBREAKER_PORT}`;
const CIRCUIT_ID = process.env.AWS_LAMBDA_FUNCTION_NAME || "default";

async function callDownstream() {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { id: CONTROL_KEY } }),
  );
  if (!(result.Item?.healthy ?? true)) {
    throw new Error("Downstream service unavailable");
  }
  return { data: "Response from downstream service" };
}

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
    const circuitState = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: CIRCUIT_ID } }),
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

  let allowed, state;
  try {
    const checkResp = await fetch(`${CIRCUITBREAKER_URL}/circuit/${CIRCUIT_ID}`, { signal: AbortSignal.timeout(5000) });
    const checkResult = await checkResp.json();
    ({ allowed, state } = checkResult);
    if (checkResult.transition) {
      console.log(JSON.stringify({ source: "circuitbreaker-lambda", level: "info", action: "transition", circuitId: CIRCUIT_ID, transition: checkResult.transition }));
    }
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: `Extension unavailable: ${err.message}` }) };
  }

  if (!allowed) {
    return {
      statusCode: 503,
      body: JSON.stringify({ success: false, error: "Circuit OPEN", state }),
    };
  }

  try {
    const result = await callDownstream();
    try {
      const successResp = await fetch(`${CIRCUITBREAKER_URL}/circuit/${CIRCUIT_ID}/success`, { method: "POST", signal: AbortSignal.timeout(5000) });
      const successResult = await successResp.json();
      if (successResult.transition) {
        console.log(JSON.stringify({ source: "circuitbreaker-lambda", level: "info", action: "transition", circuitId: CIRCUIT_ID, transition: successResult.transition }));
      }
    } catch {}
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result, state }),
    };
  } catch (err) {
    let failState = "UNKNOWN";
    try {
      const r = await fetch(`${CIRCUITBREAKER_URL}/circuit/${CIRCUIT_ID}/failure`, { method: "POST", signal: AbortSignal.timeout(5000) });
      const failResult = await r.json();
      failState = failResult.state;
      if (failResult.transition) {
        console.log(JSON.stringify({ source: "circuitbreaker-lambda", level: "info", action: "transition", circuitId: CIRCUIT_ID, transition: failResult.transition }));
      }
    } catch {}
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message, state: failState }),
    };
  }
};
