import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import { SummaryAggregator } from "../../../src/app/managers/summary-aggregation-manager.js";

function emitPartial(aggregator: SummaryAggregator, messageId: string, text: string): void {
  aggregator.processEvent({
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1 },
      },
    },
  } as unknown as Event);
  aggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `${messageId}-part`,
        sessionID: "session-1",
        messageID: messageId,
        type: "text",
        text,
        time: { start: 1 },
      },
    },
  } as unknown as Event);
}

describe("summary aggregator outbound hold", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a callback immediately when the hold is off", () => {
    const aggregator = new SummaryAggregator();
    const onPartial = vi.fn();
    aggregator.setSession("session-1");
    aggregator.setOnPartial(onPartial);

    emitPartial(aggregator, "message-1", "now");

    expect(onPartial).toHaveBeenCalledOnce();
  });

  it("drains deferred callbacks one at a time with a gap", async () => {
    vi.useFakeTimers();
    const aggregator = new SummaryAggregator();
    const texts: string[] = [];
    aggregator.setSession("session-1");
    aggregator.setOnPartial((_sessionId, _messageId, text) => {
      texts.push(text);
    });
    aggregator.holdOutbound();

    emitPartial(aggregator, "message-1", "first");
    emitPartial(aggregator, "message-2", "second");
    expect(texts).toEqual([]);

    const draining = aggregator.drainOutbound(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(texts).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(texts).toEqual(["first", "second"]);
    await draining;
    expect(aggregator.hasDeferredOutbound()).toBe(false);
  });

  it("delivers the dashboard's values during a hold while chat output stays held", async () => {
    const aggregator = new SummaryAggregator();
    const onPartial = vi.fn();
    const onTokens = vi.fn();
    const onSessionDiff = vi.fn();
    aggregator.setSession("session-1");
    aggregator.setOnPartial(onPartial);
    aggregator.setOnTokens(onTokens);
    aggregator.setOnSessionDiff(onSessionDiff);
    aggregator.holdOutbound();

    aggregator.processEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1 },
          tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    } as unknown as Event);
    emitPartial(aggregator, "message-1", "held");
    aggregator.processEvent({
      type: "session.diff",
      properties: {
        sessionID: "session-1",
        diff: [{ file: "src/a.ts", additions: 1, deletions: 0 }],
      },
    } as unknown as Event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onTokens).toHaveBeenCalled();
    expect(onSessionDiff).toHaveBeenCalledOnce();
    expect(onPartial).not.toHaveBeenCalled();
  });

  it("runs a queued task now when not held and after the drain when held", async () => {
    const aggregator = new SummaryAggregator();
    const task = vi.fn();

    await aggregator.runOutbound(task);
    expect(task).toHaveBeenCalledOnce();

    aggregator.holdOutbound();
    await aggregator.runOutbound(task);
    expect(task).toHaveBeenCalledOnce();

    await aggregator.drainOutbound(0);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
