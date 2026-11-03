import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyAaoSessionIdle,
  runAaoPromptGate,
  setAaoIdleListener,
  setAaoPromptGate,
  withAaoPromptGate,
} from "../../src/aao/hooks.js";

afterEach(() => {
  setAaoPromptGate(null);
  setAaoIdleListener(null);
});

function fakeClient() {
  const calls: string[] = [];
  const client = {
    session: {
      marker: "session-object",
      promptAsync: vi.fn(async function (this: { marker: string }, params: { sessionID: string }) {
        calls.push(`promptAsync:${params.sessionID}:${this.marker}`);
        return { data: { inboxID: "inbox_1" }, error: undefined };
      }),
      prompt: vi.fn(async (params: { sessionID: string }) => {
        calls.push(`prompt:${params.sessionID}`);
        return { data: "reply", error: undefined };
      }),
      command: vi.fn(async (params: { sessionID: string }) => {
        calls.push(`command:${params.sessionID}`);
        return { data: undefined, error: undefined };
      }),
      abort: vi.fn(async () => ({ data: true, error: undefined })),
    },
  };
  return { client, calls };
}

describe("aao/hooks", () => {
  it("runs the gate before every prompt entry point and keeps results and `this`", async () => {
    const { client, calls } = fakeClient();
    setAaoPromptGate(async (sessionId) => void calls.push(`gate:${sessionId}`));
    withAaoPromptGate(client);

    await expect(client.session.promptAsync({ sessionID: "s1" })).resolves.toEqual({
      data: { inboxID: "inbox_1" },
      error: undefined,
    });
    await client.session.prompt({ sessionID: "s2" });
    await client.session.command({ sessionID: "s3" });
    await client.session.abort();

    expect(calls).toEqual([
      "gate:s1",
      "promptAsync:s1:session-object",
      "gate:s2",
      "prompt:s2",
      "gate:s3",
      "command:s3",
    ]);
  });

  it("sends the prompt even when the gate fails", async () => {
    const { client, calls } = fakeClient();
    setAaoPromptGate(async () => {
      throw new Error("OpenCode down");
    });
    withAaoPromptGate(client);
    await client.session.prompt({ sessionID: "s1" });
    expect(calls).toEqual(["prompt:s1"]);
  });

  it("is a no-op without a gate or listener", async () => {
    await expect(runAaoPromptGate("s")).resolves.toBeUndefined();
    expect(() => notifyAaoSessionIdle("s", false)).not.toThrow();
  });

  it("forwards idle events and swallows listener errors", () => {
    const seen: [string, boolean][] = [];
    setAaoIdleListener((id, interrupted) => void seen.push([id, interrupted]));
    notifyAaoSessionIdle("s1", false);
    notifyAaoSessionIdle("s2", true);
    expect(seen).toEqual([
      ["s1", false],
      ["s2", true],
    ]);
    setAaoIdleListener(() => {
      throw new Error("boom");
    });
    expect(() => notifyAaoSessionIdle("s3", false)).not.toThrow();
  });
});
