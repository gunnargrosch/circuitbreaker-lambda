# ==============================================================================
# Circuit breaker usage via the Lambda Layer extension
#
# The extension runs a local HTTP sidecar. Three calls per request:
#   1. GET  /circuit/{id}          — check if the circuit allows the request
#   2. POST /circuit/{id}/success  — record a successful downstream call
#   3. POST /circuit/{id}/failure  — record a failed downstream call
# ==============================================================================

import json
import os
import urllib.request

BREAKER = f"http://127.0.0.1:{os.environ.get('CIRCUITBREAKER_PORT', '4243')}"
CIRCUIT_ID = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "default")


def circuit_check():
    with urllib.request.urlopen(f"{BREAKER}/circuit/{CIRCUIT_ID}", timeout=5) as resp:
        return json.loads(resp.read())


def circuit_record(outcome):
    try:
        req = urllib.request.Request(f"{BREAKER}/circuit/{CIRCUIT_ID}/{outcome}", method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read())
            if result.get("transition"):
                print(json.dumps({"source": "circuitbreaker-lambda", "level": "info",
                                  "action": "transition", "circuitId": CIRCUIT_ID,
                                  "transition": result["transition"]}))
            return result
    except Exception:
        return {"state": "UNKNOWN"}


def handler(event, context):
    path = event.get("rawPath", "/")

    # --- Test helpers (toggle/status) — see bottom of file ---
    if path.endswith("/toggle"):
        return handle_toggle()
    if path.endswith("/status"):
        return handle_status()

    # --- Circuit breaker in action ---
    try:
        check = circuit_check()
        if check.get("transition"):
            print(json.dumps({"source": "circuitbreaker-lambda", "level": "info",
                              "action": "transition", "circuitId": CIRCUIT_ID,
                              "transition": check["transition"]}))
    except Exception as e:
        return respond(502, {"error": f"Extension unavailable: {e}"})

    if not check["allowed"]:
        return respond(503, {"success": False, "error": "Circuit OPEN", "state": check["state"]})

    try:
        result = call_downstream()
        circuit_record("success")
        return respond(200, {"success": True, "result": result, "state": check["state"]})
    except Exception as e:
        fail = circuit_record("failure")
        return respond(500, {"success": False, "error": str(e), "state": fail["state"]})


# ==============================================================================
# Simulated downstream — reads a DynamoDB flag to decide success/failure.
# In a real app, this would be your actual downstream call.
# ==============================================================================

import boto3

TABLE_NAME = os.environ.get("CIRCUITBREAKER_TABLE", "circuitbreaker-table")
table = boto3.resource("dynamodb").Table(TABLE_NAME)
CONTROL_KEY = "_downstream_healthy"


def call_downstream():
    item = table.get_item(Key={"id": CONTROL_KEY}).get("Item", {})
    if not item.get("healthy", True):
        raise Exception("Downstream service unavailable")
    return {"data": "Response from downstream service"}


# ==============================================================================
# Test helpers — toggle downstream health and inspect circuit state.
# POST /toggle  — flip between healthy/unhealthy
# GET  /status  — show circuit breaker state and downstream health
# ==============================================================================

def handle_toggle():
    item = table.get_item(Key={"id": CONTROL_KEY}).get("Item", {})
    now_healthy = not item.get("healthy", True)
    table.put_item(Item={"id": CONTROL_KEY, "healthy": now_healthy})
    return respond(200, {"downstream": "healthy" if now_healthy else "unhealthy"})


def handle_status():
    circuit = table.get_item(Key={"id": CIRCUIT_ID}).get("Item", {"state": "no data yet"})
    downstream = table.get_item(Key={"id": CONTROL_KEY}).get("Item", {}).get("healthy", True)
    return respond(200, {
        "circuit": circuit,
        "downstream": "healthy" if downstream else "unhealthy",
    })


def respond(status_code, body):
    return {"statusCode": status_code, "body": json.dumps(body, default=str)}
