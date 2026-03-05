import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CircuitBreakerState, StateProvider } from "./types.js";

export interface DynamoDBProviderOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoDBProvider implements StateProvider {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoDBProviderOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async getState(circuitId: string): Promise<CircuitBreakerState | undefined> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { id: circuitId },
        }),
      );
      if (!result.Item) return undefined;
      return {
        circuitState: result.Item.circuitState ?? "CLOSED",
        failureCount: result.Item.failureCount ?? 0,
        successCount: result.Item.successCount ?? 0,
        nextAttempt: result.Item.nextAttempt ?? 0,
        lastFailureTime: result.Item.lastFailureTime ?? 0,
        consecutiveOpens: result.Item.consecutiveOpens ?? 0,
        stateTimestamp: result.Item.stateTimestamp ?? 0,
        schemaVersion: result.Item.schemaVersion ?? 1,
      };
    } catch (err) {
      throw new Error(`DynamoDBProvider.getState failed for circuit "${circuitId}"`, { cause: err });
    }
  }

  async saveState(circuitId: string, state: CircuitBreakerState): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { id: circuitId },
          UpdateExpression:
            "SET circuitState = :st, failureCount = :fc, successCount = :sc, nextAttempt = :na, lastFailureTime = :lf, consecutiveOpens = :co, stateTimestamp = :ts, schemaVersion = :sv",
          ExpressionAttributeValues: {
            ":st": state.circuitState,
            ":fc": state.failureCount,
            ":sc": state.successCount,
            ":na": state.nextAttempt,
            ":lf": state.lastFailureTime,
            ":co": state.consecutiveOpens,
            ":ts": state.stateTimestamp,
            ":sv": state.schemaVersion,
          },
        }),
      );
    } catch (err) {
      throw new Error(`DynamoDBProvider.saveState failed for circuit "${circuitId}"`, { cause: err });
    }
  }
}
