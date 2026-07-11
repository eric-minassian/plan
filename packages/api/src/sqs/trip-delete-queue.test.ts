import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeInMemoryTripDeleteQueue,
  parseTripDeleteMessage,
  serializeTripDeleteMessage,
} from "./trip-delete-queue.js";

describe("trip-delete-queue", () => {
  it("serializes and parses message round-trip", () => {
    const msg = { tripId: "t1", ownerId: "o1" };
    const body = serializeTripDeleteMessage(msg);
    expect(JSON.parse(body)).toEqual(msg);
    expect(parseTripDeleteMessage(body)).toEqual(msg);
  });

  it("rejects invalid bodies", () => {
    expect(parseTripDeleteMessage("")).toBeUndefined();
    expect(parseTripDeleteMessage("{}")).toBeUndefined();
    expect(parseTripDeleteMessage('{"tripId":"t"}')).toBeUndefined();
    expect(parseTripDeleteMessage('{"ownerId":"o"}')).toBeUndefined();
    expect(parseTripDeleteMessage("not-json")).toBeUndefined();
  });

  it("in-memory queue records enqueued messages", async () => {
    const queue = makeInMemoryTripDeleteQueue();
    await Effect.runPromise(
      queue.enqueue({ tripId: "t1", ownerId: "o1" }),
    );
    await Effect.runPromise(
      queue.enqueue({ tripId: "t2", ownerId: "o1" }),
    );
    expect(queue.messages).toEqual([
      { tripId: "t1", ownerId: "o1" },
      { tripId: "t2", ownerId: "o1" },
    ]);
    queue.clear();
    expect(queue.messages).toHaveLength(0);
  });
});
