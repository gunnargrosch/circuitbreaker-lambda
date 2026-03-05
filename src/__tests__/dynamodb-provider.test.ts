import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBProvider } from "../dynamodb-provider.js";
import { createInitialState } from "../types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

let provider: DynamoDBProvider;

beforeEach(() => {
  ddbMock.reset();
  provider = new DynamoDBProvider({
    tableName: "test-table",
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });
});

describe("DynamoDBProvider", () => {
  describe("getState", () => {
    it("should return state record when item exists", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          id: "my-circuit",
          circuitState: "OPEN",
          failureCount: 5,
          successCount: 0,
          nextAttempt: 1234567890,
          lastFailureTime: 1234567800,
          consecutiveOpens: 2,
          stateTimestamp: 1234567890,
          schemaVersion: 1,
        },
      });

      const result = await provider.getState("my-circuit");

      expect(result).toEqual({
        circuitState: "OPEN",
        failureCount: 5,
        successCount: 0,
        nextAttempt: 1234567890,
        lastFailureTime: 1234567800,
        consecutiveOpens: 2,
        stateTimestamp: 1234567890,
        schemaVersion: 1,
      });
    });

    it("should return undefined when item does not exist", async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await provider.getState("missing");
      expect(result).toBeUndefined();
    });

    it("should default missing fields for backwards compatibility", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          id: "old-circuit",
          circuitState: "CLOSED",
          failureCount: 2,
          successCount: 0,
          nextAttempt: 0,
          stateTimestamp: 100,
        },
      });

      const result = await provider.getState("old-circuit");

      expect(result?.lastFailureTime).toBe(0);
      expect(result?.consecutiveOpens).toBe(0);
      expect(result?.schemaVersion).toBe(1);
    });

    it("should wrap DynamoDB errors with context", async () => {
      ddbMock.on(GetCommand).rejects(new Error("access denied"));

      await expect(provider.getState("my-circuit")).rejects.toThrow(
        'DynamoDBProvider.getState failed for circuit "my-circuit"',
      );
    });
  });

  describe("saveState", () => {
    it("should send update command with all fields", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      const state = createInitialState();
      state.circuitState = "OPEN";
      state.failureCount = 5;

      await provider.saveState("my-circuit", state);

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        TableName: "test-table",
        Key: { id: "my-circuit" },
        ExpressionAttributeValues: {
          ":st": "OPEN",
          ":fc": 5,
          ":co": 0,
          ":sv": 1,
        },
      });
    });

    it("should wrap DynamoDB errors with context", async () => {
      ddbMock.on(UpdateCommand).rejects(new Error("throttled"));

      await expect(
        provider.saveState("my-circuit", createInitialState()),
      ).rejects.toThrow('DynamoDBProvider.saveState failed for circuit "my-circuit"');
    });
  });
});
