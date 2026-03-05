import json
import os
import time
import urllib.request

import boto3

ddb = boto3.resource("dynamodb")
TABLE_NAME = os.environ.get("CIRCUITBREAKER_TABLE", "circuitbreaker-table")
table = ddb.Table(TABLE_NAME)
CONTROL_KEY = "_downstream_healthy"
CIRCUITBREAKER_PORT = os.environ.get("CIRCUITBREAKER_PORT", "4243")
CIRCUITBREAKER_URL = f"http://127.0.0.1:{CIRCUITBREAKER_PORT}"
CIRCUIT_ID = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "default")

extension_ready = False


def wait_for_extension():
    for _ in range(100):
        if os.path.exists("/tmp/.circuitbreaker-lambda-ready"):
            return
        time.sleep(0.05)


def call_downstream():
    result = table.get_item(Key={"id": CONTROL_KEY})
    if not result.get("Item", {}).get("healthy", True):
        raise Exception("Downstream service unavailable")
    return {"data": "Response from downstream service"}


def handler(event, context):
    global extension_ready
    if not extension_ready:
        wait_for_extension()
        extension_ready = True

    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")

    if method == "POST" and path.endswith("/toggle"):
        result = table.get_item(Key={"id": CONTROL_KEY})
        was_healthy = result.get("Item", {}).get("healthy", True)
        table.put_item(Item={"id": CONTROL_KEY, "healthy": not was_healthy})
        return {
            "statusCode": 200,
            "body": json.dumps({"downstream": "healthy" if not was_healthy else "unhealthy"}),
        }

    if method == "GET" and path.endswith("/status"):
        circuit = table.get_item(Key={"id": CIRCUIT_ID}).get("Item", {"state": "no data yet"})
        downstream = table.get_item(Key={"id": CONTROL_KEY}).get("Item", {}).get("healthy", True)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "circuit": circuit,
                "downstream": "healthy" if downstream else "unhealthy",
            }, default=str),
        }

    try:
        with urllib.request.urlopen(f"{CIRCUITBREAKER_URL}/circuit/{CIRCUIT_ID}", timeout=5) as resp:
            check = json.loads(resp.read())
        if check.get("transition"):
            print(json.dumps({"source": "circuitbreaker-lambda", "level": "info", "action": "transition", "circuitId": CIRCUIT_ID, "transition": check["transition"]}))
    except Exception as e:
        return {"statusCode": 502, "body": json.dumps({"error": f"Extension unavailable: {e}"})}

    if not check["allowed"]:
        return {
            "statusCode": 503,
            "body": json.dumps({"success": False, "error": "Circuit OPEN", "state": check["state"]}),
        }

    try:
        result = call_downstream()
        try:
            with urllib.request.urlopen(urllib.request.Request(
                f"{CIRCUITBREAKER_URL}/circuit/{CIRCUIT_ID}/success", method="POST"), timeout=5) as resp:
                success_result = json.loads(resp.read())
                if success_result.get("transition"):
                    print(json.dumps({"source": "circuitbreaker-lambda", "level": "info", "action": "transition", "circuitId": CIRCUIT_ID, "transition": success_result["transition"]}))
        except Exception:
            pass
        return {
            "statusCode": 200,
            "body": json.dumps({"success": True, "result": result, "state": check["state"]}),
        }
    except Exception as e:
        fail_state = "UNKNOWN"
        try:
            with urllib.request.urlopen(urllib.request.Request(
                f"{CIRCUITBREAKER_URL}/circuit/{CIRCUIT_ID}/failure", method="POST"), timeout=5) as resp:
                fail_result = json.loads(resp.read())
                fail_state = fail_result.get("state", "UNKNOWN")
                if fail_result.get("transition"):
                    print(json.dumps({"source": "circuitbreaker-lambda", "level": "info", "action": "transition", "circuitId": CIRCUIT_ID, "transition": fail_result["transition"]}))
        except Exception:
            pass
        return {
            "statusCode": 500,
            "body": json.dumps({"success": False, "error": str(e), "state": fail_state}),
        }
