import { describe, expect, it, vi } from "vitest";
import { createReadinessGate, type ReadinessDeps } from "../../src/aao/readiness.js";

function setup(options: { loaded: string[]; listed?: boolean; directory?: string | null; wrapped?: boolean }) {
  const calls: string[] = [];
  let count = 3;
  const deps: ReadinessDeps = {
    getJson: vi.fn(async (path: string, query?: Record<string, string>) => {
      calls.push(query ? `${path}?directory=${query.directory}` : path);
      if (path.startsWith("/api/session/")) {
        return options.directory === null ? { data: {} } : { data: { location: { directory: options.directory ?? "/srv/workspace/app" } } };
      }
      if (path === "/api/debug/location") {
        const list = options.loaded.map((directory) => ({ directory }));
        return options.wrapped ? { data: list } : list;
      }
      count++;
      return { data: [] };
    }),
    getToolsListCount: () => count,
    waitForToolsList: vi.fn(async (after: number) => {
      calls.push(`wait>${after}`);
      return options.listed ?? true;
    }),
    sleep: vi.fn(async (ms: number) => void calls.push(`sleep:${ms}`)),
    timeoutMs: 10_000,
    marginMs: 1000,
  };
  return { gate: createReadinessGate(deps), calls, deps };
}

describe("aao/readiness", () => {
  it("does not wait when the location is already loaded", async () => {
    const { gate, calls } = setup({ loaded: ["/srv/workspace/app"] });
    await gate("ses_1");
    expect(calls).toEqual(["/api/session/ses_1", "/api/debug/location"]);
  });

  it("loads a cold location, waits for tools/list, then applies the margin", async () => {
    const { gate, calls } = setup({ loaded: ["/srv/workspace/other"], wrapped: true });
    await gate("ses_1");
    expect(calls).toEqual([
      "/api/session/ses_1",
      "/api/debug/location",
      "/api/mcp?directory=/srv/workspace/app",
      "wait>3",
      "sleep:1000",
    ]);
  });

  it("gives up after the timeout without the margin (prompt still goes out)", async () => {
    const { gate, calls } = setup({ loaded: [], listed: false });
    await gate("ses_1");
    expect(calls.at(-1)).toBe("wait>3");
  });

  it("caches the session directory", async () => {
    const { gate, calls } = setup({ loaded: ["/srv/workspace/app"] });
    await gate("ses_1");
    await gate("ses_1");
    expect(calls.filter((c) => c.startsWith("/api/session/"))).toHaveLength(1);
  });

  it("returns quietly when the session has no directory", async () => {
    const { gate, calls } = setup({ loaded: [], directory: null });
    await gate("ses_1");
    expect(calls).toEqual(["/api/session/ses_1"]);
  });
});
