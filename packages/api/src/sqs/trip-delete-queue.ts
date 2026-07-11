import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Context, Effect } from "effect";
import type { AppError } from "../errors/app-error.js";
import { internalFromCause } from "../errors/app-error.js";

/** SQS body for the trip-delete worker. */
export interface TripDeleteMessage {
  readonly tripId: string;
  readonly ownerId: string;
}

export interface TripDeleteQueueService {
  readonly enqueue: (
    message: TripDeleteMessage,
  ) => Effect.Effect<void, AppError>;
}

export class TripDeleteQueue extends Context.Tag("TripDeleteQueue")<
  TripDeleteQueue,
  TripDeleteQueueService
>() {}

export function parseTripDeleteMessage(
  body: string,
): TripDeleteMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const tripId = (raw as { tripId?: unknown }).tripId;
  const ownerId = (raw as { ownerId?: unknown }).ownerId;
  if (typeof tripId !== "string" || tripId.length === 0) {
    return undefined;
  }
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return undefined;
  }
  return { tripId, ownerId };
}

export function serializeTripDeleteMessage(
  message: TripDeleteMessage,
): string {
  return JSON.stringify({
    tripId: message.tripId,
    ownerId: message.ownerId,
  });
}

/** Real SQS enqueue used by the API Lambda when TRIP_DELETE_QUEUE_URL is set. */
export function makeSqsTripDeleteQueue(options: {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly region?: string;
}): TripDeleteQueueService {
  const client =
    options.client ??
    new SQSClient({
      region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
    });
  return {
    enqueue: (message) =>
      Effect.tryPromise({
        try: async () => {
          await client.send(
            new SendMessageCommand({
              QueueUrl: options.queueUrl,
              MessageBody: serializeTripDeleteMessage(message),
            }),
          );
        },
        catch: (cause) =>
          internalFromCause(cause, { component: "trip-delete-queue" }),
      }),
  };
}

/** In-memory queue for unit tests and local skeleton without SQS. */
export interface InMemoryTripDeleteQueue extends TripDeleteQueueService {
  readonly messages: TripDeleteMessage[];
  readonly clear: () => void;
}

export function makeInMemoryTripDeleteQueue(): InMemoryTripDeleteQueue {
  const messages: TripDeleteMessage[] = [];
  return {
    messages,
    clear: () => {
      messages.length = 0;
    },
    enqueue: (message) =>
      Effect.sync(() => {
        messages.push({ tripId: message.tripId, ownerId: message.ownerId });
      }),
  };
}
