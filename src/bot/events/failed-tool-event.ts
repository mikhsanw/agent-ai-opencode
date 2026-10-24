import type { Event } from "@opencode-ai/sdk/v2";
import type { ToolInfo } from "../../app/managers/summary-aggregation-manager.js";

/** The failure OpenCode reports for a call it stopped, built for a call it never reported ended. */
export function buildFailedToolEvent(tool: ToolInfo, now: number): Event {
  const start = "time" in tool.state && tool.state.time ? tool.state.time.start : now;
  return {
    id: `${tool.callId}:lost`,
    type: "message.part.updated",
    properties: {
      sessionID: tool.sessionId,
      part: {
        id: tool.callId,
        sessionID: tool.sessionId,
        messageID: tool.messageId,
        type: "tool",
        callID: tool.callId,
        tool: tool.tool,
        state: {
          status: "error",
          input: tool.input ?? {},
          error: "",
          ...(tool.metadata ? { metadata: tool.metadata } : {}),
          time: { start, end: now },
        },
      },
      time: now,
    },
  };
}
